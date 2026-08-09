// Cryptographic adapters for session and CSRF secrets.
//
// `node:crypto` only. No `crypto-js`, no `forge`, no hand-rolled construction.

import { randomBytes, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type {
  CsrfToken, SecurityTokenDigester, SecurityTokenGenerator, SessionId,
  SessionToken, TokenDigest,
  IdempotencyKeyDigester, IdempotencyKeyDigest, IdempotencyRecordId,
  IdempotencyRecordIdGenerator, RequestFingerprint,
} from "@lagda/application";
import type { IdempotencyKey } from "@lagda/contracts";

/**
 * 32 bytes = **256 bits** of entropy, base64url-encoded to 43 characters.
 *
 * Stated as entropy, not length: "43 characters" says nothing about
 * guessability, and a 43-character timestamp would be worthless. 256 bits is
 * far beyond brute force, and the encoding is URL- and cookie-safe with no
 * padding to be mangled in transport.
 */
const TOKEN_BYTES = 32;

function randomToken(): string {
  // `randomBytes` is a CSPRNG. `Math.random()` is seeded, predictable, and has
  // been the root cause of real session-prediction vulnerabilities.
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function createSecurityTokenGenerator(): SecurityTokenGenerator {
  return {
    // Generated INDEPENDENTLY, never derived from one another. Deriving the
    // CSRF token from the session token would mean anyone who obtained the
    // readable CSRF token held a value related to the httpOnly session secret.
    nextSessionToken: () => randomToken() as SessionToken,
    nextCsrfToken: () => randomToken() as CsrfToken,
    // Not a secret — an internal handle that may appear in a log line or a
    // future account-security screen. Opaque, but it protects nothing.
    nextSessionId: () => `ses_${randomUUID().replace(/-/g, "")}` as SessionId,
  };
}

/**
 * Digesting for storage and lookup.
 *
 * **SHA-256, not Argon2.** Argon2 is deliberately slow to defend LOW-entropy
 * secrets — passwords — against offline guessing. A 256-bit random token has no
 * guessing attack to defend against, and a slow hash on the session-lookup path
 * would add work to every authenticated request for no security gain. Argon2
 * arrives with passwords in BACKEND-19.
 *
 * ── Domain separation ──────────────────────────────────────────────────────
 *
 * Each token type is prefixed before hashing. Without it, a session token and a
 * CSRF token that happened to be the same string would produce the same digest
 * — and since the CSRF token is readable by JavaScript by design, it could then
 * be submitted as a session cookie and match a stored session hash. The prefix
 * costs nothing and closes that entirely.
 */
export function createSecurityTokenDigester(): SecurityTokenDigester {
  const digest = (domain: string, token: string): TokenDigest =>
    createHash("sha256").update(`${domain}:${token}`).digest("hex") as TokenDigest;

  return {
    digestSessionToken: (token) => digest("lagda.session", token),
    digestCsrfToken: (token) => digest("lagda.csrf", token),

    /**
     * Timing-safe comparison.
     *
     * `===` on strings short-circuits at the first differing byte, leaking a
     * measurable signal about how much of a guess was correct. Both values here
     * are already digests of the same fixed length, so the length check below
     * cannot itself leak anything useful.
     */
    matches: (a: TokenDigest, b: TokenDigest): boolean => {
      const left = Buffer.from(a, "utf8");
      const right = Buffer.from(b, "utf8");
      if (left.length !== right.length) return false;
      return timingSafeEqual(left, right);
    },
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Digests for idempotency.
 *
 * Two DIFFERENT things, and conflating them would be a real bug:
 *
 *   keyDigest    identifies WHICH operation a retry belongs to
 *   fingerprint  identifies WHAT the caller asked for
 *
 * Domain-separated from each other and from session digests, so no value can
 * be compared meaningfully across domains.
 *
 * SHA-256, not Argon2 — the same reasoning as session tokens. These are lookup
 * keys, and a slow hash would tax every protected mutation for no benefit.
 */
export function createIdempotencyKeyDigester(): IdempotencyKeyDigester {
  return {
    digestKey: (key: IdempotencyKey): IdempotencyKeyDigest =>
      createHash("sha256").update(`lagda.idem.key:${key}`)
        .digest("hex") as IdempotencyKeyDigest,

    fingerprint: (canonical: string): RequestFingerprint =>
      createHash("sha256").update(`lagda.idem.request:${canonical}`)
        .digest("hex") as RequestFingerprint,
  };
}

export function createIdempotencyRecordIdGenerator(): IdempotencyRecordIdGenerator {
  return {
    // Opaque and internal. Safe in a log line, unlike the key it stands for.
    nextIdempotencyRecordId: () =>
      `idem_${randomUUID().replace(/-/g, "")}` as IdempotencyRecordId,
  };
}
