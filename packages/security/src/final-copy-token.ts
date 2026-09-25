// Final-copy DOWNLOAD credentials (073).
//
// Its own file and its own digest domain, like every LAGDA bearer
// credential: 32 random bytes, base64url, SHA-256 under
// `lagda.final-copy-download:`. The domain is what stops a signing link, an
// invitation or a session token resolving as a download link, and the
// reverse.
//
// In `@lagda/security`, not `@lagda/api`, because BOTH process roles need it:
// the WORKER mints these inside the finalization transaction, and the API
// digests what a participant presents.

import { randomBytes, createHash } from "node:crypto";
import type { FinalCopyTokenFactory, FinalCopyDigest } from "@lagda/application";

const TOKEN_BYTES = 32;
const ENCODED_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_DOMAIN = "lagda.final-copy-download";

const digestOf = (raw: string): FinalCopyDigest =>
  createHash("sha256").update(`${DIGEST_DOMAIN}:${raw}`, "utf8").digest("hex") as FinalCopyDigest;

export function createFinalCopyTokenFactory(): FinalCopyTokenFactory {
  return {
    issue: () => {
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      return { raw, digest: digestOf(raw) };
    },
    // Garbage is refused by shape before it costs a query.
    digest: (submitted: string) => ENCODED_SHAPE.test(submitted) ? digestOf(submitted) : null,
  };
}
