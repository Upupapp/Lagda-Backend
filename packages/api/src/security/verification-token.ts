// Email verification tokens.
//
// Built on the same CSPRNG and the same digest discipline as sessions
// (BACKEND-13), with its OWN domain prefix.
//
// ── Why the domain prefix matters ──────────────────────────────────────────
//
// Without it, a verification token and a session token that happened to be the
// same string would produce the same digest — and a token minted to prove
// mailbox ownership could then be presented as a session cookie and match a
// stored session. The prefix costs nothing and makes the credentials
// structurally non-interchangeable (INV-239).

import { randomBytes, createHash } from "node:crypto";
import type {
  VerificationTokenDigest, VerificationTokenFactory,
} from "@lagda/application";

/**
 * 32 bytes of CSPRNG output.
 *
 * 256 bits, so the token is not guessable and needs no rate limit of its own to
 * be safe against brute force — which is why the digest below is SHA-256 rather
 * than Argon2id. Argon2 defends LOW-entropy secrets against offline guessing; a
 * random 256-bit token has no guessing attack to defend against, and a slow
 * hash on the redemption path would buy nothing.
 *
 * `randomBytes`, never `Math.random()`, which is seeded and predictable.
 */
const TOKEN_BYTES = 32;

/** URL-safe, because this token travels in a verification link. */
const encode = (bytes: Buffer): string => bytes.toString("base64url");

export function createVerificationTokenFactory(): VerificationTokenFactory {
  return {
    issue() {
      const raw = encode(randomBytes(TOKEN_BYTES));
      return {
        // The RAW token. It leaves here, goes into a verification link, and is
        // never stored or logged.
        raw,
        digest: createHash("sha256")
          .update(`lagda.email-verify:${raw}`)
          .digest("hex") as VerificationTokenDigest,
      };
    },
  };
}

/**
 * Digests a token presented for redemption.
 *
 * Exported for BACKEND-21, which will look a challenge up by digest. Kept
 * beside `issue` so the two can never use different prefixes — the failure
 * where every token silently stops matching.
 */
export function digestVerificationToken(raw: string): VerificationTokenDigest {
  return createHash("sha256")
    .update(`lagda.email-verify:${raw}`)
    .digest("hex") as VerificationTokenDigest;
}

/**
 * Builds the verification link.
 *
 * The base URL is CONFIGURATION, never the incoming `Host` header. A link built
 * from an attacker-supplied Host would send the user's verification token to an
 * attacker's domain — BACKEND-11 banned Host-derived URLs for exactly this
 * (INV-244).
 *
 * The route is `/verify-email`, which is the real frontend route, and the token
 * is URL-encoded.
 */
export function buildVerificationUrl(baseUrl: string, rawToken: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/verify-email?token=${encodeURIComponent(rawToken)}`;
}
