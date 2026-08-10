// Recipient signing-session credentials.
//
// The tenth and eleventh credential types. Two are issued together — the
// session cookie and its CSRF token — with SEPARATE digest domains, so a CSRF
// token can never be submitted as a session cookie or the reverse.
//
// Same shape as every other LAGDA credential: 32 random bytes, base64url,
// SHA-256 with a purpose constant, one adapter file. Not a JWT.

import { randomBytes, createHash } from "node:crypto";
import type {
  RecipientSessionTokenFactory, RecipientSessionDigest, RecipientCsrfDigest,
} from "@lagda/application";

const TOKEN_BYTES = 32;
const ENCODED_LENGTH = 43;
const ENCODED_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Two domains, not one.
 *
 * A single domain would mean the CSRF token and the session token digest
 * identically for the same input — so a page that leaked the CSRF token (which
 * is readable by design in a double-submit scheme) would have leaked a value
 * that resolves a session.
 */
const SESSION_DOMAIN = "lagda.recipient-signing-session";
const CSRF_DOMAIN = "lagda.recipient-signing-csrf";

const digestWith = (domain: string, raw: string): string =>
  createHash("sha256").update(`${domain}:${raw}`, "utf8").digest("hex");

export function createRecipientSessionTokenFactory(): RecipientSessionTokenFactory {
  return {
    issue: () => {
      // Two INDEPENDENT draws. Deriving one from the other — even through a
      // hash — would make the CSRF token a function of the session token, and
      // a double-submit check whose two halves share a secret is not a check.
      const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
      const rawCsrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
      return {
        rawToken,
        tokenDigest: digestWith(SESSION_DOMAIN, rawToken) as RecipientSessionDigest,
        rawCsrfToken,
        csrfDigest: digestWith(CSRF_DOMAIN, rawCsrfToken) as RecipientCsrfDigest,
      };
    },

    /**
     * Structural rejection before any I/O.
     *
     * A signing surface is public and will be sprayed. A wrong-shaped cookie
     * costs a regex rather than a database round trip.
     */
    digestToken: (submitted: string) => {
      if (submitted.length !== ENCODED_LENGTH) return null;
      if (!ENCODED_SHAPE.test(submitted)) return null;
      return digestWith(SESSION_DOMAIN, submitted) as RecipientSessionDigest;
    },

    digestCsrf: (submitted: string) => {
      if (submitted.length !== ENCODED_LENGTH) return null;
      if (!ENCODED_SHAPE.test(submitted)) return null;
      return digestWith(CSRF_DOMAIN, submitted) as RecipientCsrfDigest;
    },
  };
}
