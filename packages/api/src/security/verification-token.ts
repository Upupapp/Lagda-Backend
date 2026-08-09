// Email verification codes.
//
// ── Why a typed CODE and not a link token ──────────────────────────────────
//
// BACKEND-19 generated a 43-character base64url token for a click-through link.
// The product does not work that way: `VerifyEmail.tsx` presents an input the
// user TYPES into, and the auth service takes `verifyEmail(code)`. Nobody types
// 43 characters of base64url.
//
// So the credential is a 12-character Crockford base32 code — typeable, and
// still unguessable. Everything else BACKEND-19 established is unchanged: the
// raw value is never stored, only a domain-separated SHA-256 digest is, and the
// challenge carries expiry, single-use and supersession.
//
// A code can still travel in a link when delivery exists; a link token could
// never be typed. See ADR-015.

import { randomBytes, createHash } from "node:crypto";
import type {
  VerificationTokenDigest, VerificationTokenFactory,
} from "@lagda/application";

/**
 * Crockford base32.
 *
 * `I`, `L`, `O` and `U` are absent: the first three are visually confusable
 * with `1` and `0` when read off a screen and typed, and `U` is excluded to
 * avoid accidental obscenities in generated codes. A user reading a code aloud
 * or copying it by hand is the actual use case, so the alphabet is chosen for
 * that rather than for density.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 12 characters — 32^12, or 60 bits.
 *
 * Unguessable ON ITS OWN, which is the requirement: rate limiting is defence in
 * depth and must not be what makes the credential safe. At a thoroughly
 * unrealistic 10 000 guesses per second, exhausting even 0.1% of the space
 * takes over three thousand years.
 *
 * Shorter would have been friendlier and wrong. 8 characters is 40 bits, which
 * a determined attacker with a botnet could search once rate limits are
 * distributed across enough addresses.
 */
const CODE_LENGTH = 12;

/** Displayed as `XXXX-XXXX-XXXX`. Grouping is presentation only. */
const GROUP_SIZE = 4;

/**
 * Generates a code with UNBIASED character selection.
 *
 * `randomBytes(n) % 32` would be biased for an alphabet whose size does not
 * divide 256 — it happens not to be here, since 256 is a multiple of 32, but
 * rejection sampling is written explicitly so the property survives someone
 * changing the alphabet length later. A biased credential is a weaker
 * credential in a way that is invisible in testing.
 */
function generateCode(): string {
  const characters: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

  while (characters.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      characters.push(ALPHABET[byte % ALPHABET.length] ?? "0");
      if (characters.length === CODE_LENGTH) break;
    }
  }
  return characters.join("");
}

/** `K7QM2X9FP4TB` → `K7QM-2X9F-P4TB`. */
export function formatVerificationCode(code: string): string {
  const groups: string[] = [];
  for (let at = 0; at < code.length; at += GROUP_SIZE) {
    groups.push(code.slice(at, at + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Canonicalizes what a user typed, before digesting.
 *
 * A person copying a code from an email will introduce spaces, hyphens, lower
 * case, and the classic `O`/`0` and `I`/`1` substitutions. Accepting those is
 * not weakening the credential — the canonical form is what is digested, and
 * every accepted variant maps to exactly one canonical value, so the search
 * space is unchanged.
 *
 * This is the ONE place input is normalized, so a mismatch between issuing and
 * redeeming is impossible.
 */
export function canonicalizeVerificationCode(raw: string): string | null {
  const stripped = raw
    .replace(/[\s-]/g, "")
    .toLocaleUpperCase("en-US")
    // Crockford's documented confusion mappings.
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

  if (stripped.length !== CODE_LENGTH) return null;
  for (const character of stripped) {
    if (!ALPHABET.includes(character)) return null;
  }
  return stripped;
}

/**
 * Digests a canonical code.
 *
 * SHA-256, not Argon2id: 60 bits of uniform randomness has no guessing attack
 * for a slow hash to defend against, and redemption happens on a request path.
 *
 * The `lagda.email-verify:` prefix is DOMAIN SEPARATION. Without it, a
 * verification code and a session token that happened to be the same string
 * would digest identically — and a credential minted to prove mailbox ownership
 * could then be presented as a session (INV-239).
 */
export function digestVerificationCode(canonical: string): VerificationTokenDigest {
  return createHash("sha256")
    .update(`lagda.email-verify:${canonical}`)
    .digest("hex") as VerificationTokenDigest;
}

export function createVerificationTokenFactory(): VerificationTokenFactory {
  return {
    issue() {
      const canonical = generateCode();
      return {
        // The RAW code, grouped for a human to read. It leaves here for
        // delivery and is never stored or logged.
        raw: formatVerificationCode(canonical),
        digest: digestVerificationCode(canonical),
      };
    },
  };
}

/**
 * Digests a code as SUBMITTED, canonicalizing first.
 *
 * Returns null for anything that cannot be a code, so a malformed submission is
 * rejected without a database lookup (§9, §61).
 */
export function digestSubmittedCode(raw: string): VerificationTokenDigest | null {
  const canonical = canonicalizeVerificationCode(raw);
  return canonical === null ? null : digestVerificationCode(canonical);
}

/**
 * Builds a verification link, for when delivery exists.
 *
 * The base URL is CONFIGURATION, never the incoming `Host`. A link built from
 * an attacker-supplied Host header would send the user's code to an attacker's
 * domain (INV-244).
 */
export function buildVerificationUrl(baseUrl: string, code: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/verify-email?code=${encodeURIComponent(code)}`;
}
