// Documents this workspace has asked a member to supply (067).
//
//   GET     /workspaces/:workspaceId/upload-requests
//   POST    /workspaces/:workspaceId/upload-requests
//   POST    /workspaces/:workspaceId/upload-requests/:requestId/cancel
//   POST    /workspaces/:workspaceId/upload-requests/:requestId/fulfil
//
// ── Nested under the workspace, and that is a security property ────────────
//
// Not `/upload-requests?workspaceId=...`. The tenant is a PATH segment, so
// every route here has one and no handler can be written that forgets it.
//
// ── Cancel and fulfil are POSTs to sub-resources ───────────────────────────
//
// Neither is a PUT of the whole record, because neither is "set these
// fields": both are state transitions with their own preconditions, and the
// only legal source state is `pending`. A PUT would invite a client to send
// `status: "fulfilled"` with a document id of its choosing and expect it to
// be honoured.
//
// `DELETE` is likewise absent. Cancelling keeps the record — it is evidence
// that something was asked and withdrawn — so naming it DELETE would tell
// every client author the row is gone.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// Authorization happens inside the use case, against a membership row the
// server read, keyed on a capability.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createUploadRequest, listUploadRequests, cancelUploadRequest,
  fulfilUploadRequest,
  type UploadRequestDependencies, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId, DocumentId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const RequestParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  requestId: Type.String({ minLength: 1, maxLength: 64 }),
});

const UploadRequestStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("fulfilled"), Type.Literal("cancelled"),
]);

/**
 * Asking somebody for a document.
 *
 * `contactId`, not an email and not a user id. An email would be a second way
 * to address work at somebody, bypassing the address book the workspace
 * curates; a user id would make the caller do the contact-to-member
 * resolution the use case exists to perform (and to refuse).
 *
 * Deliberately absent: `assigneeUserId` (resolved from the contact),
 * `status` (a new request is always pending), `documentId` (there is no
 * document yet — that is the point), and every timestamp.
 */
const CreateUploadRequestBodySchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  note: Type.Optional(Type.String({ maxLength: 1000 })),
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

/** Answering a request with a document that has ALREADY been uploaded through
 *  the ordinary create-then-upload path. */
const FulfilUploadRequestBodySchema = Type.Object({
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const ListQuerySchema = Type.Object({
  /** Narrows to what is being asked of the CALLER — their own queue, which is
   *  where the notification sends them. */
  assignedToMe: Type.Optional(Type.Boolean()),
  status: Type.Optional(UploadRequestStatusSchema),
}, { additionalProperties: false });

const UploadRequestSchema = Type.Object({
  requestId: Type.String(),
  title: Type.String(),
  note: Type.Union([Type.String(), Type.Null()]),
  requestedByUserId: Type.String(),
  assigneeUserId: Type.String(),
  /** Which address-book entry the requester picked. Provenance only — never
   *  the authority on who may fulfil this. */
  assigneeContactId: Type.Union([Type.String(), Type.Null()]),
  status: UploadRequestStatusSchema,
  documentId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  fulfilledAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  cancelledAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
}, {
  title: "DocumentUploadRequest",
  additionalProperties: false,
  description:
    "A document this workspace has asked a member to supply. The assignee is "
    + "a workspace member, not a contact — fulfilling it writes into the "
    + "workspace, and workspace writes are authorized by membership.",
});

const UploadRequestListSchema = Type.Object({
  items: Type.Array(UploadRequestSchema),
}, { additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface UploadRequestRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly uploadRequestDependencies: () => UploadRequestDependencies;
  readonly metrics?: MetricsRecorder;
}

/** A request names a person and what is being asked of them. It does not
 *  belong in any cache a second party can read. */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

/** Timestamps leave as ISO-8601. The domain works in epoch milliseconds. */
const iso = (ms: number): string => new Date(ms).toISOString();

interface UploadRequestLike {
  readonly requestId: string;
  readonly title: string;
  readonly note: string | null;
  readonly requestedByUserId: string;
  readonly assigneeUserId: string;
  readonly assigneeContactId: string | null;
  readonly status: "pending" | "fulfilled" | "cancelled";
  readonly documentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fulfilledAt: number | null;
  readonly cancelledAt: number | null;
}

const present = (request: UploadRequestLike) => ({
  requestId: request.requestId,
  title: request.title,
  note: request.note,
  requestedByUserId: request.requestedByUserId,
  assigneeUserId: request.assigneeUserId,
  assigneeContactId: request.assigneeContactId,
  status: request.status,
  documentId: request.documentId,
  createdAt: iso(request.createdAt),
  updatedAt: iso(request.updatedAt),
  fulfilledAt: request.fulfilledAt === null ? null : iso(request.fulfilledAt),
  cancelledAt: request.cancelledAt === null ? null : iso(request.cancelledAt),
});

export function registerUploadRequestRoutes(
  app: FastifyInstance,
  options: UploadRequestRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * IDs and outcomes only.
   *
   * Never the title and never the note. Both are workspace-supplied prose
   * about a document that does not exist yet — "the 2026 audit letter for the
   * Reyes acquisition" names a deal, a party and a year. A log line is the
   * easiest place for that to end up somewhere nobody audited (§188).
   */
  const record = (
    request: FastifyRequest,
    event: "upload_request.created" | "upload_request.cancelled" | "upload_request.fulfilled",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("upload_request_operations_total", {
      operation: event.slice("upload_request.".length),
      result: "success",
      processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/upload-requests", {
    schema: {
      params: WorkspaceParamsSchema,
      querystring: ListQuerySchema,
      response: { 200: UploadRequestListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const query = request.query as Static<typeof ListQuerySchema>;

    const items = await listUploadRequests(
      actor, workspaceId as WorkspaceId,
      {
        ...(query.assignedToMe === undefined ? {} : { assignedToMe: query.assignedToMe }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      options.uploadRequestDependencies());

    return reply.status(200).send({ items: items.map(present) });
  });

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/upload-requests", {
    schema: {
      params: WorkspaceParamsSchema,
      body: CreateUploadRequestBodySchema,
      response: { 201: UploadRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const body = request.body as Static<typeof CreateUploadRequestBodySchema>;

    const created = await createUploadRequest(
      actor, workspaceId as WorkspaceId,
      {
        title: body.title,
        ...(body.note === undefined ? {} : { note: body.note }),
        contactId: body.contactId,
      },
      options.uploadRequestDependencies());

    record(request, "upload_request.created", {
      workspaceId, requestId: created.requestId, actorUserId: actor.userId,
    });

    return reply.status(201).send(present(created));
  });

  // ── Cancel ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/upload-requests/:requestId/cancel", {
    schema: {
      params: RequestParamsSchema,
      response: { 200: UploadRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;

    const cancelled = await cancelUploadRequest(
      actor, workspaceId as WorkspaceId, requestId,
      options.uploadRequestDependencies());

    record(request, "upload_request.cancelled", {
      workspaceId, requestId, actorUserId: actor.userId,
    });

    return reply.status(200).send(present(cancelled));
  });

  // ── Fulfil ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/upload-requests/:requestId/fulfil", {
    schema: {
      params: RequestParamsSchema,
      body: FulfilUploadRequestBodySchema,
      response: { 200: UploadRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, requestId } = request.params as Static<typeof RequestParamsSchema>;
    const body = request.body as Static<typeof FulfilUploadRequestBodySchema>;

    const fulfilled = await fulfilUploadRequest(
      actor, workspaceId as WorkspaceId, requestId,
      { documentId: body.documentId as DocumentId },
      options.uploadRequestDependencies());

    record(request, "upload_request.fulfilled", {
      workspaceId, requestId, actorUserId: actor.userId,
    });

    return reply.status(200).send(present(fulfilled));
  });
}
