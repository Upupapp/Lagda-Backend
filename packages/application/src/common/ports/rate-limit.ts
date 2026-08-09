// Abuse controls.
//
// **Defence in depth, never a substitute** for authentication, authorization,
// tenancy, CSRF or idempotency. A rate limit answers "too much, too fast"; it
// answers nothing about who you are or what you may touch.

import type { WorkspaceId, UserId } from "@lagda/contracts";

/**
 * What a limit is counted against.
 *
 * A discriminated union, because one operation legitimately needs several. A
 * single per-IP counter is defeated by an office NAT on one side (thousands of
 * users share an address) and by an attacker rotating addresses on the other —
 * layering IP with a semantic identity covers both.
 *
 * Each variant's identifier must come from TRUSTED context: the observed
 * connection, the resolved session, the authorized workspace. Never a body
 * field, or an attacker chooses which bucket to fill.
 */
export type RateLimitScope =
  /** Observed connection address. Only as trustworthy as the proxy config. */
  | { readonly type: "ip"; readonly ipAddress: string }
  /** From the resolved session (BACKEND-13), never from a body. */
  | { readonly type: "user"; readonly userId: UserId }
  /** From authorized workspace context, never from a body. */
  | { readonly type: "workspace"; readonly workspaceId: WorkspaceId }
  /**
   * A PRE-AUTHENTICATION identity — a normalized email, say.
   *
   * An abuse bucket only. It is unauthenticated and self-declared, so it must
   * never be treated as identity, and it is digested before storage.
   */
  | { readonly type: "account"; readonly accountKey: string }
  /** A validated signing-access context (BACKEND-34), never an email. */
  | { readonly type: "recipient"; readonly recipientId: string }
  /** An OTP or verification challenge (BACKEND-23). */
  | { readonly type: "challenge"; readonly challengeId: string };

export type RateLimitScopeType = RateLimitScope["type"];

/**
 * What happens when the counter store itself is unavailable.
 *
 * Not one global answer, because the right answer differs by what is being
 * protected. Refusing every sign-in during a database blip is an outage;
 * allowing unlimited password guesses during one is a vulnerability.
 *
 * In practice PostgreSQL is already required by the operations these policies
 * guard, so a limiter outage usually coincides with the operation failing
 * anyway — but the classification has to be explicit rather than assumed.
 */
export type FailureMode = "fail-closed" | "fail-open";

export interface RateLimitPolicy {
  /** Stable and code-defined. Never a route path — routes get renamed. */
  readonly id: string;
  readonly scopeType: RateLimitScopeType;
  readonly limit: number;
  readonly windowMs: number;
  readonly failureMode: FailureMode;
  /** Where the number came from, so nobody "tidies" a specified value away. */
  readonly source: string;
}

export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number; readonly resetAt: number }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
      readonly resetAt: number;
      /** For telemetry only. Never returned to a client. */
      readonly policyId: string;
    };

export interface RateLimitCheck {
  readonly policy: RateLimitPolicy;
  readonly scope: RateLimitScope;
}

/**
 * Durable counters.
 *
 * PostgreSQL, not process memory: a counter in one Node process makes "5
 * attempts per minute" mean "5 per instance per minute", and for a brute-force
 * control that is the control failing rather than a rounding error.
 */
export interface RateLimitCounterRepository {
  /**
   * Atomically increments and returns the new count.
   *
   * One statement. A read followed by a write is a race two processes both
   * lose, and losing it here means granting extra attempts to whoever is
   * attacking.
   */
  increment(input: {
    readonly policyId: string;
    readonly scopeType: RateLimitScopeType;
    readonly scopeKey: string;
    readonly windowStart: number;
    readonly expiresAt: number;
  }): Promise<number>;

  deleteExpired(before: number, limit: number): Promise<number>;
}

/** Digests the scope values that are personal data. */
export interface RateLimitScopeDigester {
  digest(scope: RateLimitScope): string;
}

export interface AbuseLimiter {
  /**
   * Evaluates every applicable policy.
   *
   * All must allow. The FIRST rejection is returned, so a caller learns it was
   * refused without learning how many other limits it was near.
   */
  check(checks: readonly RateLimitCheck[]): Promise<RateLimitDecision>;
}
