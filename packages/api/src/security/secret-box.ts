// Authenticated encryption for secrets the server must RECOVER.
//
// ── Why this exists at all ─────────────────────────────────────────────────
//
// Every other credential in LAGDA is stored as a one-way digest, because the
// server only ever needs to COMPARE: a submitted session token, verification
// code, reset token or recovery code is hashed and matched.
//
// A TOTP secret is the one exception. Computing the code the user's phone is
// showing requires the secret itself. A digest cannot do it, so the choice is
// between reversible encryption and plaintext — and plaintext in a database
// column means one dump hands over every user's second factor.
//
// ── What this is not ───────────────────────────────────────────────────────
//
// Not a key-management system. One key, from configuration, with a version
// label so that rotation is possible later without a schema change. There is
// no KMS, no envelope encryption, no automatic rotation, and no key escrow —
// see MFA_SECURITY.md, where that limitation is recorded rather than hidden.
//
// Not home-grown cryptography either. AES-256-GCM from `node:crypto` is a
// standard authenticated construction; nothing here invents a scheme.

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
/** AES-256 takes a 32-byte key. */
const KEY_BYTES = 32;
/** 96 bits, the size GCM is specified and optimised for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * An encrypted secret, as stored.
 *
 * `v1.<iv>.<ciphertext>.<tag>`, all base64url. Self-describing so a stored
 * value can be decrypted without a lookup table, and versioned so the FORMAT
 * can change independently of the key.
 */
export type SealedSecret = string & { readonly __brand: "SealedSecret" };

const FORMAT_VERSION = "v1";

export class SecretBoxError extends Error {
  constructor(message: string) {
    // Deliberately vague. A decryption failure must not report whether the key
    // was wrong, the tag failed, or the format was unparseable — each is a
    // distinguisher an attacker probing a stored value would like to have.
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface SecretBox {
  /** The key version stamped alongside anything this box seals. */
  readonly keyVersion: string;
  readonly seal: (plaintext: string) => SealedSecret;
  /** @throws SecretBoxError when the value does not authenticate. */
  readonly open: (sealed: string) => string;
}

/**
 * Builds a secret box from a configured key.
 *
 * The key arrives as base64 and must decode to exactly 32 bytes. A short key
 * is rejected LOUDLY at construction rather than silently padded — a
 * silently-weakened key is the kind of failure that never surfaces until it
 * matters.
 */
export function createSecretBox(options: {
  readonly keyBase64: string;
  readonly keyVersion: string;
}): SecretBox {
  const key = Buffer.from(options.keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `Encryption key must decode to ${String(KEY_BYTES)} bytes, got ${String(key.length)}.`,
    );
  }

  return {
    keyVersion: options.keyVersion,

    seal(plaintext: string): SealedSecret {
      // A FRESH random IV per encryption. Reusing an IV under one key is the
      // catastrophic failure mode of GCM — it leaks the XOR of plaintexts and
      // can expose the authentication subkey.
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return [
        FORMAT_VERSION,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join(".") as SealedSecret;
    },

    open(sealed: string): string {
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
        throw new SecretBoxError("Malformed sealed secret.");
      }
      const iv = Buffer.from(parts[1] ?? "", "base64url");
      const ciphertext = Buffer.from(parts[2] ?? "", "base64url");
      const tag = Buffer.from(parts[3] ?? "", "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretBoxError("Malformed sealed secret.");
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        // GCM AUTHENTICATES as well as encrypts. `final()` throws if the tag
        // does not match, so a tampered ciphertext cannot be decrypted into
        // an attacker-chosen secret — which for a TOTP secret would mean
        // choosing which codes the server accepts.
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // The underlying error is swallowed on purpose: it distinguishes tag
        // failure from key mismatch, and the caller has no legitimate use for
        // that distinction.
        throw new SecretBoxError("Could not open sealed secret.");
      }
    },
  };
}

/** Generates a key in the format `createSecretBox` expects. For operators. */
export function generateSecretBoxKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
