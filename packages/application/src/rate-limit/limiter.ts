// Evaluating rate-limit policies.

import type {
  AbuseLimiter, RateLimitCheck, RateLimitCounterRepository, RateLimitDecision,
  RateLimitScopeDigester,
} from "../common/ports/rate-limit.js";
import type { Clock } from "../common/ports/index.js";
import { ApplicationError } from "../common/errors/index.js";

/** Too many requests. Maps to 429. */
export class RateLimitedError extends ApplicationError {
  readonly category = "rate-limit" as const;
  readonly code = "rate_limited";

  constructor(readonly retryAfterSeconds: number) {
    // Deliberately says nothing about which policy fired, how many attempts
    // remain, or whether an account exists. "2 attempts left" is a gift to an
    // attacker, and a policy name tells them which dimension to rotate.
    super("Too many requests. Please retry later.");
  }
}

/**
 * The counter store is unavailable AND the policy fails closed.
 *
 * A distinct error from `RateLimitedError` so a caller is never told "slow
 * down" when the truth is "the limiter is broken" — and so this maps to 503
 * rather than 429.
 */
export class AbuseControlUnavailableError extends ApplicationError {
  readonly category = "dependency-unavailable" as const;
  readonly code = "dependency_unavailable";

  constructor() {
    super("A security control is temporarily unavailable. Please retry later.");
  }
}

export interface LimiterDependencies {
  readonly counters: RateLimitCounterRepository;
  readonly digester: RateLimitScopeDigester;
  readonly clock: Clock;
  /** Notified on every decision. Telemetry must not be able to fail the check. */
  readonly onDecision?: (event: {
    policyId: string; scopeType: string; allowed: boolean;
  }) => void;
}

/**
 * The fixed-window start for a timestamp.
 *
 * Derived arithmetically, so the counter's identity is computable without
 * reading anything first — which is what allows the whole check to be one
 * atomic statement.
 */
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export function createAbuseLimiter(deps: LimiterDependencies): AbuseLimiter {
  const { counters, digester, clock, onDecision } = deps;

  return {
    async check(checks: readonly RateLimitCheck[]): Promise<RateLimitDecision> {
      const now = clock.now();
      let mostRemaining = Number.POSITIVE_INFINITY;
      let earliestReset = now;

      for (const { policy, scope } of checks) {
        if (policy.scopeType !== scope.type) {
          // A mismatch means a caller wired the wrong scope to a policy —
          // counting IPs against a per-user limit, say. Failing loudly beats
          // enforcing something nobody intended.
          throw new Error(
            `Policy ${policy.id} expects a ${policy.scopeType} scope, got ${scope.type}.`,
          );
        }

        const windowStart = windowStartFor(now, policy.windowMs);
        const resetAt = windowStart + policy.windowMs;

        let count: number;
        try {
          count = await counters.increment({
            policyId: policy.id,
            scopeType: scope.type,
            scopeKey: digester.digest(scope),
            windowStart,
            // Kept a full window past the reset so a cleanup job that runs late
            // cannot delete a counter that is still authoritative.
            expiresAt: resetAt + policy.windowMs,
          });
        } catch {
          // The store is unavailable. What that means depends on WHAT is being
          // protected, which is why the policy carries the answer rather than
          // one global assumption.
          if (policy.failureMode === "fail-closed") {
            throw new AbuseControlUnavailableError();
          }
          // fail-open: a volumetric ceiling being briefly absent is a smaller
          // harm than an outage. Continue to the next policy.
          continue;
        }

        // The rejected attempt is COUNTED. An attacker who stops being counted
        // once they are blocked can hammer the endpoint for free, and the spike
        // that reveals the attack disappears from the metrics.
        if (count > policy.limit) {
          onDecision?.({ policyId: policy.id, scopeType: scope.type, allowed: false });
          return {
            allowed: false,
            // Rounded UP, so a client that obeys it never returns while still
            // blocked and burns another attempt.
            retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
            resetAt,
            policyId: policy.id,
          };
        }

        onDecision?.({ policyId: policy.id, scopeType: scope.type, allowed: true });
        mostRemaining = Math.min(mostRemaining, policy.limit - count);
        earliestReset = Math.max(earliestReset, resetAt);
      }

      return {
        allowed: true,
        remaining: Number.isFinite(mostRemaining) ? mostRemaining : 0,
        resetAt: earliestReset,
      };
    },
  };
}
