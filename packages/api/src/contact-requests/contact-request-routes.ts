// Contact requests (086).
//
//   POST /workspaces/:workspaceId/contact-requests                       create
//   GET  /workspaces/:workspaceId/contact-requests/:requestId            read
//   POST /workspaces/:workspaceId/contact-requests/:requestId/complete   recipient (in-app) / requester (email)
//   POST /workspaces/:workspaceId/contact-requests/:requestId/decline    recipient (in-app)
//   POST /workspaces/:workspaceId/contact-requests/:requestId/cancel     requester
//   GET  /workspaces/:workspaceId/contacts/:contactId/requests           status on the contact
//   GET  /me/contact-requests[?status=]                                  "Others": asked of me
//   GET  /me/contact-requests/sent[?status=]                             "Requests you sent"
//
// Registered inside the session + CSRF scope: a request names a person and
// what is being asked of them. Authorization happens inside the use cases,
// keyed on capabilities; no role appears here.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createContactRequest, getContactRequest, completeContactRequest,
  declineContactRequest, cancelContactRequest, listContactRequestsForContact,
  listMyReceivedContactRequests, listMySentContactRequests,
  type ContactRequestDependencies, type ContactRequestView, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});
const RequestParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  requestId: Type.String({ minLength: 1, maxLength: 64 }),
});
const ContactParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
});

const KindSchema = Type.Union([
  Type.Literal("signed-document"), Type.Literal("upload"), Type.Literal("preparation"),
]);
const StatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("completed"),
  Type.Literal("declined"), Type.Literal("cancelled"),
]);
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const Person = Type.Object({
  userId: Type.String(),
  displayName: Type.String(),
}, { additionalProperties: false });

const CreateBodySchema = Type.Object({
  kind: KindSchema,
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  message: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  /** Required for `preparation`, optional for `signed-document`, refused for `upload`. */
  documentId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
  /** ISO-8601, in the future. */
  dueAt: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
}, {
  title: "CreateContactRequest",
  additionalProperties: false,
  description: "Ask a contact for a signed copy, an upload, or (members only) a "
    + "document's preparation. Members receive it in-app with no email; anyone "
    + "else is emailed.",
});

const CompleteBodySchema = Type.Object({
  /** The uploaded document answering an upload or signed-document request. */
  documentId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
}, { title: "CompleteContactRequest", additionalProperties: false });

// A rejection must say why: the requester sees the reason in their
// Rejected list. Older rows may still hold none.
const DeclineBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { title: "DeclineContactRequest", additionalProperties: false });

const ListQuerySchema = Type.Object({
  status: Type.Optional(StatusSchema),
}, { additionalProperties: false });

const ContactRequestSchema = Type.Object({
  requestId: Type.String(),
  workspaceId: Type.String(),
  workspaceName: Type.String(),
  kind: KindSchema,
  status: StatusSchema,
  title: Type.String(),
  message: Nullable(Type.String()),
  documentId: Nullable(Type.String()),
  documentTitle: Nullable(Type.String()),
  dueAt: Nullable(Type.String({ format: "date-time" })),
  contact: Type.Object({
    contactId: Type.String(),
    name: Type.String(),
    email: Type.String(),
  }, { additionalProperties: false }),
  delivery: Type.Union([Type.Literal("in-app"), Type.Literal("email")]),
  recipient: Type.Union([Person, Type.Null()]),
  requestedBy: Person,
  responseDocumentId: Nullable(Type.String()),
  declineReason: Nullable(Type.String()),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  completedAt: Nullable(Type.String({ format: "date-time" })),
  declinedAt: Nullable(Type.String({ format: "date-time" })),
  cancelledAt: Nullable(Type.String({ format: "date-time" })),
}, {
  title: "ContactRequest",
  additionalProperties: false,
  description: "Something a workspace user asked of a contact. `delivery` is "
    + "`in-app` (a member; no email) or `email` (anyone else).",
});

const ContactRequestListSchema = Type.Object({
  items: Type.Array(ContactRequestSchema),
}, { title: "ContactRequestList", additionalProperties: false });

export interface ContactRequestRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly contactRequestDependencies: () => ContactRequestDependencies;
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

const iso = (value: number): string => new Date(value).toISOString();
const isoOrNull = (value: number | null): string | null => (value === null ? null : iso(value));

const present = (view: ContactRequestView) => ({
  ...view,
  dueAt: isoOrNull(view.dueAt),
  createdAt: iso(view.createdAt),
  updatedAt: iso(view.updatedAt),
  completedAt: isoOrNull(view.completedAt),
  declinedAt: isoOrNull(view.declinedAt),
  cancelledAt: isoOrNull(view.cancelledAt),
});

type Operation = "created" | "completed" | "declined" | "cancelled";

export function registerContactRequestRoutes(
  app: FastifyInstance,
  options: ContactRequestRouteOptions,
): void {
  const deps = options.contactRequestDependencies;

  /** IDs and outcomes only — never the title, message or contact details. */
  const record = (request: FastifyRequest, operation: Operation, fields: Record<string, unknown>) => {
    const event = `contact_request.${operation}`;
    request.log.info({ event, result: "success", ...fields }, event);
    options.metrics?.increment("contact_request_operations_total", {
      operation, result: "success", processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  app.post("/workspaces/:workspaceId/contact-requests", {
    schema: {
      params: WorkspaceParamsSchema,
      body: CreateBodySchema,
      response: { 201: ContactRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const body = request.body as Static<typeof CreateBodySchema>;
    const created = await createContactRequest(actor, workspaceId as WorkspaceId, {
      kind: body.kind,
      contactId: body.contactId,
      title: body.title,
      message: body.message ?? null,
      documentId: body.documentId ?? null,
      // An unparseable value arrives as NaN and is refused as "not in the future".
      dueAt: body.dueAt === undefined || body.dueAt === null ? null : Date.parse(body.dueAt),
    }, deps());
    record(request, "created", {
      workspaceId, requestId: created.requestId, kind: created.kind,
      delivery: created.delivery, actorUserId: actor.userId,
    });
    return reply.status(201).send(present(created));
  });

  app.get("/workspaces/:workspaceId/contact-requests/:requestId", {
    schema: { params: RequestParamsSchema, response: { 200: ContactRequestSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;
    const view = await getContactRequest(actor, workspaceId as WorkspaceId, requestId, deps());
    return reply.status(200).send(present(view));
  });

  app.post("/workspaces/:workspaceId/contact-requests/:requestId/complete", {
    schema: {
      params: RequestParamsSchema,
      body: CompleteBodySchema,
      response: { 200: ContactRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;
    const body = (request.body ?? {}) as Static<typeof CompleteBodySchema>;
    const view = await completeContactRequest(actor, workspaceId as WorkspaceId, requestId, {
      documentId: body.documentId ?? null,
    }, deps());
    record(request, "completed", { workspaceId, requestId, actorUserId: actor.userId });
    return reply.status(200).send(present(view));
  });

  app.post("/workspaces/:workspaceId/contact-requests/:requestId/decline", {
    schema: {
      params: RequestParamsSchema,
      body: DeclineBodySchema,
      response: { 200: ContactRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;
    const body = (request.body ?? {}) as Static<typeof DeclineBodySchema>;
    const view = await declineContactRequest(actor, workspaceId as WorkspaceId, requestId, {
      reason: body.reason ?? null,
    }, deps());
    record(request, "declined", { workspaceId, requestId, actorUserId: actor.userId });
    return reply.status(200).send(present(view));
  });

  app.post("/workspaces/:workspaceId/contact-requests/:requestId/cancel", {
    schema: { params: RequestParamsSchema, response: { 200: ContactRequestSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;
    const view = await cancelContactRequest(actor, workspaceId as WorkspaceId, requestId, deps());
    record(request, "cancelled", { workspaceId, requestId, actorUserId: actor.userId });
    return reply.status(200).send(present(view));
  });

  app.get("/workspaces/:workspaceId/contacts/:contactId/requests", {
    schema: { params: ContactParamsSchema, response: { 200: ContactRequestListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, contactId } = request.params as Static<typeof ContactParamsSchema>;
    const items = await listContactRequestsForContact(
      actor, workspaceId as WorkspaceId, contactId, deps());
    return reply.status(200).send({ items: items.map(present) });
  });

  app.get("/me/contact-requests", {
    schema: { querystring: ListQuerySchema, response: { 200: ContactRequestListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { status } = request.query as Static<typeof ListQuerySchema>;
    const items = await listMyReceivedContactRequests(
      actor.userId, deps(), status === undefined ? {} : { status });
    return reply.status(200).send({ items: items.map(present) });
  });

  app.get("/me/contact-requests/sent", {
    schema: { querystring: ListQuerySchema, response: { 200: ContactRequestListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { status } = request.query as Static<typeof ListQuerySchema>;
    const items = await listMySentContactRequests(
      actor.userId, deps(), status === undefined ? {} : { status });
    return reply.status(200).send({ items: items.map(present) });
  });
}
