// Password-reset tokens.
//
// ── Why a LINK token and not a typed code ──────────────────────────────────
//
// Email verification uses a 12-character typed code, because `VerifyEmail.tsx`
// presents a field the user types into. Password reset is the opposite: the
// product's `ResetPassword.tsx` is reached BY URL and shows a password form —
// there is no token input anywhere on it. The credential travels in the link.
//
// Nobody has to type this, so it is sized for security rather than for
// legibility: 32 bytes, base64url, matching the session-token convention
// already established in `crypto.ts` (§9).
//
// A reset token is strictly more dangerous than a verification code — it grants
// the account outright — so it gets more entropy and far less time.

import { randomBytes, createHash } from "node:crypto";
import type { ResetTokenDigest, ResetTokenFactory } from "@lagda/application";

/**
 * 32 bytes — 256 bits, base64url-encoded to 43 characters.
 *
 * Unguessable on its own, which is the requirement: rate limiting is defence in
 * depth and must never be the thing standing between an attacker and an account
 * (§56). The search space is not meaningfully reducible by any amount of
 * distributed guessing.
 */
const TOKEN_BYTES = 32;

/** What base64url encoding of 32 bytes always produces. */
const ENCODED_LENGTH = 43;

/**
 * The digest domain.
 *
 * `lagda.password-reset:` and nothing else. Without the prefix, a string that
 * happened to be both a valid session token and a valid reset token would
 * digest identically in both tables — and credential-purpose confusion is how a
 * flow that proves one thing becomes authority to do another (§8, INV-278).
 *
 * Verification uses `lagda.email-verify:`, sessions use their own. Three
 * domains, three namespaces, no overlap.
 */
const DIGEST_DOMAIN = "lagda.password-reset";

export function digestResetToken(token: string): ResetTokenDigest {
  return createHash("sha256")
    .update(`${DIGEST_DOMAIN}:${token}`)
    .digest("hex") as ResetTokenDigest;
}

/**
 * Structural validation, BEFORE any digest or lookup (§10).
 *
 * base64url only, exact length. An oversized or control-character-bearing
 * string is refused here rather than becoming a database round trip — and
 * because it is refused by shape, the value never has to be echoed anywhere to
 * explain why.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isWellFormedResetToken(raw: string): boolean {
  return raw.length === ENCODED_LENGTH && TOKEN_PATTERN.test(raw);
}

/**
 * Digests a SUBMITTED token, validating shape first.
 *
 * Returns null for anything that cannot be a token, so a malformed submission
 * never reaches a query and never reaches Argon2 (§53, §105).
 *
 * Note what is NOT here: no trimming, no case folding, no separator stripping.
 * A reset token is machine-handled from a URL, so every byte is significant —
 * unlike a verification code, which a human retypes.
 */
export function digestSubmittedResetToken(raw: string): ResetTokenDigest | null {
  return isWellFormedResetToken(raw) ? digestResetToken(raw) : null;
}

export function createResetTokenFactory(): ResetTokenFactory {
  return {
    issue() {
      // `randomBytes` is a CSPRNG. `Math.random()` is seeded and predictable,
      // and a predictable reset token is an account takeover for every user.
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      return {
        // The RAW token. It leaves here for delivery and is never stored,
        // never logged, and never placed in an error (§39, §45).
        raw,
        digest: digestResetToken(raw),
      };
    },
  };
}

/**
 * Builds the reset link.
 *
 * The base URL is CONFIGURATION. Never the incoming `Host`, never
 * `X-Forwarded-Host`, never a client-supplied return URL (§43, §89).
 *
 * A Host-derived link is the classic password-reset takeover: the attacker
 * submits a forgot-password request for a victim with a spoofed Host header,
 * and LAGDA itself emails the victim a link pointing at the attacker's domain.
 * The victim clicks, and hands over a credential that grants their account.
 * Taking the host from configuration makes that unreachable rather than
 * filtered (INV-284).
 *
 * The path matches the product's own route: `ResetPassword.tsx` lives at
 * `/reset-password` and reads its query string. No email in the URL — it would
 * add nothing the token does not already resolve, and would leak an address
 * into browser history and referrers (§44, §88).
 */
export function buildPasswordResetUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
