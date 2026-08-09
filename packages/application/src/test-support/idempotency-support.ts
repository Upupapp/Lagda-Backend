// Deterministic idempotency digesting, for tests only.
//
// **Not cryptographic, and deliberately obvious about it.** FNV-1a is a
// non-cryptographic hash; naming it that way is what stops this being mistaken
// for the production digester, which is SHA-256 in `@lagda/api/security/crypto`.
//
// Why not reuse the real one: `@lagda/application` must not depend on
// `@lagda/api` — the dependency runs the other way, and importing it here would
// invert the architecture to save a dozen lines. Why not `node:crypto`: these
// tests assert which requests are the SAME logical request, and a deterministic
// function that a reader can evaluate by eye makes a fingerprint mismatch
// debuggable rather than opaque.
//
// The properties the tests actually rely on are equality and inequality, and
// both hold.

import type { IdempotencyKey } from "@lagda/contracts";
import type {
  IdempotencyKeyDigest, IdempotencyKeyDigester, IdempotencyRecordId,
  IdempotencyRecordIdGenerator, RequestFingerprint,
} from "../common/ports/idempotency.js";

/**
 * FNV-1a, 32-bit, widened to 64 lowercase hex characters.
 *
 * The WIDTH is not cosmetic. `idempotency_records` carries
 * `check (key_digest ~ '^[a-f0-9]{64}$')`, so a digest of any other shape is
 * refused by PostgreSQL — which means a test digester that emitted 8 characters
 * would pass every unit test and fail every integration test. Matching the
 * production digest's SHAPE keeps the two runs describing the same thing.
 *
 * The ENTROPY is still 32 bits, and that is fine: nothing here defends against
 * anything. Production uses SHA-256.
 */
function fnv1a(domain: string, value: string): string {
  let hash = 0x811c9dc5;
  const input = `${domain}:${value}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

/**
 * Domain-separated, exactly like the real digester.
 *
 * Without the prefixes, a key and a canonical request that happened to be the
 * same string would digest identically — and the two are compared against
 * different columns.
 */
export function createIdempotencyKeyDigester(): IdempotencyKeyDigester {
  return {
    digestKey: (key: IdempotencyKey) => fnv1a("test.key", key) as IdempotencyKeyDigest,
    fingerprint: (canonical: string) =>
      fnv1a("test.fingerprint", canonical) as RequestFingerprint,
  };
}

/** Sequential record IDs, so a test can predict what a claim produces. */
export function createIdempotencyRecordIds(): IdempotencyRecordIdGenerator {
  let next = 1;
  return {
    nextIdempotencyRecordId: () => `idem_${String(next++)}` as IdempotencyRecordId,
  };
}
