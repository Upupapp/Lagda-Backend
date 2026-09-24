// The APPROVER skip surface (069).
//
//   POST /signing/skip    session cookie + recipient CSRF
//
// `signing-decline-routes.ts`'s exact shape — same realm, same CSRF
// validator, same reasoning for no Idempotency-Key (`markSkipped` is
// conditional on the recipient being `active`; a retry matches zero rows and
// the use case returns `applied: false`, so a network retry cannot
// duplicate).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  skipApprovalRequest, validateRecipientCsrf,
  type SigningSkipDependencies, type SigningAccessDependencies,
  type RateLimitCheck,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import {
  SkipApprovalBodySchema, SkipApprovalResponseSchema, CSRF_TOKEN_HEADER,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import {
  RECIPIENT_SESSION_COOKIE_NAME, RECIPIENT_CSRF_COOKIE_NAME,
  clearRecipientSessionCookieOptions, clearRecipientCsrfCookieOptions,
} from "../security/cookies.js";
import type { ApiConfig } from "../config/index.js";
import type { MetricsRecorder } from "../observability/metrics.js";

export interface SigningSkipRouteOptions {
  readonly config: ApiConfig;
  readonly skipDependencies: () => SigningSkipDependencies;
  readonly signingAccessDependencies: () => SigningAccessDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

export function registerSigningSkipRoutes(
  app: FastifyInstance,
  options: SigningSkipRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/signing/skip", {
    schema: {
      body: SkipApprovalBodySchema,
      response: { 200: SkipApprovalResponseSchema },
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

    // Recipient-realm CSRF. Same derivation as decline's; a workspace token
    // digests under a different domain and cannot match.
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

    let result;
    try {
      result = await skipApprovalRequest(
        { rawSessionToken: raw }, options.skipDependencies());
    } catch (error) {
      // A BOUNDED reason. Never the request, never the recipient.
      request.log.info({
        event: "signing_skip.rejected",
        result: error instanceof Error ? error.name : "unknown",
      }, "signing_skip.rejected");
      metrics?.increment("signing_skip_results_total", {
        result: "rejected", processRole: "api",
      });
      throw error;
    }

    request.log.info({
      event: "signing_skip.accepted",
      applied: result.applied,
    }, "signing_skip.accepted");
    metrics?.increment("signing_skip_results_total", {
      result: result.applied ? "accepted" : "converged", processRole: "api",
    });

    return reply.status(200).send(result);
  });
}
