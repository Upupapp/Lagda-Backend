// The recipient decline surface (OD-154).
//
//   POST /signing/decline    session cookie + recipient CSRF
//
// ── Why there is no Idempotency-Key here, when submission demands one ──────
//
// A submission is an act a network retry could DUPLICATE — two accepted
// signatures for one intent — and there is no un-signing, so BACKEND-36 made
// the key mandatory.
//
// A decline cannot duplicate. `markDeclined` is conditional on the recipient
// being `active`, so a retry matches zero rows and the use case returns
// `applied: false`. The convergence is in the database, and adding a key would
// be a second mechanism for a problem the first one already solves.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  declineSigningRequest, validateRecipientCsrf,
  type SigningDeclineDependencies, type SigningAccessDependencies,
  type RateLimitCheck,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import {
  DeclineSigningBodySchema, DeclineSigningResponseSchema, CSRF_TOKEN_HEADER,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import {
  RECIPIENT_SESSION_COOKIE_NAME, RECIPIENT_CSRF_COOKIE_NAME,
  clearRecipientSessionCookieOptions, clearRecipientCsrfCookieOptions,
} from "../security/cookies.js";
import type { ApiConfig } from "../config/index.js";
import type { MetricsRecorder } from "../observability/metrics.js";

export interface SigningDeclineRouteOptions {
  readonly config: ApiConfig;
  readonly declineDependencies: () => SigningDeclineDependencies;
  readonly signingAccessDependencies: () => SigningAccessDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

export function registerSigningDeclineRoutes(
  app: FastifyInstance,
  options: SigningDeclineRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/signing/decline", {
    schema: {
      body: DeclineSigningBodySchema,
      response: { 200: DeclineSigningResponseSchema },
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

    // Recipient-realm CSRF. A workspace token digests under a different domain
    // and cannot match, so the realms are separated by the derivation.
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

    if (options.rateLimit !== undefined) {
      const checks: readonly RateLimitCheck[] = [{
        policy: policyById("signing-submission.ip"),
        scope: { type: "ip", ipAddress: request.ip },
      }];
      await checkSemanticLimits(request, checks, options.rateLimit);
    }

    const body = request.body as Static<typeof DeclineSigningBodySchema>;

    let result;
    try {
      result = await declineSigningRequest(
        { rawSessionToken: raw, reason: body.reason },
        options.declineDependencies());
    } catch (error) {
      // A BOUNDED reason. Never the request, never the recipient, never the
      // reason code — which is the recipient's own statement about a document.
      request.log.info({
        event: "signing_decline.rejected",
        result: error instanceof Error ? error.name : "unknown",
      }, "signing_decline.rejected");
      metrics?.increment("signing_decline_results_total", {
        result: "rejected", processRole: "api",
      });
      throw error;
    }

    // No id, no reason, no recipient. That a decline happened is all this line
    // needs to say, and the reason belongs to the sender's screen rather than
    // to an operator's log (§197).
    request.log.info({
      event: "signing_decline.accepted",
      applied: result.applied,
    }, "signing_decline.accepted");
    metrics?.increment("signing_decline_results_total", {
      result: result.applied ? "accepted" : "converged", processRole: "api",
    });

    return reply.status(200).send(result);
  });
}
