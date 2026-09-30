// Document sharing (087).
//
// Owner side — the member who sent the signing request, or an owner/administrator:
//
//   GET    /workspaces/:workspaceId/documents/:documentId/shares[?status=]
//   POST   /workspaces/:workspaceId/documents/:documentId/shares              {email, fullName?}
//   PATCH  /workspaces/:workspaceId/documents/:documentId/shares/:shareId     {email?, fullName?}
//   DELETE /workspaces/:workspaceId/documents/:documentId/shares/:shareId     (share -> removed)
//   GET    /workspaces/:workspaceId/access-requests[?status=]
//   POST   /workspaces/:workspaceId/access-requests/:requestId/approve
//   POST   /workspaces/:workspaceId/access-requests/:requestId/reject
//   POST   /workspaces/:workspaceId/access-requests/:requestId/withdraw-rejection
//   POST   /workspaces/:workspaceId/access-requests/:requestId/remove        (approved -> removed)
//   DELETE /workspaces/:workspaceId/access-requests/:requestId               (rejected -> hidden)
//   GET    /workspaces/:workspaceId/shared-by-me[?scope=mine|workspace]
//
// Recipient side — any signed-in account, about its OWN shares and requests:
//
//   GET    /me/shared-documents[?status=accepted|pending|rejected]
//   GET    /me/shared-documents/:id
//   POST   /me/shared-documents/:id/accept | /reject | /withdraw-rejection | /remove-access
//   DELETE /me/shared-documents/:id                                          (rejected share -> hidden)
//   GET    /me/shared-documents/:id/details | /document | /branding/logo
//
// Requester side — a signed-in account holding a verification ID:
//
//   POST   /verifications/:verificationId/access-requests                   {note?}
//   GET    /verifications/:verificationId/my-access
//
// Registered inside the session + CSRF scope. Authorization lives in the use
// cases; no role appears here. Logs and metrics carry ids and outcomes only —
// never an address, a name, a note or a title.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import {
  listDocumentShares, createDocumentShare, updateDocumentShare, removeDocumentShare,
  listAccessRequests, approveAccessRequest, rejectAccessRequest, withdrawAccessRequestRejection,
  deleteAccessRequest, removeAccessRequestAccess, listSharedByMe,
  listSharedWithMe, getSharedWithMe, actOnSharedDocument, getSharedDocumentDetails,
  openSharedDocument, getSharedDocumentLogo, getMyDocumentAccess, requestDocumentAccess,
  policyById, MAX_EMAIL_LENGTH,
  type DocumentSharingDependencies, type DocumentShareView, type DocumentAccessRequestView,
  type SharedDocumentView, type CompletedDocumentSummary, type SharedByMeItem,
  type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

// ── Schemas ───────────────────────────────────────────────────────────────

const Id = Type.String({ minLength: 1, maxLength: 64 });
const WorkspaceParams = Type.Object({ workspaceId: Id }, { additionalProperties: false });
const DocumentParams = Type.Object({ workspaceId: Id, documentId: Id }, { additionalProperties: false });
const ShareParams = Type.Object({ workspaceId: Id, documentId: Id, shareId: Id }, { additionalProperties: false });
const RequestParams = Type.Object({ workspaceId: Id, requestId: Id }, { additionalProperties: false });
const ItemParams = Type.Object({ id: Id }, { additionalProperties: false });
const VerificationParams = Type.Object({ verificationId: Id }, { additionalProperties: false });

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
const DateTime = Type.String({ format: "date-time" });
const Person = Type.Object({ userId: Type.String(), displayName: Type.String() }, { additionalProperties: false });

const ShareStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("removed"),
]);
const RequestStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("removed"),
]);

const CompletedDocumentSchema = Type.Object({
  documentId: Type.String(),
  verificationId: Type.String(),
  documentTitle: Type.String(),
  completedAt: DateTime,
  owner: Person,
  participantCount: Type.Integer(),
}, { title: "SharedCompletedDocument", additionalProperties: false });

const DocumentShareSchema = Type.Object({
  shareId: Type.String(),
  documentId: Type.String(),
  verificationId: Type.String(),
  email: Type.String(),
  fullName: Nullable(Type.String()),
  status: ShareStatusSchema,
  recipient: Type.Union([Person, Type.Null()]),
  sharedBy: Person,
  removedBy: Type.Union([
    Type.Literal("owner"), Type.Literal("recipient"), Type.Literal("email-changed"), Type.Null(),
  ]),
  replacesShareId: Nullable(Type.String()),
  recipientDeleted: Type.Boolean(),
  createdAt: DateTime,
  updatedAt: DateTime,
  respondedAt: Nullable(DateTime),
  removedAt: Nullable(DateTime),
}, {
  title: "DocumentShare",
  additionalProperties: false,
  description: "A completed document shared with an email address. In-app only: nothing is "
    + "emailed, and the share appears to an account once its VERIFIED address matches.",
});

/** A participant of the completed document, as its signing request snapshotted them. */
const DocumentParticipantSchema = Type.Object({
  name: Type.String(),
  email: Type.String(),
  organization: Type.Union([Type.String(), Type.Null()]),
  role: Type.String(),
}, { additionalProperties: false });

const DocumentSharesSchema = Type.Object({
  document: CompletedDocumentSchema,
  shares: Type.Array(DocumentShareSchema),
  participants: Type.Array(DocumentParticipantSchema),
}, { title: "DocumentShares", additionalProperties: false });

const UpdatedShareSchema = Type.Object({
  share: DocumentShareSchema,
  previous: Type.Union([DocumentShareSchema, Type.Null()]),
}, {
  title: "UpdatedDocumentShare",
  additionalProperties: false,
  description: "`previous` is the share an address change ended (`removed` by `email-changed`); "
    + "`share` is then the NEW pending share for the new address.",
});

const CreateShareBody = Type.Object({
  email: Type.String({ minLength: 1, maxLength: MAX_EMAIL_LENGTH }),
  fullName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
}, { title: "CreateDocumentShare", additionalProperties: false });

const UpdateShareBody = Type.Object({
  email: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EMAIL_LENGTH })),
  fullName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
}, { title: "UpdateDocumentShare", additionalProperties: false });

const ShareListQuery = Type.Object({ status: Type.Optional(ShareStatusSchema) }, { additionalProperties: false });
const RequestListQuery = Type.Object({ status: Type.Optional(RequestStatusSchema) }, { additionalProperties: false });

const AccessRequestSchema = Type.Object({
  requestId: Type.String(),
  document: CompletedDocumentSchema,
  requester: Type.Object({
    userId: Type.String(), displayName: Type.String(), email: Type.String(),
  }, { additionalProperties: false }),
  note: Nullable(Type.String()),
  status: RequestStatusSchema,
  decidedBy: Type.Union([Person, Type.Null()]),
  decidedAt: Nullable(DateTime),
  removedAt: Nullable(DateTime),
  createdAt: DateTime,
  updatedAt: DateTime,
}, { title: "DocumentAccessRequest", additionalProperties: false });

const AccessRequestListSchema = Type.Object({
  items: Type.Array(AccessRequestSchema),
}, { title: "DocumentAccessRequestList", additionalProperties: false });

const SharedByMeQuery = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("mine"), Type.Literal("workspace")])),
}, { additionalProperties: false });

const SharedByMeSchema = Type.Object({
  items: Type.Array(Type.Object({
    document: CompletedDocumentSchema,
    acceptedShares: Type.Integer(),
    pendingShares: Type.Integer(),
    rejectedShares: Type.Integer(),
    approvedRequests: Type.Integer(),
    pendingRequests: Type.Integer(),
  }, { additionalProperties: false })),
}, {
  title: "SharedByMe",
  additionalProperties: false,
  description: "Completed documents with at least one accepted share or approved request.",
});

const SharedStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected"),
]);

const SharedDocumentSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("share"), Type.Literal("access-request")]),
  status: SharedStatusSchema,
  verificationId: Type.String(),
  documentTitle: Type.String(),
  completedAt: DateTime,
  owner: Type.Object({ displayName: Type.String() }, { additionalProperties: false }),
  sharedBy: Type.Union([
    Type.Object({ displayName: Type.String() }, { additionalProperties: false }), Type.Null(),
  ]),
  fullName: Nullable(Type.String()),
  email: Type.String(),
  note: Nullable(Type.String()),
  progress: Type.Object({
    participants: Type.Integer(), completed: Type.Integer(),
  }, { additionalProperties: false }),
  branding: Type.Object({
    displayName: Type.String(),
    primaryColor: Nullable(Type.String()),
    logo: Type.Union([Type.Object({
      version: Type.String(),
      width: Type.Integer(),
      height: Type.Integer(),
      /** Relative to the API: the recipient-safe logo route for this item. */
      url: Type.String(),
    }, { additionalProperties: false }), Type.Null()]),
  }, { additionalProperties: false }),
  actions: Type.Array(Type.Union([
    Type.Literal("accept"), Type.Literal("reject"), Type.Literal("withdraw-rejection"),
    Type.Literal("delete"), Type.Literal("remove-access"), Type.Literal("open"),
  ])),
  createdAt: DateTime,
  updatedAt: DateTime,
  respondedAt: Nullable(DateTime),
}, {
  title: "SharedDocument",
  additionalProperties: false,
  description: "A completed document shared with this account, or one it asked for. Carries the "
    + "OWNER workspace's branding; `actions` are what this account may do with it now.",
});

const SharedDocumentListSchema = Type.Object({
  items: Type.Array(SharedDocumentSchema),
}, { title: "SharedDocumentList", additionalProperties: false });

const SharedListQuery = Type.Object({ status: Type.Optional(SharedStatusSchema) }, { additionalProperties: false });

const DetailsSchema = Type.Object({
  details: Type.Object({
    documentTitle: Type.String(),
    completedAt: Type.Number(),
    sealedDigest: Type.String(),
    participants: Type.Array(Type.Object({
      name: Type.String(),
      maskedEmail: Type.String(),
      recipientType: Type.String(),
      status: Type.Union([
        Type.Literal("signed"), Type.Literal("approved"), Type.Literal("declined"),
        Type.Literal("skipped"), Type.Literal("viewed"), Type.Literal("no-action"),
      ]),
      actedAt: Type.Union([Type.Number(), Type.Null()]),
      routingOrder: Type.Integer(),
    }, { additionalProperties: false })),
    events: Type.Array(Type.Object({
      type: Type.String(), label: Type.String(), at: Type.Number(),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { title: "SharedDocumentDetails", additionalProperties: false });

const AccessRequestBody = Type.Object({
  note: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
}, { title: "CreateDocumentAccessRequest", additionalProperties: false });

const MyAccessRequestSchema = Type.Object({
  requestId: Type.String(),
  verificationId: Type.String(),
  documentTitle: Type.String(),
  status: RequestStatusSchema,
  note: Nullable(Type.String()),
  createdAt: DateTime,
}, { title: "MyDocumentAccessRequest", additionalProperties: false });

const MyAccessSchema = Type.Object({
  verificationId: Type.String(),
  relation: Type.Union([
    Type.Literal("owner"), Type.Literal("admin"), Type.Literal("participant"),
    Type.Literal("shared-accepted"), Type.Literal("shared-pending"), Type.Literal("shared-rejected"),
    Type.Literal("request-pending"), Type.Literal("request-rejected"), Type.Literal("none"),
  ]),
  shareId: Nullable(Type.String()),
  requestId: Nullable(Type.String()),
  canRequestAccess: Type.Boolean(),
}, {
  title: "MyDocumentAccess",
  additionalProperties: false,
  description: "The signed-in caller's OWN relation to a completed document. Says nothing about "
    + "anyone else; an unknown reference is `none`.",
});

const NoContent = Type.Null();

// ── Presentation ──────────────────────────────────────────────────────────

const iso = (value: number): string => new Date(value).toISOString();
const isoOrNull = (value: number | null): string | null => (value === null ? null : iso(value));

const presentDocument = (document: CompletedDocumentSummary) => ({
  ...document, completedAt: iso(document.completedAt),
});

const presentShare = (share: DocumentShareView) => ({
  ...share,
  createdAt: iso(share.createdAt),
  updatedAt: iso(share.updatedAt),
  respondedAt: isoOrNull(share.respondedAt),
  removedAt: isoOrNull(share.removedAt),
});

const presentRequest = (request: DocumentAccessRequestView) => ({
  ...request,
  document: presentDocument(request.document),
  decidedAt: isoOrNull(request.decidedAt),
  removedAt: isoOrNull(request.removedAt),
  createdAt: iso(request.createdAt),
  updatedAt: iso(request.updatedAt),
});

const presentSharedByMe = (item: SharedByMeItem) => ({ ...item, document: presentDocument(item.document) });

/** The recipient-safe logo route for one shared item. */
export const sharedLogoPath = (id: string, version: string): string =>
  `/me/shared-documents/${encodeURIComponent(id)}/branding/logo?v=${encodeURIComponent(version)}`;

const presentShared = (view: SharedDocumentView) => ({
  ...view,
  completedAt: iso(view.completedAt),
  createdAt: iso(view.createdAt),
  updatedAt: iso(view.updatedAt),
  respondedAt: isoOrNull(view.respondedAt),
  branding: {
    ...view.branding,
    logo: view.branding.logo === null ? null
      : { ...view.branding.logo, url: sharedLogoPath(view.id, view.branding.logo.version) },
  },
});

// ── Registration ──────────────────────────────────────────────────────────

export interface DocumentSharingRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => DocumentSharingDependencies;
  readonly metrics?: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
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

type Operation =
  | "share_created" | "share_updated" | "share_removed"
  | "request_approved" | "request_rejected" | "request_rejection_withdrawn"
  | "request_deleted" | "request_access_removed"
  | "share_accepted" | "share_rejected" | "share_rejection_withdrawn" | "share_deleted"
  | "access_removed" | "access_requested";

export function registerDocumentSharingRoutes(
  app: FastifyInstance,
  options: DocumentSharingRouteOptions,
): void {
  const deps = options.dependencies;

  /** IDs and outcomes only — never an address, a name, a note or a title. */
  const record = (request: FastifyRequest, operation: Operation, fields: Record<string, unknown>) => {
    const event = `document_sharing.${operation}`;
    request.log.info({ event, result: "success", ...fields }, event);
    options.metrics?.increment("document_sharing_operations_total", {
      operation, result: "success", processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  const userLimit = async (request: FastifyRequest, userId: UserId) => {
    if (options.rateLimit === undefined) return;
    await checkSemanticLimits(request, [{
      policy: policyById("verification.member-access.user"),
      scope: { type: "user", userId },
    }], options.rateLimit);
  };

  // ── Owner: shares ───────────────────────────────────────────────────────

  app.get("/workspaces/:workspaceId/documents/:documentId/shares", {
    schema: { params: DocumentParams, querystring: ShareListQuery, response: { 200: DocumentSharesSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, documentId } = request.params as Static<typeof DocumentParams>;
    const { status } = request.query as Static<typeof ShareListQuery>;
    const view = await listDocumentShares(actor, workspaceId as WorkspaceId, documentId, deps(),
      status === undefined ? {} : { status });
    return reply.status(200).send({
      document: presentDocument(view.document),
      shares: view.shares.map(presentShare),
      // Field by field: the schema is closed.
      participants: view.participants.map(p => ({ name: p.name, email: p.email, organization: p.organization, role: p.role })),
    });
  });

  app.post("/workspaces/:workspaceId/documents/:documentId/shares", {
    schema: { params: DocumentParams, body: CreateShareBody, response: { 201: DocumentShareSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, documentId } = request.params as Static<typeof DocumentParams>;
    const body = request.body as Static<typeof CreateShareBody>;
    const share = await createDocumentShare(actor, workspaceId as WorkspaceId, documentId, {
      email: body.email, fullName: body.fullName ?? null,
    }, deps());
    record(request, "share_created", { workspaceId, documentId, shareId: share.shareId, actorUserId: actor.userId });
    return reply.status(201).send(presentShare(share));
  });

  app.patch("/workspaces/:workspaceId/documents/:documentId/shares/:shareId", {
    schema: { params: ShareParams, body: UpdateShareBody, response: { 200: UpdatedShareSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, documentId, shareId } = request.params as Static<typeof ShareParams>;
    const body = request.body as Static<typeof UpdateShareBody>;
    const updated = await updateDocumentShare(actor, workspaceId as WorkspaceId, documentId, shareId, {
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
    }, deps());
    record(request, "share_updated", {
      workspaceId, documentId, shareId, newShareId: updated.share.shareId, actorUserId: actor.userId,
    });
    return reply.status(200).send({
      share: presentShare(updated.share),
      previous: updated.previous === null ? null : presentShare(updated.previous),
    });
  });

  app.delete("/workspaces/:workspaceId/documents/:documentId/shares/:shareId", {
    schema: { params: ShareParams, response: { 200: DocumentShareSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, documentId, shareId } = request.params as Static<typeof ShareParams>;
    const share = await removeDocumentShare(actor, workspaceId as WorkspaceId, documentId, shareId, deps());
    record(request, "share_removed", { workspaceId, documentId, shareId, actorUserId: actor.userId });
    return reply.status(200).send(presentShare(share));
  });

  // ── Owner: access requests ──────────────────────────────────────────────

  app.get("/workspaces/:workspaceId/access-requests", {
    schema: { params: WorkspaceParams, querystring: RequestListQuery, response: { 200: AccessRequestListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const { status } = request.query as Static<typeof RequestListQuery>;
    const items = await listAccessRequests(actor, workspaceId as WorkspaceId,
      status === undefined ? {} : { status }, deps());
    return reply.status(200).send({ items: items.map(presentRequest) });
  });

  const decisions = [
    ["approve", approveAccessRequest, "request_approved"],
    ["reject", rejectAccessRequest, "request_rejected"],
    ["withdraw-rejection", withdrawAccessRequestRejection, "request_rejection_withdrawn"],
    ["remove", removeAccessRequestAccess, "request_access_removed"],
  ] as const;
  for (const [verb, decide, operation] of decisions) {
    app.post(`/workspaces/:workspaceId/access-requests/:requestId/${verb}`, {
      schema: { params: RequestParams, response: { 200: AccessRequestSchema } },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      noStore(reply);
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);
      const { workspaceId, requestId } = request.params as Static<typeof RequestParams>;
      const view = await decide(actor, workspaceId as WorkspaceId, requestId, deps());
      record(request, operation, { workspaceId, requestId, actorUserId: actor.userId });
      return reply.status(200).send(presentRequest(view));
    });
  }

  app.delete("/workspaces/:workspaceId/access-requests/:requestId", {
    schema: { params: RequestParams, response: { 204: NoContent } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, requestId } = request.params as Static<typeof RequestParams>;
    await deleteAccessRequest(actor, workspaceId as WorkspaceId, requestId, deps());
    record(request, "request_deleted", { workspaceId, requestId, actorUserId: actor.userId });
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/shared-by-me", {
    schema: { params: WorkspaceParams, querystring: SharedByMeQuery, response: { 200: SharedByMeSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const { scope } = request.query as Static<typeof SharedByMeQuery>;
    const items = await listSharedByMe(actor, workspaceId as WorkspaceId,
      scope === undefined ? {} : { scope }, deps());
    return reply.status(200).send({ items: items.map(presentSharedByMe) });
  });

  // ── Recipient ───────────────────────────────────────────────────────────

  app.get("/me/shared-documents", {
    schema: { querystring: SharedListQuery, response: { 200: SharedDocumentListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { status } = request.query as Static<typeof SharedListQuery>;
    const items = await listSharedWithMe(actor.userId, status ?? "accepted", deps());
    return reply.status(200).send({ items: items.map(presentShared) });
  });

  app.get("/me/shared-documents/:id", {
    schema: { params: ItemParams, response: { 200: SharedDocumentSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    return reply.status(200).send(presentShared(await getSharedWithMe(actor.userId, id, deps())));
  });

  const recipientActions = [
    ["accept", "share_accepted"],
    ["reject", "share_rejected"],
    ["withdraw-rejection", "share_rejection_withdrawn"],
  ] as const;
  for (const [verb, operation] of recipientActions) {
    app.post(`/me/shared-documents/:id/${verb}`, {
      schema: { params: ItemParams, response: { 200: SharedDocumentSchema } },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      noStore(reply);
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);
      const { id } = request.params as Static<typeof ItemParams>;
      const view = await actOnSharedDocument(actor.userId, id, verb, deps());
      record(request, operation, { itemId: id, actorUserId: actor.userId });
      if (view === null) return reply.status(404).send({
        error: { code: "resource_not_found", message: "SharedDocument was not found." },
      });
      return reply.status(200).send(presentShared(view));
    });
  }

  app.post("/me/shared-documents/:id/remove-access", {
    schema: { params: ItemParams, response: { 204: NoContent } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    await actOnSharedDocument(actor.userId, id, "remove-access", deps());
    record(request, "access_removed", { itemId: id, actorUserId: actor.userId });
    return reply.status(204).send();
  });

  app.delete("/me/shared-documents/:id", {
    schema: { params: ItemParams, response: { 204: NoContent } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    await actOnSharedDocument(actor.userId, id, "delete", deps());
    record(request, "share_deleted", { itemId: id, actorUserId: actor.userId });
    return reply.status(204).send();
  });

  app.get("/me/shared-documents/:id/details", {
    schema: { params: ItemParams, response: { 200: DetailsSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    const details = await getSharedDocumentDetails(actor.userId, id, deps());
    return reply.status(200).send({ details });
  });

  app.get("/me/shared-documents/:id/document", {
    schema: { params: ItemParams, response: { 401: Type.Object({}, { additionalProperties: true }) } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    const document = await openSharedDocument(actor.userId, id, deps());
    void reply.header("Content-Type", document.mediaType);
    void reply.header("Content-Length", String(document.sizeBytes));
    void reply.header("Content-Disposition", "inline");
    void reply.header("Accept-Ranges", "none");
    return reply.status(200).send(Readable.from(document.stream));
  });

  app.get("/me/shared-documents/:id/branding/logo", {
    schema: { params: ItemParams, response: { 404: Type.Object({}, { additionalProperties: true }) } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { id } = request.params as Static<typeof ItemParams>;
    const logo = await getSharedDocumentLogo(actor.userId, id, deps());
    if (logo === null) {
      noStore(reply);
      return reply.status(404).send({ error: { code: "LOGO_NOT_FOUND", message: "No logo is set." } });
    }
    // Private: it is served to one account, through one share.
    void reply.header("Cache-Control", "private, max-age=300");
    void reply.header("ETag", `"${logo.digest}"`);
    void reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(logo.mediaType).send(Buffer.from(logo.bytes));
  });

  // ── Requester ───────────────────────────────────────────────────────────

  app.post("/verifications/:verificationId/access-requests", {
    schema: { params: VerificationParams, body: AccessRequestBody, response: { 201: MyAccessRequestSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    await userLimit(request, actor.userId);
    const { verificationId } = request.params as Static<typeof VerificationParams>;
    const body = (request.body ?? {}) as Static<typeof AccessRequestBody>;
    const created = await requestDocumentAccess(actor.userId, verificationId, { note: body.note ?? null }, deps());
    record(request, "access_requested", { requestId: created.requestId, actorUserId: actor.userId });
    return reply.status(201).send({ ...created, createdAt: iso(created.createdAt) });
  });

  app.get("/verifications/:verificationId/my-access", {
    schema: { params: VerificationParams, response: { 200: MyAccessSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    await userLimit(request, actor.userId);
    const { verificationId } = request.params as Static<typeof VerificationParams>;
    return reply.status(200).send(await getMyDocumentAccess(actor.userId, verificationId, deps()));
  });
}
