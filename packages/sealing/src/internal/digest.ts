// SHA-256 digesting.
//
// `node:crypto` appears here and nowhere else in the backend. Hashing spread
// across layers becomes several implementations that disagree about encoding.

import { createHash } from "node:crypto";
import type { Sha256Digest } from "@lagda/contracts";

/**
 * Digest of EXACT bytes, lowercase hex.
 *
 * No normalization of any kind before hashing. A digest that identifies
 * "semantically equivalent" bytes rather than the actual bytes cannot verify
 * the document someone is holding.
 *
 * Lowercase hex is the canonical encoding, matching `Sha256DigestSchema`'s
 * `^[a-f0-9]{64}$`. Mixing hex and base64 across fields is how a verification
 * comparison silently never matches.
 *
 * NOTE: `Sha256Digest` is currently a plain alias for `string`, unlike the ID
 * types, which are branded. So the return type documents intent but enforces
 * nothing — `preparedDocumentHash` and `signedDocumentHash` are mutually
 * assignable, and swapping them would typecheck. The tests compare each against
 * an independently computed digest for exactly that reason. Branding it is
 * OD-022, deferred because `@lagda/contracts` is shared with the frontend.
 */
export function sha256(bytes: Uint8Array): Sha256Digest {
  return createHash("sha256").update(bytes).digest("hex");
}
