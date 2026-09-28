// 089. The signed-in invitee's inbox.
//
//   GET  /me/invitations[?status=pending|declined|accepted]     (default pending)
//   POST /me/invitations/:invitationId/accept                   files the pending join request (078)
//   POST /me/invitations/:invitationId/decline                  {reason: 1–500} — required
//   POST /me/invitations/:invitationId/withdraw-decline         back to pending; 409 once expired/revoked
//   GET  /me/invitations/:invitationId/branding/logo            the inviting workspace's logo
//
// Matched by the account's VERIFIED normalized address: an unverified account
// is refused (403 `account_email_unverified`), an invitation addressed to
// anybody else is not found (404). Registered inside the session + CSRF scope.
// Logs and metrics carry ids and outcomes only — never an address or a reason.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listMyInvitations, acceptMyInvitation, declineMyInvitation, withdrawMyInvitationDecline,
  getMyInvitationLogo, INVITATION_DECLINE_REASON_MAX_LENGTH,
  type MyInvitationDependencies, type MyInvitationView, type SessionId, type UserId,
} from "@lagda/application";
import { InvitableWorkspaceRoleSchema } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";
import { AcceptInvitationResponseSchema } from "./invitation-routes.js";

// ── Schemas ───────────────────────────────────────────────────────────────

const Params = Type.Object({
  invitationId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const StatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("declined"), Type.Literal("accepted"),
]);

const ListQuery = Type.Object({ status: Type.Optional(StatusSchema) }, { additionalProperties: false });

/** Trimmed by the use case, which refuses an empty result (422). */
export const DeclineMyInvitationBody = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: INVITATION_DECLINE_REASON_MAX_LENGTH }),
}, { title: "DeclineMyInvitation", additionalProperties: false });

const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);

export const MyInvitationSchema = Type.Object({
  invitationId: Type.String(),
  workspaceId: Type.String(),
  workspaceName: Type.String(),
  role: InvitableWorkspaceRoleSchema,
  invitedBy: Type.Object({ displayName: Type.String() }, { additionalProperties: false }),
  status: StatusSchema,
  createdAt: DateTime,
  expiresAt: DateTime,
  declinedAt: Nullable(DateTime),
  declineReason: Nullable(Type.String()),
  branding: Type.Object({
    displayName: Type.String(),
    primaryColor: Nullable(Type.String()),
    logo: Type.Union([Type.Object({
      version: Type.String(),
      /** Relative to the API: the recipient-safe logo route for this invitation. */
      url: Type.String(),
    }, { additionalProperties: false }), Type.Null()]),
  }, { additionalProperties: false }),
}, {
  title: "MyInvitation",
  additionalProperties: false,
  description: "A workspace invitation addressed to this account's VERIFIED email address. "
    + "Carries the INVITING workspace's branding.",
});

const MyInvitationListSchema = Type.Object({
  items: Type.Array(MyInvitationSchema),
}, { title: "MyInvitationList", additionalProperties: false });

// ── Presentation ──────────────────────────────────────────────────────────

const iso = (value: number): string => new Date(value).toISOString();

/** The recipient-safe logo route for one invitation. */
export const invitationLogoPath = (invitationId: string, version: string): string =>
  `/me/invitations/${encodeURIComponent(invitationId)}/branding/logo?v=${encodeURIComponent(version)}`;

const present = (view: MyInvitationView) => ({
  ...view,
  createdAt: iso(view.createdAt),
  expiresAt: iso(view.expiresAt),
  declinedAt: view.declinedAt === null ? null : iso(view.declinedAt),
  branding: {
    ...view.branding,
    logo: view.branding.logo === null ? null
      : { version: view.branding.logo.version, url: invitationLogoPath(view.invitationId, view.branding.logo.version) },
  },
});

// ── Registration ──────────────────────────────────────────────────────────

export interface MyInvitationRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => MyInvitationDependencies;
  readonly metrics?: MetricsRecorder;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

export function registerMyInvitationRoutes(app: FastifyInstance, options: MyInvitationRouteOptions): void {
  const deps = options.dependencies;

  /** IDs and outcomes only — never an address or a reason. */
  const record = (
    request: FastifyRequest, operation: "accepted" | "declined" | "decline_withdrawn",
    fields: Record<string, unknown>,
  ) => {
    const event = `workspace.invitation.inbox_${operation}`;
    request.log.info({ event, result: "success", ...fields }, event);
    options.metrics?.increment("workspace_invitation_operations_total", {
      operation: `inbox_${operation}`, result: "success", processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  app.get("/me/invitations", {
    schema: { querystring: ListQuery, response: { 200: MyInvitationListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { status } = request.query as Static<typeof ListQuery>;
    const items = await listMyInvitations(actor.userId, status ?? "pending", deps());
    return reply.status(200).send({ items: items.map(present) });
  });

  // No body: the invitation is in the path and the caller comes from the session.
  app.post("/me/invitations/:invitationId/accept", {
    schema: { params: Params, response: { 200: AcceptInvitationResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { invitationId } = request.params as Static<typeof Params>;
    const result = await acceptMyInvitation(actor, invitationId, deps());
    record(request, "accepted", {
      invitationId, workspaceId: result.workspaceId, actorUserId: actor.userId, pending: result.pending,
    });
    return reply.status(200).send(result);
  });

  app.post("/me/invitations/:invitationId/decline", {
    schema: { params: Params, body: DeclineMyInvitationBody, response: { 200: MyInvitationSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { invitationId } = request.params as Static<typeof Params>;
    const body = request.body as Static<typeof DeclineMyInvitationBody>;
    const view = await declineMyInvitation(actor, invitationId, { reason: body.reason }, deps());
    record(request, "declined", { invitationId, workspaceId: view.workspaceId, actorUserId: actor.userId });
    return reply.status(200).send(present(view));
  });

  app.post("/me/invitations/:invitationId/withdraw-decline", {
    schema: { params: Params, response: { 200: MyInvitationSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { invitationId } = request.params as Static<typeof Params>;
    const view = await withdrawMyInvitationDecline(actor, invitationId, deps());
    record(request, "decline_withdrawn", { invitationId, workspaceId: view.workspaceId, actorUserId: actor.userId });
    return reply.status(200).send(present(view));
  });

  app.get("/me/invitations/:invitationId/branding/logo", {
    schema: { params: Params, response: { 404: Type.Object({}, { additionalProperties: true }) } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { invitationId } = request.params as Static<typeof Params>;
    const logo = await getMyInvitationLogo(actor.userId, invitationId, deps());
    if (logo === null) {
      noStore(reply);
      return reply.status(404).send({ error: { code: "LOGO_NOT_FOUND", message: "No logo is set." } });
    }
    // Private: it is served to one account, through one invitation.
    void reply.header("Cache-Control", "private, max-age=300");
    void reply.header("ETag", `"${logo.digest}"`);
    void reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(logo.mediaType).send(Buffer.from(logo.bytes));
  });
}
