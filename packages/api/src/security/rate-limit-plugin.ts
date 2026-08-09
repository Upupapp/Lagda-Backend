// Rate limiting at the HTTP boundary.
//
// ── Where this sits in the pipeline ────────────────────────────────────────
//
//   rate limit → authenticate → CSRF → authorize → validate → idempotency → mutation
//
// Rate limiting is FIRST for the cheap volumetric scopes, because everything
// after it costs something an attacker would otherwise get for free — a session
// lookup, an Argon2 verification, a transaction, an idempotency claim.
//
// Semantic scopes (user, workspace) necessarily run AFTER authentication,
// because there is no user to count against until one is resolved. Both layers
// are the same limiter and the same counters; only the position differs.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AbuseLimiter, RateLimitCheck, RateLimitScope, RateLimitScopeDigester,
} from "@lagda/application";
import { RateLimitedError, policyById, type RateLimitPolicyId } from "@lagda/application";
import type { MetricsRecorder } from "../observability/metrics.js";
import { normalizeRoute } from "../observability/metrics.js";

/**
 * Digests the scope values that are personal data.
 *
 * An IP address and an email are personal data, and a counter table has no
 * need to hold them reversibly — it only ever compares. `user` and `workspace`
 * stay plain: they are already operational identifiers elsewhere, and hashing
 * them would block an investigation for no privacy gain.
 *
 * Domain-separated per scope type, so a user ID that happened to equal a
 * challenge ID cannot share a counter.
 */
export function createRateLimitScopeDigester(): RateLimitScopeDigester {
  const digest = (domain: string, value: string): string =>
    createHash("sha256").update(`lagda.ratelimit.${domain}:${value}`).digest("hex");

  return {
    digest(scope: RateLimitScope): string {
      switch (scope.type) {
        case "ip": return digest("ip", scope.ipAddress);
        // Normalized to lower case first: an attacker alternating the case of
        // an email would otherwise get a fresh counter for each variant.
        case "account": return digest("account", scope.accountKey.toLowerCase());
        case "challenge": return digest("challenge", scope.challengeId);
        case "recipient": return digest("recipient", scope.recipientId);
        case "user": return scope.userId;
        case "workspace": return scope.workspaceId;
      }
    },
  };
}

export interface RateLimitOptions {
  readonly limiter: AbuseLimiter;
  readonly metrics: MetricsRecorder;
}

/**
 * Applies IP-scoped policies to every route in the enclosing scope.
 *
 * A plain function called on the scope, NOT a plugin — the same reason
 * `requireSession` is. A plugin registered with `scope.register()` gets its own
 * encapsulation context and its hooks apply to nothing, which is a security
 * control that looks present and protects zero routes.
 */
export function applyIpRateLimit(
  app: FastifyInstance,
  policyIds: readonly RateLimitPolicyId[],
  options: RateLimitOptions,
): void {
  const { limiter, metrics } = options;

  app.addHook("onRequest", async (request, reply) => {
    // A CORS preflight carries no credentials and does no work. Counting it
    // would halve every browser client's usable limit, since a preflight
    // precedes each non-simple mutation.
    if (request.method === "OPTIONS") return;

    const ipAddress = request.ip;
    if (typeof ipAddress !== "string" || ipAddress === "") return;

    // `request.ip` is Fastify's proxy-aware resolution, governed by
    // TRUST_PROXY. With the default (trust nothing) a spoofed
    // `X-Forwarded-For` cannot select a bucket — this code never reads that
    // header itself.
    const scope: RateLimitScope = { type: "ip", ipAddress };
    const checks: RateLimitCheck[] = policyIds.map(id => ({ policy: policyById(id), scope }));

    const decision = await limiter.check(checks);
    if (decision.allowed) return;

    const route = normalizeRoute(request.routeOptions.url, request.url);
    metrics.increment("rate_limit_rejections_total", {
      policy: decision.policyId, route, processRole: "api",
    });
    // The POLICY and the route — both bounded, code-defined values. Never the
    // IP, never the digest, never the count.
    request.log.info(
      {
        event: "security.rate_limit_triggered",
        securityEvent: "rate_limit_triggered",
        policy: decision.policyId, route, method: request.method, result: "rejected",
      },
      "rate limit exceeded",
    );

    // Set here rather than in the error handler: the canonical envelope has no
    // field for it, and it is transport metadata rather than part of the error.
    void reply.header("Retry-After", String(decision.retryAfterSeconds));
    throw new RateLimitedError(decision.retryAfterSeconds);
  });
}

/**
 * Checks semantic scopes once an actor is resolved.
 *
 * Called from a handler or a later hook, never from `onRequest` — there is no
 * user to count against until authentication has run.
 */
export async function checkSemanticLimits(
  request: FastifyRequest,
  checks: readonly RateLimitCheck[],
  options: RateLimitOptions,
): Promise<void> {
  if (checks.length === 0) return;

  const decision = await options.limiter.check(checks);
  if (decision.allowed) return;

  const route = normalizeRoute(request.routeOptions.url, request.url);
  options.metrics.increment("rate_limit_rejections_total", {
    policy: decision.policyId, route, processRole: "api",
  });
  request.log.info(
    {
      event: "security.rate_limit_triggered",
      securityEvent: "rate_limit_triggered",
      policy: decision.policyId, route, result: "rejected",
    },
    "rate limit exceeded",
  );

  throw new RateLimitedError(decision.retryAfterSeconds);
}
