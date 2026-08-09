// MFA recovery codes.
//
// The loss path: what a user has when their phone is gone. That makes each one
// a full second-factor bypass, so they get the same discipline as every other
// bearer credential here — high entropy, digest-only storage, single use.
//
// Format is dictated by the product. `RecoveryCodes.tsx` tells the user:
//
//   "Recovery codes are 14 characters in the format XXXX-XXXX-XXXX."
//
// So: 12 significant characters, displayed in three groups.

import { randomBytes, createHash } from "node:crypto";
import type { RecoveryCodeDigest } from "@lagda/application";

/**
 * Crockford base32 — the same alphabet as email verification codes.
 *
 * `I`, `L`, `O` and `U` are absent. A recovery code is written down on paper
 * and typed back months later, under stress, which is the worst possible
 * condition for telling `0` from `O`.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const GROUP_SIZE = 4;

/** How many are issued per set. Enough to survive several genuine incidents. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * 32^12 — 60 bits per code.
 *
 * Unguessable on its own, which matters more here than for a TOTP code: a
 * recovery code has no 30-second lifetime and no per-ceremony attempt counter
 * protecting it from being tried across many login attempts.
 */
function generateOne(): string {
  const characters: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (characters.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      // Rejection sampling. Written explicitly so the property survives someone
      // changing the alphabet to a length that does not divide 256.
      if (byte >= limit) continue;
      characters.push(ALPHABET[byte % ALPHABET.length] ?? "0");
      if (characters.length === CODE_LENGTH) break;
    }
  }
  return characters.join("");
}

function format(code: string): string {
  const groups: string[] = [];
  for (let at = 0; at < code.length; at += GROUP_SIZE) {
    groups.push(code.slice(at, at + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Canonicalizes what a user typed.
 *
 * Same confusion mappings as verification codes, for the same reason: this is
 * read off paper and retyped. Every accepted variant maps to exactly one
 * canonical value, so the search space is unchanged.
 */
export function canonicalizeRecoveryCode(raw: string): string | null {
  const stripped = raw
    .replace(/[\s-]/g, "")
    .toLocaleUpperCase("en-US")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

  if (stripped.length !== CODE_LENGTH) return null;
  for (const character of stripped) {
    if (!ALPHABET.includes(character)) return null;
  }
  return stripped;
}

/**
 * Digests a canonical recovery code.
 *
 * `lagda.mfa-recovery:` — a fourth digest domain, distinct from verification,
 * password reset and sessions. Without it a code minted for one purpose could
 * resolve a row belonging to another (INV-292).
 *
 * SHA-256 rather than Argon2id: 60 bits of uniform randomness has no guessing
 * attack for a slow hash to defend against.
 */
export function digestRecoveryCode(canonical: string): RecoveryCodeDigest {
  return createHash("sha256")
    .update(`lagda.mfa-recovery:${canonical}`)
    .digest("hex") as RecoveryCodeDigest;
}

export function digestSubmittedRecoveryCode(raw: string): RecoveryCodeDigest | null {
  const canonical = canonicalizeRecoveryCode(raw);
  return canonical === null ? null : digestRecoveryCode(canonical);
}

export interface IssuedRecoveryCodes {
  /** Shown to the user ONCE. Never stored, never logged (§194). */
  readonly display: readonly string[];
  readonly digests: readonly RecoveryCodeDigest[];
}

export function issueRecoveryCodes(): IssuedRecoveryCodes {
  const display: string[] = [];
  const digests: RecoveryCodeDigest[] = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const canonical = generateOne();
    display.push(format(canonical));
    digests.push(digestRecoveryCode(canonical));
  }
  return { display, digests };
}
