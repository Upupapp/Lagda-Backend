// The document preparation surface.
//
//   GET /workspaces/:workspaceId/documents/:documentId/preparation
//   PUT /workspaces/:workspaceId/documents/:documentId/preparation
//
// Two routes, and PUT is the only mutation.
//
// ── Why whole-layout PUT ───────────────────────────────────────────────────
//
// The editor is a drag-and-drop canvas that autosaves. Per-field endpoints mean
// a request per drag frame, partial save states, and a layout a reader can
// observe half-applied. One idempotent replace matches how the editor thinks
// and commits atomically. §102 requires choosing one model deliberately.
//
// ── Read is `document.view`, write is `document.prepare` ───────────────────
//
// Seeing where a document's signatures go is part of reading the document — a
// reviewer who may read it may see the layout. Changing it is a separate
// product permission, so it is a separate capability.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// The BACKEND-27 guard greps this directory.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getDocumentPreparation, saveDocumentPreparation,
  type PreparationDependencies, type PreparationView,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  DocumentPreparationSchema, PreparationFieldTypeSchema, PreparationRectSchema,
  PREPARATION_FIELD_LABEL_MAX_LENGTH, PREPARATION_MAX_FIELDS,
  PREPARATION_RECIPIENT_ID_MAX_LENGTH,
  type DocumentId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const PreparationParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * One field in a layout save.
 *
 * ── Read the exclusions ────────────────────────────────────────────────────
 *
 * `additionalProperties: false`, so every one of these is REJECTED with 422:
 *
 *   value, signature, signedAt   a signer's answer. Preparation records the
 *                                REQUEST, never the response
 *   workspaceId, preparationId   the path and the parent
 *   sourceArtifactId             a layout save may not repoint the geometry at
 *                                different bytes (§250)
 *   state, lockedAt              a client may not lock or unlock (§251)
 *   createdAt, updatedAt         the server stamps them
 *   radioOptions, senderText     types this command does not implement; their
 *                                presence would mean a field type it refuses
 *
 * `pageNumber` is 1-BASED. A zero fails `minimum: 1` here rather than being
 * read as page 1, which would place the field on the wrong page silently.
 */
const FieldInputSchema = Type.Object({
  /**
   * Omitted for a new field. Supplied to PRESERVE identity across a move or
   * resize — and honoured only if it already belongs to this preparation, so it
   * can never name another tenant's row.
   */
  fieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  type: PreparationFieldTypeSchema,
  pageNumber: Type.Integer({ minimum: 1 }),
  rect: PreparationRectSchema,
  required: Type.Boolean(),
  label: Type.String({ maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
  layer: Type.Integer({ minimum: 0 }),
  /**
   * The recipient expected to complete this field. Optional on the wire so an
   * editor can place a field before deciding who fills it; the use case checks
   * any value it does receive against THIS preparation's recipients.
   */
  recipientId: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: PREPARATION_RECIPIENT_ID_MAX_LENGTH }),
    Type.Null(),
  ])),
}, { additionalProperties: false });

const SaveLayoutRequestSchema = Type.Object({
  /**
   * The revision the client read. Concurrency, never authorization.
   *
   * `0` means "there was no preparation when I loaded" and is how a first save
   * arrives. A stale value is refused with 409 rather than silently erasing
   * another tab's work.
   */
  expectedRevision: Type.Integer({ minimum: 0 }),
  // Bounded HERE as well as in the domain: an unbounded array is an unbounded
  // request body and an unbounded write, and the bound belongs where a request
  // can be rejected before it becomes either.
  fields: Type.Array(FieldInputSchema, { maxItems: PREPARATION_MAX_FIELDS }),
}, { additionalProperties: false });

export type SaveLayoutBody = Static<typeof SaveLayoutRequestSchema>;

// ── Options ─────────────────────────────────────────────────────────────────

export interface PreparationRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly preparationDependencies: () => PreparationDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A layout says where every signature on a contract goes, and its labels name
 * the parties. Not for a shared cache.
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

const present = (preparation: PreparationView) => ({
  preparationId: preparation.preparationId,
  documentId: preparation.documentId,
  pageCount: preparation.pageCount,
  state: preparation.state,
  revision: preparation.revision,
  fields: preparation.fields.map(field => ({
    fieldId: field.fieldId,
    type: field.type,
    pageNumber: field.pageNumber,
    rect: field.rect,
    required: field.required,
    label: field.label,
    layer: field.layer,
    recipientId: field.recipientId,
  })),
  createdAt: iso(preparation.createdAt),
  updatedAt: iso(preparation.updatedAt),
});

export function registerPreparationRoutes(
  app: FastifyInstance,
  options: PreparationRouteOptions,
): void {
  const metrics = options.metrics;

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  // ── Read ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/documents/:documentId/preparation", {
    schema: {
      params: PreparationParamsSchema,
      response: { 200: DocumentPreparationSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } =
      request.params as Static<typeof PreparationParamsSchema>;

    const preparation = await getDocumentPreparation(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      options.preparationDependencies());

    // Reads are not logged. An editor polls this, and a log line per poll would
    // be noise that also records how often a document is being worked on.
    return reply.status(200).send(present(preparation));
  });

  // ── Save ────────────────────────────────────────────────────────────────
  app.put("/workspaces/:workspaceId/documents/:documentId/preparation", {
    schema: {
      params: PreparationParamsSchema,
      body: SaveLayoutRequestSchema,
      response: { 200: DocumentPreparationSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } =
      request.params as Static<typeof PreparationParamsSchema>;
    const body = request.body as SaveLayoutBody;

    const preparation = await saveDocumentPreparation(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      { expectedRevision: body.expectedRevision, fields: body.fields },
      options.preparationDependencies());

    /**
     * COUNTS, never the layout.
     *
     * A field layout says where every signature on a contract goes, and the
     * labels name the parties — "Landlord signature", "Guarantor initials".
     * Coordinates plus labels reconstruct the document's structure and its
     * participants, which is precisely what §188 says not to log.
     *
     * The counts answer "is the editor saving, and how big are layouts" without
     * any of that. Computed before the call so the payload references no field
     * data at all.
     */
    const fieldCount = preparation.fields.length;
    const pagesUsed = new Set(preparation.fields.map(field => field.pageNumber)).size;
    request.log.info({
      event: "document.preparation.saved",
      result: "success",
      workspaceId,
      documentId,
      preparationId: preparation.preparationId,
      actorUserId: actor.userId,
      revision: preparation.revision,
      fieldCount,
      pagesUsed,
    }, "document.preparation.saved");

    metrics?.increment("document_preparation_operations_total", {
      operation: "saved",
      result: "success",
      processRole: "api",
    });

    return reply.status(200).send(present(preparation));
  });
}
