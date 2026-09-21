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
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import {
  createSigningRequest, getSigningRequest, listSigningRequests, getSigningRequestStats, assertValidKey,
  setSigningRequestExpiry,
  markSigningRequestReadyToSend, returnSigningRequestToDraft,
  getCompletedArtifact, getSigningRequestSignatures,
  type SigningRequestDependencies, type SigningRequestId,
  type SigningRequestView, type SigningRequestCreatedView,
  type CompletedArtifactDependencies, type SigningRequestSignaturesView,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  SigningRequestSchema, SigningRequestCreatedSchema, SigningRequestListSchema,
  SigningRequestStatsSchema,
  SigningRequestStateSchema, SigningRequestSignaturesSchema,
  SetSigningRequestExpirySchema, IDEMPOTENCY_KEY_HEADER,
  type SetSigningRequestExpiryRequest,
  type DocumentId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const CreateParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ListParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
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
  /** Phase 1-C. Absent means no completed-document download route exists. */
  readonly completedArtifactDependencies?: () => CompletedArtifactDependencies;
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

const presentSignatures = (view: SigningRequestSignaturesView) => ({
  signingRequestId: view.signingRequestId,
  state: view.state,
  signedCount: view.signedCount,
  requiredCount: view.requiredCount,
  signatories: view.signatories.map(signatory => ({
    recipientId: signatory.recipientId,
    name: signatory.name,
    email: signatory.email,
    organization: signatory.organization,
    type: signatory.type,
    isRequired: signatory.isRequired,
    routingOrder: signatory.routingOrder,
    state: signatory.state,
    // Nullable instants stay null. Somebody who has not signed has no
    // signing time, and the epoch is a date rather than an absence.
    signedAt: signatory.signedAt === null ? null : iso(signatory.signedAt),
    declinedAt: signatory.declinedAt === null ? null : iso(signatory.declinedAt),
    declineReason: signatory.declineReason,
  })),
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
  /**
   * The workspace's signing requests.
   *
   * Registered BEFORE the by-id route. Fastify's router is not order-sensitive
   * for static versus parametric segments, but reading them in this order
   * makes the pair obvious -- and this is the one a document list calls.
   *
   * Answers the question a client could not previously ask: which of my
   * documents have been sent? A request was readable only by an id the client
   * had no way to discover.
   */
  app.get("/workspaces/:workspaceId/signing-requests", {
    schema: {
      params: ListParamsSchema,
      querystring: ListQuerySchema,
      response: { 200: SigningRequestListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ListParamsSchema>;
    const query = request.query as Static<typeof ListQuerySchema>;

    const result = await listSigningRequests(
      actor, workspaceId as WorkspaceId,
      { ...(query.page === undefined ? {} : { page: query.page }),
        ...(query.perPage === undefined ? {} : { perPage: query.perPage }) },
      options.signingRequestDependencies());

    return reply.status(200).send({
      ...result,
      items: result.items.map(item => ({
        signingRequestId: item.signingRequestId,
        documentId: item.documentId,
        state: item.state,
        documentTitle: item.documentTitle,
        participantCount: item.participantCount,
        completedParticipantCount: item.completedParticipantCount,
        // Who sent it. Null when that account no longer exists — the request
        // is the workspace's record and outlives its sender.
        initiator: item.initiator,
        createdAt: iso(item.createdAt),
        // Nullable timestamps stay null. A draft has not been sent, and the
        // epoch is a date rather than an absence.
        sentAt: item.sentAt === null ? null : iso(item.sentAt),
        completedAt: item.completedAt === null ? null : iso(item.completedAt),
        expiresAt: item.expiresAt === null ? null : iso(item.expiresAt),
      })),
    });
  });

  /**
   * Counts by state — the number the list cannot give.
   *
   * The list is paged at 100 with no status filter, so a client bucketing a
   * page was counting a page and calling it the workspace. This is one
   * GROUP BY behind the same capability. Registered before the
   * `/:signingRequestId` read so the static segment is never mistaken for an
   * id (the router prefers static routes regardless, but the order makes the
   * intent readable).
   */
  app.get("/workspaces/:workspaceId/signing-requests/stats", {
    schema: {
      params: ListParamsSchema,
      response: { 200: SigningRequestStatsSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof ListParamsSchema>;
    const stats = await getSigningRequestStats(
      actor, workspaceId as WorkspaceId, options.signingRequestDependencies());

    return reply.status(200).send(stats);
  });

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

  // ── Signing progress ────────────────────────────────────────────────────
  //
  // Its own route rather than fields on the one above, because that one is
  // the immutable snapshot and its guard test refuses ceremony state by
  // name. "What was agreed" and "what has happened since" are two questions,
  // and a client is always holding exactly one of them.
  //
  // Same dependencies as the read: this joins two tables the unit of work
  // already reaches, and touches no storage and no credential.
  app.get("/workspaces/:workspaceId/signing-requests/:signingRequestId/signatures", {
    schema: {
      params: ReadParamsSchema,
      response: { 200: SigningRequestSignaturesSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof ReadParamsSchema>;

    const signatures = await getSigningRequestSignatures(
      actor, workspaceId as WorkspaceId, signingRequestId as SigningRequestId,
      options.signingRequestDependencies());

    // Not logged, same reasoning as the read above: a sender watching for a
    // signature would produce a line per refresh, and the payload is the
    // parties to a contract.
    return reply.status(200).send(presentSignatures(signatures));
  });

  // ── The completed document (Phase 1-C, sender only) ────────────────────
  //
  // Absent key = route does not exist, same convention as every other
  // storage-dependent surface in this codebase (upload, the recipient
  // ceremony): a deployment with no object storage configured gets no
  // download route, not one that 500s on the first request.
  if (options.completedArtifactDependencies !== undefined) {
    const completedArtifactDependencies = options.completedArtifactDependencies;
    app.get("/workspaces/:workspaceId/signing-requests/:signingRequestId/completed-document", {
      schema: { params: ReadParamsSchema },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);

      const { workspaceId, signingRequestId } =
        request.params as Static<typeof ReadParamsSchema>;

      const document = await getCompletedArtifact(
        actor, workspaceId as WorkspaceId, signingRequestId as SigningRequestId,
        completedArtifactDependencies());

      // Same cache posture as the recipient ceremony's own document route: a
      // signed legal document must never sit in a shared cache, and `private`
      // alone would still permit the browser's disk cache.
      void reply.header("Cache-Control", "private, no-store");
      void reply.header("Pragma", "no-cache");
      void reply.header("Referrer-Policy", "no-referrer");
      void reply.header("Content-Type", document.mediaType);
      void reply.header("Content-Length", String(document.sizeBytes));
      // `attachment`, unlike the ceremony's `inline`: this IS the product's
      // download affordance, the one document-routes.ts documents as
      // deliberately absent until this phase decided the design.
      void reply.header(
        "Content-Disposition",
        `attachment; filename="${signingRequestId}.pdf"`,
      );
      void reply.header("Accept-Ranges", "none");

      // The port's contract is `AsyncIterable<Uint8Array>`, not "a Node
      // Readable" — the real S3 SDK's response body happens to be both, but
      // nothing guarantees every `ObjectStorage` implementation's stream is.
      // Fastify's `reply.send` only accepts a string, a Buffer, or a real
      // stream, so this wraps rather than assumes.
      return reply.status(200).send(Readable.from(document.stream));
    });
  }

  // ── The review state ────────────────────────────────────────────────────
  //
  // POST to a named sub-resource, not a state field on the request. A client
  // that could PUT `state` could write any state it liked, and the whole point
  // of the lifecycle table is that transitions are named operations with their
  // own rules -- §206's argument, applied at the boundary.
  //
  // Two routes rather than one taking a boolean: they have different meanings
  // and could later have different authority, and "readiness: false" reads
  // like a property when it is a retraction.
  for (const edge of [
    {
      suffix: "readiness",
      run: markSigningRequestReadyToSend,
      event: "signing_request.marked_ready",
    },
    {
      suffix: "draft",
      run: returnSigningRequestToDraft,
      event: "signing_request.returned_to_draft",
    },
  ] as const) {
    app.post(`/workspaces/:workspaceId/signing-requests/:signingRequestId/${edge.suffix}`, {
      schema: {
        params: ReadParamsSchema,
        // No body at all. A transition carries no payload -- everything it
        // needs is the request's own state, which the server already has.
        response: { 200: Type.Object({
          state: SigningRequestStateSchema,
        }, { additionalProperties: false }) },
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      noStore(reply);
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);

      const { workspaceId, signingRequestId } =
        request.params as Static<typeof ReadParamsSchema>;

      const result = await edge.run({
        actor,
        workspaceId: workspaceId as WorkspaceId,
        signingRequestId: signingRequestId as SigningRequestId,
      }, options.signingRequestDependencies());

      // Ids and the outcome. Never the document title -- it is a matter name.
      request.log.info({
        event: edge.event, result: "success",
        workspaceId, signingRequestId, actorUserId: actor.userId,
      }, edge.event);

      return reply.status(200).send({ state: result.state });
    });
  }

  // ── The deadline ────────────────────────────────────────────────────────
  //
  // PUT, not PATCH. The body carries exactly one field and always sets it:
  // null CLEARS the deadline rather than leaving it alone, so this is a
  // replacement of the whole (one-field) resource and not a partial update.
  // PATCH would invite a later reader to add a second optional field and
  // reintroduce the "absent or null?" ambiguity this shape exists to avoid.
  app.put("/workspaces/:workspaceId/signing-requests/:signingRequestId/expiry", {
    schema: {
      params: ReadParamsSchema,
      body: SetSigningRequestExpirySchema,
      response: { 200: Type.Object({
        expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
      }, { additionalProperties: false }) },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof ReadParamsSchema>;
    const body = request.body as SetSigningRequestExpiryRequest;

    const result = await setSigningRequestExpiry({
      actor,
      workspaceId: workspaceId as WorkspaceId,
      signingRequestId: signingRequestId as SigningRequestId,
      // `Date.parse` of a schema-validated date-time. NaN is unreachable here,
      // and would be refused by the use case's future check even if it were.
      expiresAt: body.expiresAt === null ? null : Date.parse(body.expiresAt),
    }, options.signingRequestDependencies());

    // The INSTANT is logged, not omitted: a deadline is the sender's own
    // scheduling decision about their own request, carries no counterparty
    // detail, and is the one field an operator needs to answer "why did this
    // expire". Contrast the document title, which is a matter name.
    request.log.info({
      event: "signing_request.expiry_set",
      result: "success",
      workspaceId,
      signingRequestId,
      actorUserId: actor.userId,
      expiresAt: result.expiresAt,
      cleared: result.expiresAt === null,
    }, "signing_request.expiry_set");

    return reply.status(200).send({
      expiresAt: result.expiresAt === null ? null : iso(result.expiresAt),
    });
  });
}
