// HTTP VALIDATOR digests: the weak ETag of a JSON response body.
//
// A different domain from every other digest here: this is never a
// credential and never a document hash. It is compared only against what
// the same client echoes back in If-None-Match, so the only property it
// needs is "the same body gives the same tag, a different body does not".
// Twenty-seven base64url characters of SHA-256 (162 bits) are more than
// enough for that, and short enough to ride on every response.
//
// Allowlisted by tests/architecture/sealing.test.ts under its own domain.

import { createHash } from "node:crypto";

/** The weak ETag for a serialized response body. */
export function responseEtag(body: string): string {
  return `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}
