// Primitives shared across every domain.

import { Type, type Static } from "@sinclair/typebox";

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * An instant, serialized as an ISO 8601 / RFC 3339 string in UTC.
 *
 * A JavaScript `Date` never appears in a contract. `JSON.stringify(new Date())`
 * produces a string, so a `Date`-typed field describes something the wire never
 * carries — the receiver always gets a string and must re-parse it. Making the
 * string the contract removes that asymmetry.
 *
 * Always UTC, always with an offset. "2026-08-09T04:15:30.000Z" is the shape.
 */
/**
 * Enforced by `pattern`, deliberately NOT by `format: "date-time"`.
 *
 * The two validators this schema will meet disagree about unknown formats.
 * TypeBox's `Value.Check` REJECTS a value whose format has not been registered
 * in its `FormatRegistry`, while Ajv — which Fastify uses — ignores an unknown
 * format unless `ajv-formats` is loaded. So `format` alone would make the same
 * schema reject timestamps in one place and accept anything in the other. It
 * was caught here by a test that supplied a perfectly valid timestamp and
 * watched the schema reject it.
 *
 * A pattern is self-contained: no registry, no plugin, no import side effect
 * mutating a global (§36), and identical behaviour in both validators.
 *
 * The trailing `Z` is required rather than permitting an arbitrary offset,
 * because the contract says UTC. Accepting "+08:00" would let two encodings of
 * the same instant travel under one type.
 */
const RFC3339_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

export const TimestampSchema = Type.String({
  pattern: RFC3339_UTC,
  title: "Timestamp",
  description: "RFC 3339 instant in UTC with a trailing Z, e.g. 2026-08-09T04:15:30.000Z",
});
export type TimestampString = Static<typeof TimestampSchema>;

// ── Hashes ───────────────────────────────────────────────────────────────────

/**
 * A lowercase hex SHA-256 digest, 64 characters.
 *
 * Named for the algorithm rather than for a role, because the same digest is
 * used for several artifacts. `DocumentHash` would be ambiguous — the handoff
 * specifies a hash of the original upload *and* a hash of the final signed PDF,
 * and a type that cannot tell them apart would make the two interchangeable.
 * Which artifact a digest belongs to comes from the field name.
 */
export const Sha256DigestSchema = Type.String({
  pattern: "^[a-f0-9]{64}$",
  title: "Sha256Digest",
  description: "Lowercase hex SHA-256 digest (64 characters).",
});
export type Sha256Digest = Static<typeof Sha256DigestSchema>;

// ── Counts ───────────────────────────────────────────────────────────────────

export const NonNegativeIntSchema = Type.Integer({ minimum: 0 });
export type NonNegativeInt = Static<typeof NonNegativeIntSchema>;

// ── Optionality ──────────────────────────────────────────────────────────────

/**
 * A field that is present but may hold no value.
 *
 * The distinction is deliberate and matters across JSON, because `undefined` has
 * no JSON representation while `null` does:
 *
 *   `Type.Optional(X)`  — the key may be absent entirely. "not provided".
 *   `Nullable(X)`       — the key is always present; `null` means "known to be
 *                         empty".
 *
 * With `exactOptionalPropertyTypes` enabled these are not interchangeable, which
 * is the point: `completedAt` absent because a document is still in flight is a
 * different fact from `completedAt: null`.
 */
export const Nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
