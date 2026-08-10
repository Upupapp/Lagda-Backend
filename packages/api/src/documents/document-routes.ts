// The workspace document surface.
//
//   POST   /workspaces/:workspaceId/documents
//   GET    /workspaces/:workspaceId/documents
//   GET    /workspaces/:workspaceId/documents/:documentId
//   PATCH  /workspaces/:workspaceId/documents/:documentId
//
// Four routes, and the two that are absent are the interesting ones.
//
// **No DELETE.** The product has no delete at document level, and the runtime
// database role has no DELETE grant on `documents`. A route would describe an
// operation LAGDA cannot perform.
//
// **No download.** `TransactionDetailPage.tsx` imports a `Download` icon and
// never uses it — one import, zero call sites. Building the endpoint would mean
// choosing between streaming and presigned URLs, and a presigned URL is a
// bearer credential that needs its own review (OD-114).
//
// ── PATCH, and it takes exactly one field ──────────────────────────────────
//
// PATCH rather than PUT because a document has ONE mutable field. A full
// replacement would have to restate `originalFilename` and `createdByUserId`,
// which the client may not set — so PUT would be a shape that looks like a
// replacement and silently ignores most of it.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// Authorization happens inside the use case against a membership row the server
// read, keyed on a capability. The BACKEND-27 guard greps this directory.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createDocument, listDocuments, getDocument, renameDocument,
  type DocumentDependencies, type DocumentSummary,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  DocumentSchema, DocumentSortFieldSchema,
  DOCUMENT_TITLE_MAX_LENGTH, MAX_PER_PAGE, DEFAULT_PER_PAGE,
  type DocumentId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const DocumentParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * Creating a document. **One property.**
 *
 * ── Read the exclusions; they are the security surface ─────────────────────
 *
 * `additionalProperties: false`, so every one of these is REJECTED rather than
 * ignored:
 *
 *   artifactId, uploadId       the caller does not choose which bytes
 *   storageKey, bucket         a storage key is a capability (INV-205)
 *   sha256, digest             integrity is computed, never declared
 *   sizeBytes, mediaType       server-observed while streaming
 *   pageCount                  from the upload inspection
 *   malwareScanStatus          the scanner's answer, not the caller's
 *   workspaceId                it is the path
 *   documentId                 the server generates it
 *   createdAt, updatedAt       the server stamps them
 *   createdByUserId            the session says who
 *   status                     a document has no status (§33)
 *
 * Rejecting rather than ignoring matters: a client that sent `sha256` is trying
 * to say something the contract does not permit, and silently dropping it would
 * let them believe it took effect.
 */
const CreateDocumentRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: DOCUMENT_TITLE_MAX_LENGTH }),
}, { additionalProperties: false });

/** Renaming. The same single field, and the same exclusions. */
const RenameDocumentRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: DOCUMENT_TITLE_MAX_LENGTH }),
}, { additionalProperties: false });

export type DocumentTitleBody = Static<typeof CreateDocumentRequestSchema>;

const DocumentListQuerySchema = Type.Object({
  sort: Type.Optional(DocumentSortFieldSchema),
  direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  // Bounded HERE. `perPage=1000000` is a valid integer and an invalid request,
  // and putting the bound in the schema means no handler can be the one that
  // forgets — which matters more than usual because each row costs an artifact
  // lookup.
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE, default: DEFAULT_PER_PAGE }),
  ),
}, { additionalProperties: false });

const DocumentListResponseSchema = Type.Object({
  items: Type.Array(DocumentSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  perPage: Type.Integer({ minimum: 1 }),
  hasNextPage: Type.Boolean(),
}, { additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface DocumentRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly documentDependencies: () => DocumentDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A document title is a legal matter name — "Retainer Agreement — Mabini
 * Business Services" identifies a client, a counterparty and a transaction.
 * None of it belongs in a shared cache.
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

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The wire projection.
 *
 * Note what cannot appear here even by accident: the use case's
 * `DocumentSummary` has no `storageReference`, no `artifactId` and no digest, so
 * there is no field to forget to strip. The exclusion is upstream, in the
 * projection, rather than a delete-list at the boundary.
 */
const present = (document: DocumentSummary) => ({
  documentId: document.documentId,
  title: document.title,
  originalFilename: document.originalFilename,
  createdByUserId: document.createdByUserId,
  createdAt: iso(document.createdAt),
  updatedAt: iso(document.updatedAt),
  source: document.source === null ? null : {
    mediaType: document.source.mediaType,
    sizeBytes: document.source.sizeBytes,
    pageCount: document.source.pageCount,
    uploadedAt: iso(document.source.uploadedAt),
  },
});

export function registerDocumentRoutes(
  app: FastifyInstance,
  options: DocumentRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * A document write.
   *
   * IDs and outcomes only. **Never the title and never the filename** — a legal
   * document's name reveals the client, the matter, the counterparty and often
   * the transaction value, which is precisely the disclosure §129 exists to
   * prevent. `titleLength` is logged instead where a size signal is useful:
   * it answers "did a rename happen" without saying to what.
   *
   * The metric's labels are `operation` and `result`, both closed sets. No
   * documentId, no workspaceId, no title — the first two are unbounded
   * cardinality and the third would put matter names in a metrics store.
   */
  const record = (
    request: FastifyRequest,
    event: "document.created" | "document.renamed",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("document_operations_total", {
      operation: event === "document.created" ? "created" : "renamed",
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

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/documents", {
    schema: {
      params: WorkspaceParamsSchema,
      body: CreateDocumentRequestSchema,
      response: { 201: DocumentSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const body = request.body as DocumentTitleBody;

    const document = await createDocument(
      actor, workspaceId as WorkspaceId, { title: body.title },
      options.documentDependencies());

    // The length is computed BEFORE the log call, so the payload object
    // contains no reference to the title at all. An architecture guard reads
    // these payloads literally, and `[...document.title].length` inside one
    // would be indistinguishable from logging the title itself.
    const titleLength = [...document.title].length;
    record(request, "document.created", {
      workspaceId,
      documentId: document.documentId,
      actorUserId: actor.userId,
      titleLength,
    });

    // 201 with the document, which has NO bytes yet. That is the normal
    // outcome, not a partial one: the caller uploads next, naming this id.
    void reply.header("Location",
      `/workspaces/${workspaceId}/documents/${document.documentId}`);
    return reply.status(201).send(present(document));
  });

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/documents", {
    schema: {
      params: WorkspaceParamsSchema,
      querystring: DocumentListQuerySchema,
      response: { 200: DocumentListResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const query = request.query as Static<typeof DocumentListQuerySchema>;

    const result = await listDocuments(
      actor, workspaceId as WorkspaceId,
      {
        // Each key passed only when supplied, so the use case's documented
        // defaults are the ones that apply rather than being restated here.
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.page === undefined ? {} : { page: query.page }),
        ...(query.perPage === undefined ? {} : { perPage: query.perPage }),
      },
      options.documentDependencies(),
    );

    return reply.status(200).send({
      items: result.items.map(present),
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      hasNextPage: result.hasNextPage,
    });
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/documents/:documentId", {
    schema: {
      params: DocumentParamsSchema,
      response: { 200: DocumentSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;
    const document = await getDocument(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      options.documentDependencies());

    return reply.status(200).send(present(document));
  });

  // ── Rename ──────────────────────────────────────────────────────────────
  app.patch("/workspaces/:workspaceId/documents/:documentId", {
    schema: {
      params: DocumentParamsSchema,
      body: RenameDocumentRequestSchema,
      response: { 200: DocumentSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;
    const body = request.body as DocumentTitleBody;

    const document = await renameDocument(
      actor, workspaceId as WorkspaceId, documentId as DocumentId, body.title,
      options.documentDependencies());

    const titleLength = [...document.title].length;
    record(request, "document.renamed", {
      workspaceId, documentId,
      actorUserId: actor.userId,
      titleLength,
    });

    return reply.status(200).send(present(document));
  });
}
