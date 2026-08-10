// Workspace invitation credentials.
//
// A LINK token, like password reset and unlike email verification: nobody types
// an invitation code into a field. `AcceptInvitation.tsx` is reached by URL and
// shows a workspace and two buttons, so the credential travels in the link and
// is sized for security rather than for legibility.
//
// 32 bytes, base64url, matching the convention `crypto.ts` established for
// sessions and `reset-token.ts` for reset links.

import { randomBytes, createHash } from "node:crypto";
import type { InvitationTokenDigest, InvitationTokenFactory } from "@lagda/application";

/**
 * 32 bytes — 256 bits, base64url-encoded to 43 characters.
 *
 * Unguessable on its own, which is the requirement. Rate limiting on the
 * preview and accept endpoints is defence in depth and must never be the thing
 * standing between an attacker and a workspace: an invitation grants tenant
 * access, and the search space here is not meaningfully reducible by any amount
 * of distributed guessing (§21, §188).
 *
 * Expiry does NOT justify less entropy. A seven-day window is still 604,800
 * seconds of guessing.
 */
const TOKEN_BYTES = 32;

/** What base64url encoding of 32 bytes always produces. */
const ENCODED_LENGTH = 43;

/**
 * The digest domain.
 *
 * `lagda.workspace-invitation:` and nothing else. Seven credential types now
 * digest to 64 hex characters — session, CSRF, email verification, password
 * reset, MFA recovery code, pre-auth, and this. Without the prefix a string
 * that happened to be valid in two of those tables would digest identically in
 * both, and possession of one credential would resolve the other's row.
 *
 * An invitation token is the only one of the seven that grants access to a
 * TENANT rather than to an account, which makes the separation matter more
 * here, not less (§23).
 */
const DIGEST_DOMAIN = "lagda.workspace-invitation";

/** base64url only. No padding, no slashes, nothing that survives a URL badly. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

function digestToken(token: string): InvitationTokenDigest {
  return createHash("sha256")
    .update(`${DIGEST_DOMAIN}:${token}`)
    .digest("hex") as InvitationTokenDigest;
}

export function createInvitationTokenFactory(): InvitationTokenFactory {
  return {
    issue() {
      // `randomBytes` is a CSPRNG. `Math.random()` is seeded and predictable,
      // and has been the root cause of real credential-prediction
      // vulnerabilities.
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      // The raw value is returned EXACTLY ONCE. Nothing here retains it.
      return { raw, digest: digestToken(raw) };
    },

    /**
     * Structural validation BEFORE any digest or lookup (§24).
     *
     * Exact length and alphabet. An oversized or control-character-bearing
     * string is refused here rather than becoming a database round trip — and
     * because it is refused by SHAPE, the submitted value never has to be
     * echoed anywhere to explain why it failed.
     *
     * Returns null rather than throwing, so the caller collapses it into the
     * same single public error as every other invalid-token case.
     */
    digest(submitted: string): InvitationTokenDigest | null {
      if (submitted.length !== ENCODED_LENGTH) return null;
      if (!TOKEN_PATTERN.test(submitted)) return null;
      return digestToken(submitted);
    },
  };
}
