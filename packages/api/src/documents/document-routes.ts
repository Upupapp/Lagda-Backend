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
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import {
  createDocument, listDocuments, getDocument, renameDocument, fileDocument,
  getDocumentContent,
  type DocumentDependencies, type DocumentSummary,
  type DocumentContentDependencies,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  DocumentSchema, DocumentSortFieldSchema,
  DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_SEARCH_MAX_LENGTH, MAX_PER_PAGE, DEFAULT_PER_PAGE,
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

/**
 * Updating: EXACTLY ONE field, chosen from two.
 *
 * `minProperties`/`maxProperties` rather than a handler check, so the rule is
 * in the schema where no handler can be the one that forgets it — the same
 * argument this file already makes for `perPage` and the search term.
 *
 * Exactly one, not "at least one", and that is a correctness choice rather
 * than a style one. Renaming and filing are separate commands with separate
 * rules; accepting both in one body would mean applying two commands to one
 * document, where the second can fail after the first has already committed.
 * A client that wants to do both sends two requests and learns the outcome of
 * each.
 *
 * `folderId: null` is a VALUE, meaning the workspace root — the way a document
 * is un-filed. It is not "leave the folder alone": a body that omits the key
 * entirely says that, and `maxProperties` means such a body carries a title
 * instead.
 */
const UpdateDocumentRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: DOCUMENT_TITLE_MAX_LENGTH })),
  folderId: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  ),
}, { additionalProperties: false, minProperties: 1, maxProperties: 1 });

export type DocumentTitleBody = Static<typeof CreateDocumentRequestSchema>;
export type DocumentUpdateBody = Static<typeof UpdateDocumentRequestSchema>;

const DocumentListQuerySchema = Type.Object({
  /**
   * Free text over the TITLE.
   *
   * Bounded in the schema, so no handler can be the one that forgets: an
   * unbounded term is an unbounded LIKE pattern. Only the title is searched --
   * a document has no other text the API holds, and searching the file's
   * CONTENTS is a different feature with different privacy consequences.
   */
  q: Type.Optional(Type.String({ maxLength: DOCUMENT_SEARCH_MAX_LENGTH })),
  /**
   * One folder. Absent means every folder, NOT "documents in no folder" --
   * those are different questions and only the first has a caller.
   */
  folderId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
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
  /**
   * Viewing a document's own bytes. Separate from `documentDependencies`
   * because it needs strictly more: object storage, which listing/renaming
   * never touch — same "absent key = route does not exist" convention as
   * upload, the recipient ceremony, and the completed-artifact download.
   */
  readonly documentContentDependencies?: () => DocumentContentDependencies;
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
  folderId: document.folderId,
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
  const OPERATION = {
    "document.created": "created",
    "document.renamed": "renamed",
    "document.filed": "filed",
  } as const;

  const record = (
    request: FastifyRequest,
    event: keyof typeof OPERATION,
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("document_operations_total", {
      // A total map rather than a ternary chain: the third event turned the
      // two-way conditional into something where a fourth would silently
      // inherit whichever branch was the fallback.
      operation: OPERATION[event],
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
        ...(query.q === undefined ? {} : { search: query.q }),
        ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
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

  // ── Rename, or file in a folder ─────────────────────────────────────────
  app.patch("/workspaces/:workspaceId/documents/:documentId", {
    schema: {
      params: DocumentParamsSchema,
      body: UpdateDocumentRequestSchema,
      response: { 200: DocumentSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;
    const body = request.body as DocumentUpdateBody;

    // `in`, not a truthiness or undefined test. `folderId: null` is a real
    // instruction — move to the root — and every shorthand for "is it set"
    // reads null as absent, which would turn un-filing into a silent no-op.
    if ("folderId" in body) {
      const document = await fileDocument(
        actor, workspaceId as WorkspaceId, documentId as DocumentId,
        body.folderId ?? null, options.documentDependencies());

      // The folder ID is an identifier, not content: it names a container the
      // caller already knew, so logging it discloses nothing a title would.
      record(request, "document.filed", {
        workspaceId, documentId,
        actorUserId: actor.userId,
        folderId: document.folderId,
      });

      return reply.status(200).send(present(document));
    }

    const document = await renameDocument(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      // Narrowed by the schema: exactly one key, and it is not `folderId`.
      body.title as string,
      options.documentDependencies());

    const titleLength = [...document.title].length;
    record(request, "document.renamed", {
      workspaceId, documentId,
      actorUserId: actor.userId,
      titleLength,
    });

    return reply.status(200).send(present(document));
  });

  // ── Content (view) ─────────────────────────────────────────────────────
  //
  // Absent key = route does not exist, same convention as upload, the
  // recipient ceremony, and the completed-artifact download: a deployment
  // with no object storage configured gets no view route, not one that 500s
  // on the first request.
  if (options.documentContentDependencies !== undefined) {
    const documentContentDependencies = options.documentContentDependencies;
    app.get("/workspaces/:workspaceId/documents/:documentId/content", {
      schema: { params: DocumentParamsSchema },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);

      const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;

      const document = await getDocumentContent(
        actor, workspaceId as WorkspaceId, documentId as DocumentId,
        documentContentDependencies());

      // Same cache posture as the ceremony's own document route: never a
      // shared cache, and `private` alone would still permit the browser's
      // disk cache.
      void reply.header("Cache-Control", "private, no-store");
      void reply.header("Pragma", "no-cache");
      void reply.header("Referrer-Policy", "no-referrer");
      void reply.header("Content-Type", document.mediaType);
      void reply.header("Content-Length", String(document.sizeBytes));
      // `inline`, like the ceremony: this shows the document, it does not
      // hand out a file. OD-114 (a dedicated download affordance) stays open.
      void reply.header("Content-Disposition", "inline");
      void reply.header("Accept-Ranges", "none");

      return reply.status(200).send(Readable.from(document.stream));
    });
  }
}
