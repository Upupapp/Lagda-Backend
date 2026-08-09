// SHA-256 digesting.
//
// `node:crypto` appears here and nowhere else in the backend. Hashing spread
// across layers becomes several implementations that disagree about encoding.

import { createHash } from "node:crypto";
import { toSha256Digest, type Sha256Digest } from "@lagda/contracts";

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
 * The brand is acquired HERE and only here, through the validating constructor.
 * `Sha256Digest` used to be a plain `string` alias, which made
 * `preparedDocumentHash` and `signedDocumentHash` mutually assignable —
 * swapping them compiled silently (OD-022, now closed).
 */
export function sha256(bytes: Uint8Array): Sha256Digest {
  return toSha256Digest(createHash("sha256").update(bytes).digest("hex"));
}
