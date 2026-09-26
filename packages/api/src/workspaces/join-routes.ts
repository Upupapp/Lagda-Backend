// Joining a workspace by a single-use join link, always approved (078).
//
//   Authenticated (inside the session + CSRF scope):
//     GET    /workspaces/:workspaceId/join-tickets
//     POST   /workspaces/:workspaceId/join-tickets
//     PATCH  /workspaces/:workspaceId/join-tickets/:ticketId          draft only
//     POST   /workspaces/:workspaceId/join-tickets/:ticketId/send     new link
//     POST   /workspaces/:workspaceId/join-tickets/:ticketId/withdraw link dies
//     GET    /workspaces/:workspaceId/join-requests?state=
//     POST   /workspaces/:workspaceId/join-requests/:requestId/approve
//     POST   /workspaces/:workspaceId/join-requests/:requestId/decline
//     PATCH  /workspaces/:workspaceId/members/:memberId/access
//     POST   /workspace-join/requests                                 uses the link
//   Public (no session):
//     POST   /workspace-join/preview
//
// The link token travels in a request BODY, never a URL the API would log.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listJoinTickets, createJoinTicket, updateJoinTicketDraft, sendJoinTicket, withdrawJoinTicket,
  previewJoinLink, submitJoinRequest, listJoinRequests, approveJoinRequest, declineJoinRequest,
  updateMemberAccess, policyById,
  JOIN_TICKET_LABEL_MAX_LENGTH, JOIN_REQUEST_REASON_MAX_LENGTH, MEMBER_ROLE_TITLE_MAX_LENGTH,
  type JoinTicketDependencies, type JoinRequestDependencies, type JoinTicketView,
  type RateLimitCheck, type SessionId, type UserId, type AuthenticatedActor,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

const Id = Type.String({ minLength: 1, maxLength: 64 });
const WorkspaceParams = Type.Object({ workspaceId: Id });
const TicketParams = Type.Object({ workspaceId: Id, ticketId: Id });
const RequestParams = Type.Object({ workspaceId: Id, requestId: Id });
const MemberParams = Type.Object({ workspaceId: Id, memberId: Id });

const TicketStateSchema = Type.Union([Type.Literal("draft"), Type.Literal("sent"), Type.Literal("withdrawn")]);
const RequestStateSchema = Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("declined")]);
const RoleSchema = Type.String();

export const JoinTicketSchema = Type.Object({
  ticketId: Type.String(),
  label: Type.String(),
  recipientEmail: Type.Union([Type.String(), Type.Null()]),
  state: TicketStateSchema,
  /** The live link, for Copy / QR; only while Sent. */
  linkUrl: Type.Union([Type.String(), Type.Null()]),
  sentAt: Type.Union([Type.Integer(), Type.Null()]),
  withdrawnAt: Type.Union([Type.Integer(), Type.Null()]),
  usedAt: Type.Union([Type.Integer(), Type.Null()]),
  request: Type.Union([Type.Null(), Type.Object({
    requestId: Type.String(), fullName: Type.String(), state: RequestStateSchema,
  }, { additionalProperties: false })]),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
}, { title: "WorkspaceJoinTicket", additionalProperties: false });

const TicketWriteSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: JOIN_TICKET_LABEL_MAX_LENGTH }),
  recipientEmail: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
}, { additionalProperties: false });

const SendSchema = Type.Object({ email: Type.Boolean() }, { additionalProperties: false });
const EmptySchema = Type.Object({}, { additionalProperties: false });

export const JoinRequestSchema = Type.Object({
  requestId: Type.String(),
  sourceKind: Type.Union([Type.Literal("ticket"), Type.Literal("invitation")]),
  ticketLabel: Type.Union([Type.String(), Type.Null()]),
  fullName: Type.String(),
  email: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  requestedRole: RoleSchema,
  state: RequestStateSchema,
  createdAt: Type.Integer(),
  decidedAt: Type.Union([Type.Integer(), Type.Null()]),
}, { title: "WorkspaceJoinRequest", additionalProperties: false });

const AccessSchema = Type.Object({
  roleTitle: Type.Optional(Type.Union([Type.String({ maxLength: MEMBER_ROLE_TITLE_MAX_LENGTH }), Type.Null()])),
  canRequestDocuments: Type.Optional(Type.Boolean()),
  canAssignSigners: Type.Optional(Type.Boolean()),
}, { title: "MemberAccess", additionalProperties: false });

const TokenSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });

const SubmitSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 100 }),
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Type.Optional(Type.Union([Type.String({ maxLength: JOIN_REQUEST_REASON_MAX_LENGTH }), Type.Null()])),
}, { additionalProperties: false });

const RequestListQuery = Type.Object({
  state: Type.Optional(RequestStateSchema),
}, { additionalProperties: false });

export interface JoinRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId; readonly sessionId: SessionId;
  } | null>;
  readonly tickets: () => JoinTicketDependencies;
  readonly requests: () => JoinRequestDependencies;
  /** The page a join link opens, built from configured origin only. */
  readonly linkUrl: (token: string) => string;
  readonly rateLimit?: RateLimitOptions;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({ error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." } });
}

async function limits(request: FastifyRequest, options: JoinRouteOptions, checks: readonly RateLimitCheck[]) {
  if (options.rateLimit !== undefined) await checkSemanticLimits(request, checks, options.rateLimit);
}

function present(view: JoinTicketView, linkUrl: (token: string) => string) {
  return {
    ticketId: view.ticketId, label: view.label, recipientEmail: view.recipientEmail, state: view.state,
    linkUrl: view.linkToken === null ? null : linkUrl(view.linkToken),
    sentAt: view.sentAt, withdrawnAt: view.withdrawnAt, usedAt: view.usedAt,
    request: view.request, createdAt: view.createdAt, updatedAt: view.updatedAt,
  };
}

export function registerJoinRoutes(app: FastifyInstance, options: JoinRouteOptions): void {
  const actorOf = async (request: FastifyRequest): Promise<AuthenticatedActor | null> => {
    const who = await options.authenticatedUser(request);
    return who === null ? null : { actorType: "user", userId: who.userId, sessionId: who.sessionId };
  };

  app.get("/workspaces/:workspaceId/join-tickets", {
    schema: { params: WorkspaceParams, response: { 200: Type.Object({ tickets: Type.Array(JoinTicketSchema) }) } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const tickets = await listJoinTickets(actor, workspaceId as WorkspaceId, options.tickets());
    return reply.status(200).send({ tickets: tickets.map(t => present(t, options.linkUrl)) });
  });

  app.post("/workspaces/:workspaceId/join-tickets", {
    schema: { params: WorkspaceParams, body: TicketWriteSchema, response: { 201: JoinTicketSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const body = request.body as Static<typeof TicketWriteSchema>;
    const ticket = await createJoinTicket(actor, workspaceId as WorkspaceId, {
      label: body.label, recipientEmail: body.recipientEmail ?? null,
    }, options.tickets());
    return reply.status(201).send(present(ticket, options.linkUrl));
  });

  app.patch("/workspaces/:workspaceId/join-tickets/:ticketId", {
    schema: { params: TicketParams, body: TicketWriteSchema, response: { 200: JoinTicketSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, ticketId } = request.params as Static<typeof TicketParams>;
    const body = request.body as Static<typeof TicketWriteSchema>;
    const ticket = await updateJoinTicketDraft(actor, workspaceId as WorkspaceId, ticketId, {
      label: body.label, recipientEmail: body.recipientEmail ?? null,
    }, options.tickets());
    return reply.status(200).send(present(ticket, options.linkUrl));
  });

  app.post("/workspaces/:workspaceId/join-tickets/:ticketId/send", {
    schema: { params: TicketParams, body: SendSchema, response: { 200: JoinTicketSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, ticketId } = request.params as Static<typeof TicketParams>;
    await limits(request, options, [{
      policy: policyById("workspace.join.send.user"), scope: { type: "user", userId: actor.userId },
    }]);
    const body = request.body as Static<typeof SendSchema>;
    const ticket = await sendJoinTicket(actor, workspaceId as WorkspaceId, ticketId, { email: body.email }, options.tickets());
    return reply.status(200).send(present(ticket, options.linkUrl));
  });

  app.post("/workspaces/:workspaceId/join-tickets/:ticketId/withdraw", {
    schema: { params: TicketParams, body: EmptySchema, response: { 200: JoinTicketSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, ticketId } = request.params as Static<typeof TicketParams>;
    const ticket = await withdrawJoinTicket(actor, workspaceId as WorkspaceId, ticketId, options.tickets());
    return reply.status(200).send(present(ticket, options.linkUrl));
  });

  app.get("/workspaces/:workspaceId/join-requests", {
    schema: {
      params: WorkspaceParams, querystring: RequestListQuery,
      response: { 200: Type.Object({ requests: Type.Array(JoinRequestSchema) }) },
    },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const { state } = request.query as Static<typeof RequestListQuery>;
    const requests = await listJoinRequests(actor, workspaceId as WorkspaceId, state ?? null, options.tickets());
    return reply.status(200).send({ requests });
  });

  app.post("/workspaces/:workspaceId/join-requests/:requestId/approve", {
    schema: {
      params: RequestParams, body: AccessSchema,
      response: { 200: Type.Object({ memberId: Type.String() }) },
    },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParams>;
    const body = request.body as Static<typeof AccessSchema>;
    const result = await approveJoinRequest(actor, workspaceId as WorkspaceId, requestId, body, options.tickets());
    return reply.status(200).send({ memberId: result.memberId });
  });

  app.post("/workspaces/:workspaceId/join-requests/:requestId/decline", {
    schema: {
      params: RequestParams, body: EmptySchema,
      response: { 200: Type.Object({ declined: Type.Literal(true) }) },
    },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParams>;
    const result = await declineJoinRequest(actor, workspaceId as WorkspaceId, requestId, options.tickets());
    return reply.status(200).send(result);
  });

  app.patch("/workspaces/:workspaceId/members/:memberId/access", {
    schema: {
      params: MemberParams, body: AccessSchema,
      response: { 200: Type.Object({ updated: Type.Literal(true) }) },
    },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, memberId } = request.params as Static<typeof MemberParams>;
    const body = request.body as Static<typeof AccessSchema>;
    const result = await updateMemberAccess(actor, workspaceId as WorkspaceId, memberId, body, options.tickets());
    return reply.status(200).send(result);
  });

  app.post("/workspace-join/requests", {
    schema: {
      body: SubmitSchema,
      response: {
        201: Type.Object({
          requestId: Type.String(), workspaceName: Type.String(), state: Type.Literal("pending"),
        }, { additionalProperties: false }),
      },
    },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    await limits(request, options, [{
      policy: policyById("workspace.join.request.user"), scope: { type: "user", userId: actor.userId },
    }]);
    const body = request.body as Static<typeof SubmitSchema>;
    const result = await submitJoinRequest(actor, body.token, {
      fullName: body.fullName, reason: body.reason ?? null,
    }, options.requests());
    return reply.status(201).send(result);
  });
}

/** Public: what the join page shows before sign-in. Creates and uses nothing. */
export function registerJoinPreviewRoute(app: FastifyInstance, options: JoinRouteOptions): void {
  app.post("/workspace-join/preview", {
    schema: {
      body: TokenSchema,
      response: {
        200: Type.Object({
          workspaceName: Type.String(), invitedByName: Type.Union([Type.String(), Type.Null()]),
        }, { title: "WorkspaceJoinPreview", additionalProperties: false }),
      },
    },
  }, async (request, reply) => {
    noStore(reply);
    const ipAddress = request.ip;
    if (typeof ipAddress === "string" && ipAddress !== "") {
      await limits(request, options, [{
        policy: policyById("workspace.join.preview.ip"), scope: { type: "ip", ipAddress },
      }]);
    }
    const { token } = request.body as Static<typeof TokenSchema>;
    const preview = await previewJoinLink(token, options.requests());
    return reply.status(200).send(preview);
  });
}
