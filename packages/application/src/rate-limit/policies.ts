// The policy registry.
//
// Every threshold here is SOURCED from the integration handoff. None is
// invented: where the handoff is silent, the policy is absent and the feature
// command owns it, because a number nobody chose is a number nobody can defend
// when it blocks a customer.
//
// Thresholds live here rather than in route handlers so that changing a
// security limit is one reviewable edit, not a search.

import type { RateLimitPolicy } from "../common/ports/rate-limit.js";

const MINUTE = 60_000;

/**
 * Handoff §317: "Rate limiting on: sign-in (5/min), OTP delivery (3/10min),
 * verification (20/min), all write endpoints (100/min per user)".
 * Handoff §145: OTP "rate-limited (5 attempts / 15 minutes)".
 * Handoff §583: search 120/min, commands 60/min per authenticated user.
 */
export const RATE_LIMIT_POLICIES = {
  // ── Authentication (BACKEND-20) ───────────────────────────────────────────
  //
  // TWO policies, not one. Per-IP alone is defeated by an attacker rotating
  // addresses; per-account alone is defeated by spraying one password across
  // many accounts from one host. Together they cover both.
  //
  // fail-closed: unlimited password guessing during a database blip is worse
  // than refusing sign-in during one.
  "auth.signin.ip": {
    id: "auth.signin.ip",
    scopeType: "ip",
    limit: 5,
    windowMs: MINUTE,
    failureMode: "fail-closed",
    source: "handoff §317 — sign-in 5/min",
  },
  "auth.signin.account": {
    id: "auth.signin.account",
    scopeType: "account",
    limit: 5,
    windowMs: MINUTE,
    failureMode: "fail-closed",
    // The same threshold applied to a second dimension. The handoff gives one
    // number; applying it per account as well is a strictly tighter reading,
    // not an invented value.
    source: "handoff §317 — sign-in 5/min, applied per account identity",
  },

  // ── OTP (BACKEND-23) ──────────────────────────────────────────────────────
  //
  // Issuance and verification are DIFFERENT abuse problems and get different
  // policies. Issuance abuse costs money and spams a recipient; verification
  // abuse brute-forces a six-digit space where 5 attempts in 15 minutes is the
  // difference between infeasible and trivial.
  "otp.deliver.account": {
    id: "otp.deliver.account",
    scopeType: "account",
    limit: 3,
    windowMs: 10 * MINUTE,
    failureMode: "fail-closed",
    source: "handoff §317 — OTP delivery 3/10min",
  },
  "otp.verify.challenge": {
    id: "otp.verify.challenge",
    scopeType: "challenge",
    limit: 5,
    windowMs: 15 * MINUTE,
    failureMode: "fail-closed",
    source: "handoff §145 — OTP 5 attempts / 15 minutes",
  },

  // ── Public verification (BACKEND-42) ──────────────────────────────────────
  //
  // Scoped by IP, not by verification ID: an attacker enumerating IDs presents
  // a different ID every time, so a per-ID counter would never reach its
  // threshold. Defence in depth — the IDs are unguessable already.
  //
  // fail-open: an unauthenticated public lookup being briefly unlimited is a
  // smaller harm than the verification page being down.
  "verification.public.ip": {
    id: "verification.public.ip",
    scopeType: "ip",
    limit: 20,
    windowMs: MINUTE,
    failureMode: "fail-open",
    source: "handoff §317 — verification 20/min",
  },

  // ── General authenticated write ───────────────────────────────────────────
  //
  // A volumetric ceiling against runaway clients, not a feature security
  // control. Deliberately generous: set too low it breaks a document editor
  // doing legitimate work.
  // ── Registration ────────────────────────────────────────────────────────
  //
  // The handoff specifies limits for sign-in, OTP and verification but NOT for
  // registration (§317). Rather than leave account creation unlimited, these
  // are chosen here and marked as chosen - the `source` says so plainly, so a
  // reader can tell a measured threshold from a judged one.
  //
  // Registration is the most expensive unauthenticated operation LAGDA has: it
  // costs an Argon2id hash, which is memory-hard BY DESIGN. Limiting it is what
  // keeps that cost from becoming a denial-of-service primitive (INV-234).
  "auth.register.ip": {
    id: "auth.register.ip",
    scopeType: "ip",
    limit: 5,
    windowMs: 10 * MINUTE,
    // Fail closed: unlimited account creation during a database blip is worse
    // than refusing registration during one.
    failureMode: "fail-closed",
    source: "BACKEND-19 - not specified by the handoff; chosen to bound Argon2id "
      + "cost and mass account creation. Subject to product review (OD-064).",
  },
  "auth.register.account": {
    id: "auth.register.account",
    scopeType: "account",
    limit: 3,
    windowMs: 10 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-19 - not specified by the handoff; bounds repeated attempts "
      + "against one email identity. Subject to product review (OD-064).",
  },

  "api.write.user": {
    id: "api.write.user",
    scopeType: "user",
    limit: 100,
    windowMs: MINUTE,
    failureMode: "fail-open",
    source: "handoff §317 — all write endpoints 100/min per user",
  },

  // ── Search and commands (BACKEND-48) ──────────────────────────────────────
  "search.query.user": {
    id: "search.query.user",
    scopeType: "user",
    limit: 120,
    windowMs: MINUTE,
    failureMode: "fail-open",
    source: "handoff §583 — search 120 requests/minute per user",
  },
  "commands.execute.user": {
    id: "commands.execute.user",
    scopeType: "user",
    limit: 60,
    windowMs: MINUTE,
    failureMode: "fail-open",
    source: "handoff §583 — commands 60 requests/minute per user",
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyId = keyof typeof RATE_LIMIT_POLICIES;

/**
 * Resolves a policy by ID.
 *
 * Throws on an unknown ID rather than skipping the check. A silent skip is a
 * disabled security control that looks enabled — the failure mode this whole
 * registry exists to make impossible.
 */
export function policyById(id: RateLimitPolicyId): RateLimitPolicy {
  const policy: RateLimitPolicy | undefined = RATE_LIMIT_POLICIES[id];
  if (policy === undefined) {
    throw new Error(`Unknown rate-limit policy: ${id}`);
  }
  return policy;
}

/**
 * Validates the registry at startup.
 *
 * Catches a zero or negative limit, which would mean "block everything" or
 * "allow everything" depending on the comparison — and a config that silently
 * disables a mandatory control is worse than one that fails to boot.
 */
export function assertPoliciesValid(
  policies: Record<string, RateLimitPolicy> = RATE_LIMIT_POLICIES,
): void {
  for (const [key, policy] of Object.entries(policies)) {
    if (policy.id !== key) {
      throw new Error(`Rate-limit policy ${key} declares a mismatched id ${policy.id}.`);
    }
    if (!Number.isInteger(policy.limit) || policy.limit < 1) {
      throw new Error(
        `Rate-limit policy ${key} must allow at least one request. `
        + "A limit of 0 silently disables the operation it protects.",
      );
    }
    if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1000) {
      throw new Error(`Rate-limit policy ${key} needs a window of at least one second.`);
    }
    if (policy.source.trim() === "") {
      // Every threshold must be traceable. An unsourced number is one nobody
      // can defend when it starts blocking customers.
      throw new Error(`Rate-limit policy ${key} must record where its threshold came from.`);
    }
  }
}
