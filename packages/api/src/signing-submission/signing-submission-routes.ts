// The recipient signature submission surface.
//
//   POST /signing/submission    session cookie + recipient CSRF + Idempotency-Key
//
// One route. Under the atomic model there is one signing act, so there is one
// endpoint that performs it — no per-field save, no partial commit, nothing
// that could leave a recipient half-signed.
//
// ── The handler decides nothing about signing ──────────────────────────────
//
// It checks the cookie, the CSRF token and the key header, validates the body
// SHAPE against the schema, and calls the use case. Field ownership, value
// semantics, consent and idempotency all live below it (§80).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Static } from "@sinclair/typebox";
import {
  submitRecipientSigning, validateRecipientCsrf,
  type SigningSubmissionDependencies, type SigningAccessDependencies,
  type RateLimitCheck,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import {
  SubmitSigningBodySchema, SubmitSigningResponseSchema,
  IDEMPOTENCY_KEY_HEADER, CSRF_TOKEN_HEADER,
  type IdempotencyKey,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import {
  RECIPIENT_SESSION_COOKIE_NAME, RECIPIENT_CSRF_COOKIE_NAME,
  clearRecipientSessionCookieOptions, clearRecipientCsrfCookieOptions,
} from "../security/cookies.js";
import type { ApiConfig } from "../config/index.js";
import type { MetricsRecorder } from "../observability/metrics.js";

export interface SigningSubmissionRouteOptions {
  readonly config: ApiConfig;
  readonly submissionDependencies: () => SigningSubmissionDependencies;
  readonly signingAccessDependencies: () => SigningAccessDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

export function registerSigningSubmissionRoutes(
  app: FastifyInstance,
  options: SigningSubmissionRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/signing/submission", {
    schema: {
      body: SubmitSigningBodySchema,
      response: { 201: SubmitSigningResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    void reply.header("Pragma", "no-cache");
    void reply.header("Referrer-Policy", "no-referrer");

    const raw = request.cookies[RECIPIENT_SESSION_COOKIE_NAME];
    if (raw === undefined) {
      void reply.clearCookie(RECIPIENT_SESSION_COOKIE_NAME,
        clearRecipientSessionCookieOptions(options.config));
      void reply.clearCookie(RECIPIENT_CSRF_COOKIE_NAME,
        clearRecipientCsrfCookieOptions(options.config));
      return reply.status(401).send({
        error: {
          code: "RECIPIENT_AUTHENTICATION_REQUIRED",
          message: "Open your signing link again to continue.",
        },
      });
    }

    // Recipient realm CSRF. A workspace token digests under a different domain
    // and cannot match, so the realms are separated by the derivation rather
    // than by comparing names (§28, §270).
    const submittedCsrf = request.headers[CSRF_TOKEN_HEADER.toLowerCase()];
    const csrfOk = typeof submittedCsrf === "string" && submittedCsrf.length > 0
      && await validateRecipientCsrf(
        raw, submittedCsrf, options.signingAccessDependencies());
    if (!csrfOk) {
      return reply.status(403).send({
        error: {
          code: "RECIPIENT_CSRF_REQUIRED",
          message: "This action could not be verified. Reload the signing page and try again.",
        },
      });
    }

    // MANDATORY, not optional (§195). A signing act without a key is an act a
    // network retry could duplicate, and there is no un-signing.
    const key = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    if (typeof key !== "string" || key.length === 0) {
      return reply.status(400).send({
        error: {
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: `${IDEMPOTENCY_KEY_HEADER} is required for signature submission.`,
        },
      });
    }

    // Deliberately generous. Idempotency is the duplicate protection here; a
    // limiter tight enough to block a retry storm would also block the retry
    // that recovers a lost response (§29).
    if (options.rateLimit !== undefined) {
      const checks: readonly RateLimitCheck[] = [{
        policy: policyById("signing-submission.ip"),
        scope: { type: "ip", ipAddress: request.ip },
      }];
      await checkSemanticLimits(request, checks, options.rateLimit);
    }

    const body = request.body as Static<typeof SubmitSigningBodySchema>;

    let result;
    try {
      result = await submitRecipientSigning({
        rawSessionToken: raw,
        idempotencyKey: key as IdempotencyKey,
        fieldValues: body.fieldValues,
        ...(body.signature === undefined ? {} : { signature: body.signature }),
        ...(body.initials === undefined ? {} : { initials: body.initials }),
      }, options.submissionDependencies());
    } catch (error) {
      // A BOUNDED reason and never the payload. A rejected submission must not
      // put a signer's typed text or a field value into a log line (§217, §293).
      request.log.info({
        event: "signing_submission.rejected",
        result: reasonOf(error),
      }, "signing_submission.rejected");
      metrics?.increment("signing_submission_results_total", {
        result: "rejected", submissionModel: "atomic", processRole: "api",
      });
      throw error;
    }

    // Ids and a count. No values, no signature data, no storage reference.
    request.log.info({
      event: "signing_submission.accepted",
      submissionId: result.submissionId,
      acceptedFieldCount: result.acceptedFieldCount,
      replayed: result.replayed,
    }, "signing_submission.accepted");
    metrics?.increment("signing_submission_results_total", {
      result: result.replayed ? "replayed" : "accepted",
      submissionModel: "atomic",
      processRole: "api",
    });

    return reply.status(201).send({
      submissionId: result.submissionId,
      acceptedAt: new Date(result.acceptedAt).toISOString(),
      acceptedFieldCount: result.acceptedFieldCount,
      // TRUE for this recipient. Deliberately not `completed`: the request is
      // not finished and BACKEND-37 has not run (§144, §322).
      recipientSubmissionAccepted: true as const,
    });
  });
}

/** A closed set. Never a message, never a field id, never a value. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case "signing_submission_invalid": return "invalid_field";
    case "signing_not_permitted": return "not_signable";
    case "signing_consent_required": return "consent_required";
    case "recipient_already_submitted": return "already_submitted";
    case "idempotency_conflict": return "idempotency_conflict";
    case "signing_submission_in_progress": return "in_progress";
    default: return "error";
  }
}
