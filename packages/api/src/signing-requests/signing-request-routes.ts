// The signing request surface.
//
//   POST /workspaces/:workspaceId/documents/:documentId/signing-requests
//   GET  /workspaces/:workspaceId/signing-requests/:signingRequestId
//
// ── Create is nested; read is not ──────────────────────────────────────────
//
// Creation is an act performed ON a document, and nesting it puts the document
// in the URL where no body can override it. Reading is not: a request outlives
// its relationship to the authoring flow, and BACKEND-33 and BACKEND-34 will
// both hold a request id without necessarily holding the document's.
//
// ── The body is nearly empty, on purpose ───────────────────────────────────
//
// No recipients, no fields, no artifact, no state, no title. Every one is read
// from trusted preparation state inside the transaction. A client that could
// supply its own recipient array could create a signing workflow that does not
// match the document anyone reviewed — §68, §69, §156, §157.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// The BACKEND-27 guard greps this directory.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createSigningRequest, getSigningRequest, assertValidKey,
  type SigningRequestDependencies,
  type SigningRequestView, type SigningRequestCreatedView,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  SigningRequestSchema, SigningRequestCreatedSchema,
  IDEMPOTENCY_KEY_HEADER,
  type DocumentId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const CreateParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ReadParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * The creation body: empty, and closed.
 *
 * `additionalProperties: false` is doing real work here. Every one of these is
 * REJECTED with 422 rather than ignored:
 *
 *   recipients, fields          the snapshot comes from preparation (§68, §69)
 *   sourceArtifactId            the server resolves it from the preparation; a
 *                               client that chose it could sign different bytes
 *                               than the ones the geometry was authored against
 *   preparationId               resolved from the document
 *   state                       a client may not create a request as `sent`
 *   documentTitle               snapshotted from the document
 *   createdByUserId             from the session
 *   signingRequestId            server-generated
 *   subject, message            BACKEND-33 owns send metadata
 *   expiresAt, reminders        BACKEND-46
 *   authMethod                  BACKEND-34
 *
 * A rejection rather than silent tolerance, because a client that sent
 * `recipients` and got a 201 would reasonably believe they had been used.
 */
const CreateRequestBodySchema = Type.Object({}, {
  title: "CreateSigningRequestRequest",
  additionalProperties: false,
  description:
    "Deliberately empty. The signing configuration is snapshotted from the "
    + "document's preparation, never supplied by the caller.",
});

// ── Options ─────────────────────────────────────────────────────────────────

export interface SigningRequestRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly signingRequestDependencies: () => SigningRequestDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A signing request is the parties to a contract and where each of them signs.
 * Never a shared cache.
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

const presentCreated = (created: SigningRequestCreatedView) => ({
  signingRequestId: created.signingRequestId,
  documentId: created.documentId,
  state: created.state,
  recipientCount: created.recipientCount,
  fieldCount: created.fieldCount,
  createdAt: iso(created.createdAt),
});

const present = (request: SigningRequestView) => ({
  signingRequestId: request.signingRequestId,
  documentId: request.documentId,
  documentTitle: request.documentTitle,
  state: request.state,
  recipients: request.recipients.map(recipient => ({
    recipientId: recipient.recipientId,
    name: recipient.name,
    email: recipient.email,
    organization: recipient.organization,
    type: recipient.type,
    isRequired: recipient.isRequired,
    orderIndex: recipient.orderIndex,
    routingOrder: recipient.routingOrder,
  })),
  fields: request.fields.map(field => ({
    fieldId: field.fieldId,
    type: field.type,
    pageNumber: field.pageNumber,
    rect: field.rect,
    required: field.required,
    label: field.label,
    layer: field.layer,
    recipientId: field.recipientId,
  })),
  createdAt: iso(request.createdAt),
});

export function registerSigningRequestRoutes(
  app: FastifyInstance,
  options: SigningRequestRouteOptions,
): void {
  const metrics = options.metrics;

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/documents/:documentId/signing-requests", {
    schema: {
      params: CreateParamsSchema,
      body: CreateRequestBodySchema,
      response: { 201: SigningRequestCreatedSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof CreateParamsSchema>;

    // ── Required, like invitations ────────────────────────────────────────
    //
    // A lost response is indistinguishable from a failure to the browser that
    // sent it, and the retry would create a SECOND immutable workflow over the
    // same document. BACKEND-33 could then send both, and one agreement would
    // reach its counterparties as two sets of invitations.
    //
    // `.toLowerCase()` because Fastify normalizes header names and the
    // canonical constant is title-cased. Reading the constant verbatim would
    // silently find `undefined` and make every retry a new workflow - which is
    // exactly the bug this line prevents, and exactly the bug the route test
    // caught before this comment existed.
    const key = assertValidKey(
      request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined);

    const created = await createSigningRequest({
      actor,
      workspaceId: workspaceId as WorkspaceId,
      documentId: documentId as DocumentId,
      idempotencyKey: key,
    }, options.signingRequestDependencies());

    /**
     * COUNTS and ids, never the snapshot.
     *
     * A signing request is the names and email addresses of the parties to a
     * legal agreement, plus where each of them signs. Logging the snapshot
     * would put every LAGDA transaction's participants into whatever reads the
     * log; logging the layout would reconstruct the document's structure.
     *
     * The counts answer "are requests being created, and how big are they"
     * without any of it. `documentTitle` is absent for the same reason it is
     * absent from every document log line: a legal matter name identifies a
     * client and a transaction.
     */
    request.log.info({
      event: "signing_request.created",
      result: "success",
      workspaceId,
      documentId,
      signingRequestId: created.signingRequestId,
      actorUserId: actor.userId,
      state: created.state,
      recipientCount: created.recipientCount,
      fieldCount: created.fieldCount,
    }, "signing_request.created");

    metrics?.increment("signing_request_operations_total", {
      operation: "create",
      result: "success",
      processRole: "api",
    });

    return reply.status(201).send(presentCreated(created));
  });

  // ── Read ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/signing-requests/:signingRequestId", {
    schema: {
      params: ReadParamsSchema,
      response: { 200: SigningRequestSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof ReadParamsSchema>;

    const found = await getSigningRequest(
      actor, workspaceId as WorkspaceId, signingRequestId,
      options.signingRequestDependencies());

    // Reads are not logged. A sender reviewing a request before sending it
    // would otherwise produce a line per refresh.
    return reply.status(200).send(present(found));
  });
}
