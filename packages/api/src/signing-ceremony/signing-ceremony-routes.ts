// The recipient signing ceremony surface.
//
//   POST /signing/ceremony/enter        session cookie + recipient CSRF
//   GET  /signing/ceremony              session cookie
//   GET  /signing/ceremony/document     session cookie, streams the PDF
//   POST /signing/ceremony/consent      session cookie + recipient CSRF
//
// ── Registered OUTSIDE the authenticated scope ─────────────────────────────
//
// Same reason as BACKEND-34's routes: a recipient has no LAGDA session, and
// `requireSession` would reject every signer in the world. `WorkspaceAccessContext`
// does not appear in this file and must not.
//
// ── Why entering is a POST and reading is a GET ────────────────────────────
//
// Entering records a first-entry timestamp, which is a side effect, and §190
// prefers keeping evidence-producing acts out of GET. A prefetch or a
// speculative reload should never be able to record that someone began
// signing.
//
// The read endpoints record nothing at all, which is what makes them safe to
// poll.
//
// ── No identifier is accepted from the client, anywhere ────────────────────
//
// Not in a path, not in a query, not in a body. The request and the recipient
// come from the session cookie. There is no `:requestId` to compare against,
// because the surest way to avoid trusting a client-supplied id is not to have
// one (§5, §6, §296).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  enterSigningCeremony, getSigningCeremony, getRecipientSigningDocument,
  acceptSigningConsent, validateRecipientCsrf,
  type SigningCeremonyDependencies, type SigningAccessDependencies,
  type SigningCeremonyView, type RateLimitCheck,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import {
  RECIPIENT_SESSION_COOKIE_NAME, RECIPIENT_CSRF_COOKIE_NAME,
  clearRecipientSessionCookieOptions, clearRecipientCsrfCookieOptions,
} from "../security/cookies.js";
import { CSRF_TOKEN_HEADER } from "@lagda/contracts";
import type { ApiConfig } from "../config/index.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const FieldSchema = Type.Object({
  fieldId: Type.String({ minLength: 1, maxLength: 64 }),
  type: Type.String({ minLength: 1, maxLength: 32 }),
  /** 1-based, canonical. */
  pageNumber: Type.Integer({ minimum: 1 }),
  /** Normalized 0–1, top-left origin, `y` to the field's TOP. Unchanged. */
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  width: Type.Number({ minimum: 0, maximum: 1 }),
  height: Type.Number({ minimum: 0, maximum: 1 }),
  required: Type.Boolean(),
  label: Type.String({ maxLength: 200 }),
  layer: Type.Integer(),
  valueAuthority: Type.Union([
    Type.Literal("RECIPIENT_SUPPLIED"), Type.Literal("SERVER_DERIVED"),
  ]),
  valueKind: Type.String({ minLength: 1, maxLength: 32 }),
  maxLength: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { title: "CeremonyField", additionalProperties: false });

const CeremonyResponseSchema = Type.Object({
  request: Type.Object({
    signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
    documentTitle: Type.String({ maxLength: 500 }),
  }, { additionalProperties: false }),
  recipient: Type.Object({
    recipientId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ maxLength: 200 }),
    email: Type.String({ maxLength: 320 }),
    type: Type.String({ minLength: 1, maxLength: 32 }),
  }, { additionalProperties: false }),
  access: Type.Object({
    mayEnter: Type.Boolean(),
    mayViewDocument: Type.Boolean(),
    mayViewAssignedFields: Type.Boolean(),
    mayAcceptConsent: Type.Boolean(),
    mayProceedToInput: Type.Boolean(),
  }, { additionalProperties: false }),
  consent: Type.Object({
    required: Type.Boolean(),
    accepted: Type.Boolean(),
    type: Type.String({ minLength: 1, maxLength: 64 }),
    requiredVersion: Type.String({ minLength: 1, maxLength: 32 }),
    acceptedVersion: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
    acceptedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  }, { additionalProperties: false }),
  document: Type.Union([
    Type.Object({
      mediaType: Type.String({ maxLength: 128 }),
      sizeBytes: Type.Integer({ minimum: 0 }),
      digest: Type.String({ maxLength: 128 }),
      pageCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  fields: Type.Array(FieldSchema),
  firstEnteredAt: Type.Union([
    Type.String({ format: "date-time" }), Type.Null(),
  ]),
}, { title: "SigningCeremony", additionalProperties: false });

const ConsentBodySchema = Type.Object({
  /**
   * The ONLY value a client may send to this surface.
   *
   * Not a recipient id, not a request id, not an acceptedAt, not a user id.
   * Everything else comes from the session or the backend clock, and the
   * version is checked against what the ceremony is currently asking for.
   */
  consentVersion: Type.String({ minLength: 1, maxLength: 32 }),
}, { title: "AcceptSigningConsent", additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface SigningCeremonyRouteOptions {
  readonly config: ApiConfig;
  readonly ceremonyDependencies: () => SigningCeremonyDependencies;
  readonly signingAccessDependencies: () => SigningAccessDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
  void reply.header("Referrer-Policy", "no-referrer");
}

async function limit(
  request: FastifyRequest,
  options: SigningCeremonyRouteOptions,
  checks: readonly RateLimitCheck[],
): Promise<void> {
  if (options.rateLimit === undefined) return;
  await checkSemanticLimits(request, checks, options.rateLimit);
}

/**
 * The projection, as JSON.
 *
 * `blocker` is deliberately NOT serialized: the use case throws when a ceremony
 * cannot be entered, so a successful response always has `blocker: null` and a
 * field that is always null is noise on the wire.
 */
function present(view: SigningCeremonyView) {
  return {
    request: view.request,
    recipient: view.recipient,
    access: {
      mayEnter: view.access.mayEnter,
      mayViewDocument: view.access.mayViewDocument,
      mayViewAssignedFields: view.access.mayViewAssignedFields,
      mayAcceptConsent: view.access.mayAcceptConsent,
      mayProceedToInput: view.access.mayProceedToInput,
    },
    consent: {
      required: view.consent.required,
      accepted: view.consent.accepted,
      type: view.consent.type,
      requiredVersion: view.consent.requiredVersion,
      acceptedVersion: view.consent.acceptedVersion,
      acceptedAt: view.consent.acceptedAt === null
        ? null : new Date(view.consent.acceptedAt).toISOString(),
    },
    document: view.document,
    fields: view.fields,
    firstEnteredAt: view.firstEnteredAt === null
      ? null : new Date(view.firstEnteredAt).toISOString(),
  };
}

export function registerSigningCeremonyRoutes(
  app: FastifyInstance,
  options: SigningCeremonyRouteOptions,
): void {
  const metrics = options.metrics;

  /** The session cookie, or a 401 in the recipient realm's own vocabulary. */
  const sessionOr401 = (
    request: FastifyRequest, reply: FastifyReply,
  ): string | null => {
    const raw = request.cookies[RECIPIENT_SESSION_COOKIE_NAME];
    if (raw === undefined) {
      void recipientUnauthenticated(reply, options.config);
      return null;
    }
    return raw;
  };

  /**
   * Double-submit, in the RECIPIENT realm.
   *
   * The submitted header is digested under the recipient CSRF domain and
   * compared against this session's own digest. A workspace-realm token
   * digests under a different domain, so it cannot match — the realms are
   * separated by the derivation, not by a name check (§125).
   */
  const csrfOk = async (
    request: FastifyRequest, rawSession: string,
  ): Promise<boolean> => {
    const submitted = request.headers[CSRF_TOKEN_HEADER.toLowerCase()];
    if (typeof submitted !== "string" || submitted.length === 0) return false;
    return validateRecipientCsrf(
      rawSession, submitted, options.signingAccessDependencies());
  };

  // ── Enter ───────────────────────────────────────────────────────────────
  app.post("/signing/ceremony/enter", {
    schema: { response: { 200: CeremonyResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const raw = sessionOr401(request, reply);
    if (raw === null) return reply;

    if (!await csrfOk(request, raw)) return recipientCsrfRejected(reply);

    await limit(request, options, [{
      policy: policyById("signing-ceremony.read.ip"),
      scope: { type: "ip", ipAddress: request.ip },
    }]);

    const view = await enterSigningCeremony(raw, options.ceremonyDependencies());

    // The one operational line this surface writes. Ids only — no name, no
    // email, no title, no field layout.
    request.log.info({
      event: "signing_ceremony.entered",
      signingRequestId: view.request.signingRequestId,
      recipientId: view.recipient.recipientId,
    }, "signing_ceremony.entered");
    metrics?.increment("signing_ceremony_results_total", {
      operation: "enter", result: "success", processRole: "api",
    });

    return reply.status(200).send(present(view));
  });

  // ── Read ────────────────────────────────────────────────────────────────
  //
  // No write, no event, no metric. A signing page may poll this, and a read
  // that records something is a read that cannot be polled.
  app.get("/signing/ceremony", {
    schema: { response: { 200: CeremonyResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const raw = sessionOr401(request, reply);
    if (raw === null) return reply;

    await limit(request, options, [{
      policy: policyById("signing-ceremony.read.ip"),
      scope: { type: "ip", ipAddress: request.ip },
    }]);

    const view = await getSigningCeremony(raw, options.ceremonyDependencies());
    return reply.status(200).send(present(view));
  });

  // ── Document bytes ──────────────────────────────────────────────────────
  //
  // Streamed from the application layer, which already committed its
  // authorization transaction. The storage key never reaches this file.
  app.get("/signing/ceremony/document", async (
    request: FastifyRequest, reply: FastifyReply,
  ) => {
    const raw = sessionOr401(request, reply);
    if (raw === null) return reply;

    await limit(request, options, [{
      policy: policyById("signing-ceremony.document.ip"),
      scope: { type: "ip", ipAddress: request.ip },
    }]);

    const document = await getRecipientSigningDocument(
      raw, options.ceremonyDependencies());

    // `private, no-store`: a signing document must not sit in a shared cache,
    // and `private` alone would still permit the browser's disk cache.
    void reply.header("Cache-Control", "private, no-store");
    void reply.header("Pragma", "no-cache");
    void reply.header("Referrer-Policy", "no-referrer");
    // The VALIDATED media type from the artifact row, never a client claim
    // and never the provider's echo (§28).
    void reply.header("Content-Type", document.mediaType);
    void reply.header("Content-Length", String(document.sizeBytes));
    // `inline`: the ceremony shows the document, it does not hand out a file.
    // The product has no download affordance and adding one because the bytes
    // are technically reachable would be a product decision nobody made (§27).
    void reply.header("Content-Disposition", "inline");
    // Honest about what is NOT supported. A PDF viewer that needs ranges will
    // see this and fetch whole; claiming `bytes` while ignoring the header
    // would corrupt renders instead of degrading them.
    void reply.header("Accept-Ranges", "none");
    // No X-Storage-Key, no X-Artifact-Id, no digest header. Nothing here
    // describes where the bytes came from.

    metrics?.increment("signing_ceremony_results_total", {
      operation: "document", result: "success", processRole: "api",
    });
    return reply.status(200).send(document.stream);
  });

  // ── Consent ─────────────────────────────────────────────────────────────
  app.post("/signing/ceremony/consent", {
    schema: {
      body: ConsentBodySchema,
      response: { 200: CeremonyResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const raw = sessionOr401(request, reply);
    if (raw === null) return reply;

    if (!await csrfOk(request, raw)) return recipientCsrfRejected(reply);

    await limit(request, options, [{
      policy: policyById("signing-ceremony.consent.ip"),
      scope: { type: "ip", ipAddress: request.ip },
    }]);

    const body = request.body as Static<typeof ConsentBodySchema>;
    const view = await acceptSigningConsent(
      raw, { consentVersion: body.consentVersion },
      options.ceremonyDependencies());

    // The VERSION, never the disclosure text. §211.
    request.log.info({
      event: "signing_consent.accepted",
      signingRequestId: view.request.signingRequestId,
      recipientId: view.recipient.recipientId,
      consentType: view.consent.type,
      consentVersion: view.consent.acceptedVersion,
    }, "signing_consent.accepted");
    metrics?.increment("signing_ceremony_results_total", {
      operation: "consent", result: "success", processRole: "api",
    });

    return reply.status(200).send(present(view));
  });
}

function recipientUnauthenticated(
  reply: FastifyReply, config: ApiConfig,
): FastifyReply {
  void reply.clearCookie(
    RECIPIENT_SESSION_COOKIE_NAME, clearRecipientSessionCookieOptions(config));
  void reply.clearCookie(
    RECIPIENT_CSRF_COOKIE_NAME, clearRecipientCsrfCookieOptions(config));
  return reply.status(401).send({
    error: {
      code: "RECIPIENT_AUTHENTICATION_REQUIRED",
      message: "Open your signing link again to continue.",
    },
  });
}

/**
 * A failed recipient CSRF check.
 *
 * 403 rather than 401, and the cookies are NOT cleared: the session is fine,
 * the request was not. Clearing here would let a forged cross-site request log
 * a legitimate signer out.
 */
function recipientCsrfRejected(reply: FastifyReply): FastifyReply {
  return reply.status(403).send({
    error: {
      code: "RECIPIENT_CSRF_REQUIRED",
      message: "This action could not be verified. Reload the signing page and try again.",
    },
  });
}
