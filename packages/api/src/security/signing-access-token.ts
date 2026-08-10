// Signing access bootstrap credentials.
//
// The eighth credential type, and it follows the pattern exactly: 32 random
// bytes, base64url, SHA-256 with its OWN domain constant, one adapter file so
// two purposes cannot share a digest space.
//
// ── Why not JWT ────────────────────────────────────────────────────────────
//
// A signed token would let a recipient's access be verified without a database
// row, which sounds like an advantage and is the opposite of one here. What
// this credential needs is revocation, a narrow lookup, an explicit lifecycle
// and server authority over all three — every one of which is a database row,
// and none of which a self-contained signed token gives.
//
// ── Why not the invitation factory ─────────────────────────────────────────
//
// Same shape, different meaning. A workspace invitation admits someone to a
// tenant; this begins a signing ceremony for one recipient of one request. If
// they shared a digest domain, an invitation token submitted to the signing
// endpoint would resolve — which is precisely the confusion the per-purpose
// constant exists to prevent.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type {
  SigningAccessTokenFactory, SigningAccessDigest,
} from "@lagda/application";

/** 256 bits. The same budget every other LAGDA bearer credential gets. */
const TOKEN_BYTES = 32;
/** 32 bytes in base64url. Used to reject the wrong shape before hashing. */
const ENCODED_LENGTH = 43;

/**
 * Base64url, and nothing else.
 *
 * Checked before digesting so a submitted value carrying a control character,
 * a path separator or a percent-escape is refused rather than hashed into
 * something that happens not to match.
 */
const ENCODED_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The domain constant. Eight credential types now digest to 64 hex characters,
 * and this prefix is the only thing that stops one resolving as another.
 */
const DIGEST_DOMAIN = "lagda.signing-access-bootstrap";

const digestOf = (raw: string): SigningAccessDigest =>
  createHash("sha256")
    .update(`${DIGEST_DOMAIN}:${raw}`, "utf8")
    .digest("hex") as SigningAccessDigest;

export function createSigningAccessTokenFactory(): SigningAccessTokenFactory {
  return {
    issue: () => {
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      return { raw, digest: digestOf(raw) };
    },

    /**
     * Returns null for anything that cannot be a credential.
     *
     * The length and alphabet check is not an optimisation — it means
     * BACKEND-34 can reject obvious garbage without a database round trip, so
     * a scanner spraying the signing endpoint costs a regex rather than a
     * query.
     */
    digest: (submitted: string) => {
      if (submitted.length !== ENCODED_LENGTH) return null;
      if (!ENCODED_SHAPE.test(submitted)) return null;
      return digestOf(submitted);
    },
  };
}

/**
 * Constant-time comparison of two digests.
 *
 * Exported for BACKEND-34, which will compare a submitted digest against a
 * stored one. Not used at send time — provisioning writes, it never compares —
 * and provided here so the comparison lives beside the domain constant rather
 * than being reinvented against `===`.
 */
export function signingAccessDigestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
