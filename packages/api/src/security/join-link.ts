// 078. The join link's credential: a 32-byte random token, stored only as a
// domain-separated SHA-256 digest, and sealed (not stored) for the admin's
// Copy / QR with the same key the notification worker opens it with.

import { randomBytes, createHash } from "node:crypto";
import type { JoinTicketDigest, JoinTicketSecrets, JoinTicketTokenFactory } from "@lagda/application";
import { createSecretBox } from "@lagda/security";

const TOKEN_BYTES = 32;
const ENCODED_LENGTH = 43;
const DIGEST_DOMAIN = "lagda.workspace-join-link";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

function digestToken(token: string): JoinTicketDigest {
  return createHash("sha256").update(`${DIGEST_DOMAIN}:${token}`).digest("hex") as JoinTicketDigest;
}

export function createJoinTicketTokenFactory(): JoinTicketTokenFactory {
  return {
    issue() {
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      return { raw, digest: digestToken(raw) };
    },
    // Refused by SHAPE before any lookup, so a malformed value is never a
    // database round trip and never echoed back.
    digest(submitted: string) {
      if (submitted.length !== ENCODED_LENGTH || !TOKEN_PATTERN.test(submitted)) return null;
      return digestToken(submitted);
    },
  };
}

export function createJoinTicketSecrets(key: string, keyVersion: string): JoinTicketSecrets {
  const box = createSecretBox({ keyBase64: key, keyVersion });
  return {
    keyVersion: box.keyVersion,
    seal: raw => box.seal(raw),
    open: sealed => {
      try {
        return box.open(sealed);
      } catch {
        // A rotated key or a value that is not ours: the admin re-sends.
        return null;
      }
    },
  };
}
