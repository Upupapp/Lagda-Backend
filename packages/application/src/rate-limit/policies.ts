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

  // ── Email verification ──────────────────────────────────────────────────
  //
  // Two different risks, two different scopes.
  //
  // Redeeming a code is cheap and the credential carries 60 bits of entropy, so
  // the limit here is VOLUMETRIC - it bounds someone submitting random codes at
  // scale rather than being what makes the code safe (§10, §55).
  "verification.redeem.ip": {
    id: "verification.redeem.ip",
    scopeType: "ip",
    limit: 20,
    windowMs: MINUTE,
    failureMode: "fail-closed",
    source: "handoff §317 - verification 20/min, applied to email-verification "
      + "code redemption.",
  },

  // Resend TRIGGERS OUTBOUND EMAIL, which makes it an email-bombing tool if
  // left open. Both scopes are required: per-account stops one address being
  // buried, per-IP stops one source doing it to many addresses at once (§154).
  //
  // Deliberately layered rather than aggressive on one axis: a shared office
  // NAT must not make verification unusable for everyone behind it (§155).
  "verification.resend.account": {
    id: "verification.resend.account",
    scopeType: "account",
    limit: 3,
    windowMs: 10 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-21 - not specified by the handoff. Chosen to match OTP "
      + "delivery (handoff §317, 3/10min), which carries the same "
      + "outbound-email risk. The frontend's 30-second cooldown sits inside it.",
  },
  "verification.resend.ip": {
    id: "verification.resend.ip",
    scopeType: "ip",
    limit: 10,
    windowMs: 10 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-21 - not specified by the handoff. Bounds one source "
      + "triggering mail to many addresses; deliberately higher than the "
      + "per-account limit so a shared office NAT stays usable.",
  },

  // ── Password recovery (BACKEND-22) ──────────────────────────────────────
  //
  // Requesting a reset TRIGGERS OUTBOUND EMAIL to an address the caller does
  // not have to prove anything about, which makes an unlimited endpoint a
  // mailbox-flooding tool aimed at any user by name (§27).
  //
  // The per-account limit is TIGHTER than verification resend. The reason is
  // the payload: a verification code proves an address; a reset link GRANTS THE
  // ACCOUNT. Every additional one sitting in a mailbox is another chance for
  // the most dangerous credential in the system to be read by the wrong person.
  //
  // The account scope is keyed on the NORMALIZED address and is applied to
  // unknown addresses too — otherwise "unlimited attempts" versus "limited
  // attempts" is itself an account-existence oracle, and the whole
  // anti-enumeration design leaks through the limiter (§28, §188).
  "auth.reset.request.account": {
    id: "auth.reset.request.account",
    scopeType: "account",
    limit: 3,
    windowMs: 15 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-22 - not specified by the handoff. Chosen below the OTP "
      + "delivery rate (handoff §317, 3/10min) because a reset link is a "
      + "higher-value secret than a one-time code; three genuine attempts in "
      + "fifteen minutes covers a user who mistypes their address twice.",
  },
  "auth.reset.request.ip": {
    id: "auth.reset.request.ip",
    scopeType: "ip",
    limit: 10,
    windowMs: 15 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-22 - not specified by the handoff. Bounds one source "
      + "triggering reset mail to many addresses; higher than the per-account "
      + "limit so a shared NAT does not lock out everyone behind it.",
  },

  // Submitting a reset token is bounded because it costs ARGON2 - roughly 50ms
  // of dedicated CPU and 19MB per attempt. Unbounded, that is a
  // one-request-per-core denial of service against an unauthenticated endpoint,
  // which is a bigger risk here than guessing: the token carries 256 bits and
  // is not brute-forceable at any rate (§54, §56, §107).
  "auth.reset.submit.ip": {
    id: "auth.reset.submit.ip",
    scopeType: "ip",
    limit: 10,
    windowMs: MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-22 - not specified by the handoff. Sized against Argon2 "
      + "cost rather than guessing risk: ten hashes per minute per address is "
      + "far above any real user and far below what saturates a core.",
  },

  // ── MFA (BACKEND-23) ────────────────────────────────────────────────────
  //
  // The REAL brute-force bound on a 6-digit code is the per-ceremony attempt
  // counter (5, durable, atomic), not these. A rate limiter is per IP or per
  // account; the attempt counter is per LOGIN CEREMONY, which is what an
  // attacker actually has to defeat and what they cannot spread across
  // addresses (§70, §77).
  //
  // These bound VOLUME on top of that: an attacker who has stolen a password
  // and is starting ceremony after ceremony to get five fresh guesses each time.
  "mfa.verify.ip": {
    id: "mfa.verify.ip",
    scopeType: "ip",
    limit: 20,
    windowMs: 15 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-23 - handoff §145 gives OTP verification 5 attempts / "
      + "15 minutes, which is implemented as the durable per-ceremony counter. "
      + "This IP policy is chosen at 4x that, so a household behind one address "
      + "can retry legitimately while bulk guessing is bounded.",
  },
  // Enrolment and disable are authenticated settings mutations. Low limits
  // because a human does each of them roughly once, ever.
  "mfa.enroll.user": {
    id: "mfa.enroll.user",
    scopeType: "user",
    limit: 5,
    windowMs: 15 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-23 - not specified by the handoff. Chosen: restarting "
      + "setup a few times is normal, doing it continuously is not.",
  },
  // Tighter than enrolment. Each attempt costs an Argon2 verification, and the
  // action removes a security control — the two reasons to be strict.
  "mfa.disable.user": {
    id: "mfa.disable.user",
    scopeType: "user",
    limit: 5,
    windowMs: MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-23 - not specified by the handoff. Chosen to match "
      + "sign-in (handoff §317, 5/min): both verify a password and both are "
      + "worth guessing against.",
  },

  // ── Workspace lifecycle (BACKEND-25) ────────────────────────────────────
  //
  // Creation is cheap per call and expensive in aggregate: each one is a
  // permanent tenant row, a permanent membership row, and — once documents
  // exist — a namespace nothing in the system can currently delete. There is no
  // erasure endpoint until BACKEND-55, so an unlimited create endpoint produces
  // rows that accumulate forever and that support has no tool to remove.
  //
  // Scoped to `user` rather than `ip`: the endpoint is authenticated, so there
  // is always a real identity to count against, and an IP counter would punish
  // an office NAT for one runaway client. Registration already bounds how many
  // identities an address can obtain.
  //
  // fail-CLOSED. Refusing workspace creation during a database blip is a
  // recoverable annoyance; creating unlimited permanent tenants during one is
  // not, precisely because nothing can undo it.
  "workspace.create.user": {
    id: "workspace.create.user",
    scopeType: "user",
    limit: 10,
    windowMs: 60 * MINUTE,
    failureMode: "fail-closed",
    source: "BACKEND-25 - not specified by the handoff. Chosen: a person setting "
      + "up several organizations in one sitting is plausible, ten per hour "
      + "forever is not. Deliberately NOT a product entitlement - plan limits "
      + "are BACKEND-50 (OD-090).",
  },

  // A metadata rename. Bounded only to stop a loop hammering the table; a
  // legitimate user renames a workspace roughly never.
  //
  // fail-OPEN, unlike create: a failed rename changes nothing permanent, so
  // refusing renames during a limiter outage costs more than it protects.
  "workspace.update.user": {
    id: "workspace.update.user",
    scopeType: "user",
    limit: 30,
    windowMs: MINUTE,
    failureMode: "fail-open",
    source: "BACKEND-25 - not specified by the handoff. Sits under the general "
      + "authenticated write ceiling (handoff §317, 100/min) because a rename "
      + "is rarer than an ordinary write.",
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
