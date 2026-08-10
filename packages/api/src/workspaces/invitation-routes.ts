// The workspace invitation surface.
//
// ── Two groups, and they are protected differently ─────────────────────────
//
//   MANAGEMENT — inside the authenticated scope, workspace-scoped paths.
//     POST   /workspaces/:workspaceId/invitations
//     GET    /workspaces/:workspaceId/invitations
//     POST   /workspaces/:workspaceId/invitations/:invitationId/resend
//     POST   /workspaces/:workspaceId/invitations/:invitationId/revoke
//
//   CREDENTIAL — the invitee's side. The workspace is resolved from the token,
//   never supplied by the caller.
//     POST   /invitations/preview   public; the recipient may have no account
//     POST   /invitations/accept    authenticated + CSRF
//     POST   /invitations/decline   authenticated + CSRF
//
// ── Why every credential route is a POST ───────────────────────────────────
//
// A GET would put the token in a URL, and therefore in access logs, referrer
// headers and browser history. It would also mean a mail security scanner —
// which fetches every link in a message before a human sees it — could consume
// an invitation by prefetching (§50, §51, §293). Preview is a read and is still
// a POST for exactly that reason.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createWorkspaceInvitation, listWorkspaceInvitations,
  resendWorkspaceInvitation, revokeWorkspaceInvitation,
  getWorkspaceInvitationPreview, acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
  assertValidKey, policyById,
  type InvitationDependencies, type AcceptInvitationDependencies,
  type RateLimitCheck, type SessionId, type UserId,
  MAX_EMAIL_LENGTH,
} from "@lagda/application";
import {
  InvitableWorkspaceRoleSchema, InvitationStateSchema,
  IDEMPOTENCY_KEY_HEADER,
  type WorkspaceId, type WorkspaceInvitationId,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Creating an invitation. **Two properties.**
 *
 * `additionalProperties: false` is the control. It is what makes
 * `{"email":"x","role":"member","owner":true}` a 422 rather than a silently
 * ignored field (§167).
 *
 * Deliberately absent: `workspaceId` (it is in the path), `inviterUserId`,
 * `createdBy`, `userId`, `token`, `accepted`, `acceptedAt`, `membershipId`,
 * `invitationId`, `expiresAt`.
 */
export const CreateInvitationRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: MAX_EMAIL_LENGTH }),
  /**
   * A CLOSED union that does not contain `owner`.
   *
   * Ownership is unexpressible rather than rejected: the literal is not in the
   * schema, so `{"role":"owner"}` fails validation before any handler runs, and
   * the database CHECK refuses it independently if it ever got that far.
   */
  role: InvitableWorkspaceRoleSchema,
}, { additionalProperties: false });

/**
 * Resend and revoke take NO body.
 *
 * The invitation id is in the path and the address and role are already on the
 * record. A body carrying an email would make "resend" able to silently retarget
 * an invitation at a different mailbox, which is a new invitation wearing an old
 * audit trail (§89, §123, §169, §170).
 */
export const EmptyBodySchema = Type.Object({}, { additionalProperties: false });

/**
 * The raw credential, in the BODY.
 *
 * Never a query parameter. Fastify logs `request.url`, proxies log it, and the
 * browser sends it as a referrer — a credential in a query string is a
 * credential in three places nobody audits (§49, §101).
 */
export const InvitationTokenRequestSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const InvitationParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  invitationId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * What a workspace manager sees.
 *
 * The invitee's email IS included: a manager is entitled to see who they
 * invited, and the pending-invitations table renders it. That entitlement does
 * not extend to logs or metrics — see INVITATION_DATA_CLASSIFICATION.md.
 *
 * Never present: the token, the digest, the inviter's account details, or any
 * delivery-provider state.
 */
export const InvitationSummarySchema = Type.Object({
  invitationId: Type.String(),
  email: Type.String(),
  role: InvitableWorkspaceRoleSchema,
  state: InvitationStateSchema,
  createdAt: Type.Integer(),
  expiresAt: Type.Integer(),
}, { additionalProperties: false });

export const InvitationListResponseSchema = Type.Object({
  invitations: Type.Array(InvitationSummarySchema),
}, { additionalProperties: false });

/**
 * What the holder of a live credential sees, before signing in.
 *
 * The workspace NAME is the one piece of tenant data here, and it is a
 * considered exception: the credential was deliberately given to this person by
 * someone authorized to give it, and an invitation page that cannot say which
 * workspace it is for is useless. Nothing else about the tenant appears.
 */
export const InvitationPreviewResponseSchema = Type.Object({
  workspaceName: Type.String(),
  role: InvitableWorkspaceRoleSchema,
  inviteeEmail: Type.String(),
  expiresAt: Type.Integer(),
}, { additionalProperties: false });

export const AcceptInvitationResponseSchema = Type.Object({
  workspaceId: Type.String(),
  workspaceName: Type.String(),
  role: InvitableWorkspaceRoleSchema,
  /** False when the membership already existed — a safe, convergent outcome. */
  joined: Type.Boolean(),
}, { additionalProperties: false });

export const DeclineInvitationResponseSchema = Type.Object({
  declined: Type.Literal(true),
}, { additionalProperties: false });

export type CreateInvitationRequest = Static<typeof CreateInvitationRequestSchema>;
export type InvitationTokenRequest = Static<typeof InvitationTokenRequestSchema>;

// ── Options ─────────────────────────────────────────────────────────────────

export interface InvitationRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly invitationDependencies: () => InvitationDependencies;
  readonly acceptDependencies: () => AcceptInvitationDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

/**
 * Invitation responses are never cacheable.
 *
 * A preview carries a workspace name and an email address; a management list
 * carries every pending invitee. A shared cache holding either is exactly the
 * failure to avoid (§312).
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

async function applyLimits(
  request: FastifyRequest,
  options: InvitationRouteOptions,
  checks: readonly RateLimitCheck[],
): Promise<void> {
  if (options.rateLimit === undefined) return;
  await checkSemanticLimits(request, checks, options.rateLimit);
}

// ── Management routes ───────────────────────────────────────────────────────
//
// Registered INSIDE the authenticated scope, so a session and CSRF are
// properties of where they live rather than of a flag each one sets.

export function registerInvitationManagementRoutes(
  app: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * Emits an invitation lifecycle event.
   *
   * IDs and outcomes. **Never the invitee's email address** and never the
   * token: an address is personal data, and routine operational logs are the
   * one place it has no business being (§204, §278).
   */
  const record = (
    request: FastifyRequest,
    event: "workspace.invitation.created" | "workspace.invitation.resent"
      | "workspace.invitation.revoked",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("workspace_invitation_operations_total", {
      operation: event.replace("workspace.invitation.", ""),
      result: "success",
      processRole: "api",
    });
  };

  // ── Create ────────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/invitations", {
    schema: {
      params: WorkspaceParamsSchema,
      body: CreateInvitationRequestSchema,
      response: { 201: InvitationSummarySchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;

    // TWO scopes, and both are needed. Per-user stops one compromised or
    // runaway account; per-workspace stops a team of colluding managers using
    // one tenant as a mail relay. Either alone leaves the other route open.
    await applyLimits(request, options, [
      {
        policy: policyById("workspace.invitation.create.user"),
        scope: { type: "user", userId: actor.userId },
      },
      {
        policy: policyById("workspace.invitation.create.workspace"),
        scope: { type: "workspace", workspaceId: workspaceId as WorkspaceId },
      },
    ]);

    // Required. The handoff named invitations retry-sensitive, and a double
    // submit would otherwise email the recipient twice and rotate a credential
    // the first email already delivered (§39).
    const key = assertValidKey(
      request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined);

    const body = request.body as CreateInvitationRequest;
    const created = await createWorkspaceInvitation({
      actor: { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId: workspaceId as WorkspaceId,
      email: body.email,
      // From the CLOSED schema union — AJV has already refused anything outside
      // it, and `owner` is not in it, so no cast is needed to reach the domain
      // type.
      role: body.role,
      idempotencyKey: key,
    }, options.invitationDependencies());

    record(request, "workspace.invitation.created", {
      workspaceId, invitationId: created.invitationId,
      actorUserId: actor.userId, role: created.role,
    });

    return reply.status(201).send(created);
  });

  // ── List ──────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/invitations", {
    schema: {
      params: WorkspaceParamsSchema,
      response: { 200: InvitationListResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const invitations = await listWorkspaceInvitations(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId,
      options.invitationDependencies(),
    );

    // No pagination. A team's pending-invitation list is bounded by how many
    // people one workspace is onboarding at once, and API_CONVENTIONS §5 already
    // reasoned that paginating a small list solves a volume problem nobody has
    // measured (§94).
    return reply.status(200).send({ invitations });
  });

  // ── Resend ────────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/invitations/:invitationId/resend", {
    schema: {
      params: InvitationParamsSchema,
      body: EmptyBodySchema,
      response: { 200: InvitationSummarySchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, invitationId } =
      request.params as Static<typeof InvitationParamsSchema>;

    // A SEPARATE and tighter policy than create. Resend is the email-bombing
    // primitive: one invitation, unlimited deliveries, no new record to notice
    // (§37).
    await applyLimits(request, options, [
      {
        policy: policyById("workspace.invitation.resend.user"),
        scope: { type: "user", userId: actor.userId },
      },
      {
        policy: policyById("workspace.invitation.resend.workspace"),
        scope: { type: "workspace", workspaceId: workspaceId as WorkspaceId },
      },
    ]);

    const key = assertValidKey(
      request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined);

    const resent = await resendWorkspaceInvitation({
      actor: { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId: workspaceId as WorkspaceId,
      invitationId: invitationId as WorkspaceInvitationId,
      idempotencyKey: key,
    }, options.invitationDependencies());

    record(request, "workspace.invitation.resent", {
      workspaceId, invitationId, actorUserId: actor.userId,
    });

    return reply.status(200).send(resent);
  });

  // ── Revoke ────────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/invitations/:invitationId/revoke", {
    schema: {
      params: InvitationParamsSchema,
      body: EmptyBodySchema,
      response: {
        200: Type.Object({
          invitationId: Type.String(),
          state: InvitationStateSchema,
        }, { additionalProperties: false }),
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, invitationId } =
      request.params as Static<typeof InvitationParamsSchema>;

    const result = await revokeWorkspaceInvitation(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId,
      invitationId as WorkspaceInvitationId,
      options.invitationDependencies(),
    );

    if (result.outcome === "revoked") {
      record(request, "workspace.invitation.revoked", {
        workspaceId, invitationId, actorUserId: actor.userId,
      });
      return reply.status(200).send({ invitationId, state: "revoked" as const });
    }

    // Not an error. Revoking an accepted invitation cannot undo a membership,
    // and revoking an expired one changes nothing — reporting the state is more
    // useful to the UI than a failure it would have to interpret (§86, §87).
    return reply.status(200).send({ invitationId, state: result.state });
  });
}

// ── Credential routes ───────────────────────────────────────────────────────

export interface InvitationCredentialRouteOptions extends InvitationRouteOptions {
  /**
   * True for the preview route only.
   *
   * Preview is public because the recipient may have no account yet and the
   * page must tell them what they are being invited to before asking them to
   * register (§185). Accept and decline are not: they need a `UserId`, and the
   * only trustworthy source of one is a validated session.
   */
  readonly publicPreview: true;
}

/**
 * The PUBLIC preview route. Registered outside the authenticated scope.
 *
 * Rate-limited by IP, which is the only scope available before authentication.
 * The token's entropy is the real protection; this bounds volume (§38, §186).
 */
export function registerInvitationPreviewRoute(
  app: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  app.post("/invitations/preview", {
    schema: {
      body: InvitationTokenRequestSchema,
      response: { 200: InvitationPreviewResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);

    const ipAddress = request.ip;
    if (typeof ipAddress === "string" && ipAddress !== "") {
      await applyLimits(request, options, [{
        policy: policyById("workspace.invitation.redeem.ip"),
        scope: { type: "ip", ipAddress },
      }]);
    }

    const body = request.body as InvitationTokenRequest;
    // Creates nothing and consumes nothing. A mail scanner that POSTed this
    // would learn a workspace name and change no state.
    const preview = await getWorkspaceInvitationPreview(
      body.token, options.acceptDependencies());

    return reply.status(200).send(preview);
  });
}

/**
 * Accept and decline. Registered INSIDE the authenticated scope.
 *
 * Both require a full session and CSRF because of where they live — the scope's
 * hook runs before either handler. A pre-auth MFA credential resolves no
 * session and is refused there, before any invitation is looked up (§68, §69,
 * §234, §265).
 */
export function registerInvitationRedemptionRoutes(
  app: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/invitations/accept", {
    schema: {
      body: InvitationTokenRequestSchema,
      response: { 200: AcceptInvitationResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const ipAddress = request.ip;
    if (typeof ipAddress === "string" && ipAddress !== "") {
      await applyLimits(request, options, [{
        policy: policyById("workspace.invitation.redeem.ip"),
        scope: { type: "ip", ipAddress },
      }]);
    }

    const body = request.body as InvitationTokenRequest;
    const result = await acceptWorkspaceInvitation(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      body.token,
      options.acceptDependencies(),
    );

    // The workspace and the role — both bounded — plus the outcome. Never the
    // token, never the invitee address (§206).
    request.log.info(
      {
        event: "workspace.invitation.accepted",
        workspaceId: result.workspaceId,
        actorUserId: actor.userId,
        role: result.role,
        joined: result.joined,
        result: "success",
      },
      "workspace.invitation.accepted",
    );
    metrics?.increment("workspace_invitation_operations_total", {
      operation: "accepted", result: result.joined ? "joined" : "already-member",
      processRole: "api",
    });

    // 200 whether or not this call created the membership. `joined` carries the
    // difference, and a convergent already-member outcome is a success, not a
    // conflict the client has to recover from (§165).
    return reply.status(200).send(result);
  });

  app.post("/invitations/decline", {
    schema: {
      body: InvitationTokenRequestSchema,
      response: { 200: DeclineInvitationResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const body = request.body as InvitationTokenRequest;
    const result = await declineWorkspaceInvitation(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      body.token,
      options.acceptDependencies(),
    );

    request.log.info(
      {
        event: "workspace.invitation.declined",
        actorUserId: actor.userId, result: "success",
      },
      "workspace.invitation.declined",
    );
    metrics?.increment("workspace_invitation_operations_total", {
      operation: "declined", result: "success", processRole: "api",
    });

    return reply.status(200).send(result);
  });
}
