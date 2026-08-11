// The public verification identifier (BACKEND-42, closing a BACKEND-41 gap).
//
// ── Why this is in `security/` and not with the entity ID generators ───────
//
// The port's own comment says it: "this value is published, so it must be
// unguessable. An entity ID only has to be unique. Merging them would let a
// routine ID generator quietly become the source of a public secret-adjacent
// value."
//
// It is NOT a credential. Possessing one permits a curated public lookup and
// nothing else — never document access, never signing access. But it is the
// only thing standing between an anonymous caller and knowing that a particular
// completed document exists, so it has to be unguessable even though it is not
// secret.
//
// ── The gap this closes ────────────────────────────────────────────────────
//
// `VerificationIdGenerator` had NO implementation anywhere — not in `db`, not
// in the API bootstrap, not in the test fakes. Only the port and BACKEND-41's
// one call site. BACKEND-41's finalization therefore could not run in
// production: it injects `nextVerificationId` and nothing supplied it. Its
// tests passed because the harness stubbed it inline, which is exactly the
// "ports whose only implementations are test ones" pattern OD-069 records.

import { randomBytes } from "node:crypto";
import type { WorkspaceId, VerificationId } from "@lagda/contracts";
import type { VerificationIdGenerator } from "@lagda/application";

/**
 * The alphabet, and why it excludes what it excludes.
 *
 * The product's own parser is `VER_ID_RE = /^LAGDA-VER-\d{4}-\w{4,10}$/i`, so
 * the suffix must match `\w` — `[A-Za-z0-9_]`. Underscore is dropped anyway: a
 * verification reference gets read aloud, copied out of a PDF and typed back in,
 * and an underscore is invisible under an underline.
 *
 * The digits `0` and `1` and the letters `O`, `I` and `l` are dropped for the
 * same reason. This costs entropy and buys correctness at the point where a
 * human retypes a reference from a printed page — which is the actual use case.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

/**
 * TEN characters — the maximum the product's parser accepts.
 *
 * Deliberately the top of the permitted range, not the bottom. `VER_ID_RE`
 * admits as few as four, which is roughly 8 million values over this alphabet
 * and enumerable at any plausible public rate limit. Ten gives
 * 55^10 ≈ 2.5 × 10^17 — about 58 bits.
 *
 * That is not cryptographic-key strength and does not need to be: the value
 * authorizes nothing. It needs to be far beyond guessing at a rate-limited
 * public endpoint, and it is.
 */
const SUFFIX_LENGTH = 10;

/**
 * Rejection sampling, not modulo.
 *
 * `byte % 55` is biased: 256 is not a multiple of 55, so the first 36 letters
 * of the alphabet come up slightly more often than the rest. The bias is small
 * and it is also exactly the kind of thing that never gets noticed and slowly
 * erodes the entropy claim above. Discarding out-of-range bytes costs a few
 * extra reads and keeps the distribution flat.
 */
function randomSuffix(length: number): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * `LAGDA-VER-{year}-{10 random characters}`.
 *
 * The year is the only structured part, and it is deliberately coarse. It comes
 * from the completion instant the caller supplies rather than from a clock read,
 * so the generator stays deterministic given its inputs.
 *
 * **The workspace is NOT encoded.** The port takes a `WorkspaceId` and this
 * implementation ignores it, which is intentional rather than an oversight: a
 * workspace-derived prefix would let anyone holding two verification references
 * tell whether they came from the same tenant, and would make the identifier
 * partially predictable from public information. The parameter stays in the
 * port because a future scheme may legitimately need it — but encoding tenancy
 * into a published identifier is a disclosure, not a convenience.
 */
export function createVerificationIdGenerator(): VerificationIdGenerator {
  return {
    nextVerificationId(_workspaceId: WorkspaceId, at: number): VerificationId {
      const year = new Date(at).getUTCFullYear();
      return `LAGDA-VER-${String(year)}-${randomSuffix(SUFFIX_LENGTH)}` as VerificationId;
    },
  };
}

/** Exported for the entropy test, so the claim above is measured rather than asserted. */
export const VERIFICATION_ID_ALPHABET = ALPHABET;
export const VERIFICATION_ID_SUFFIX_LENGTH = SUFFIX_LENGTH;
