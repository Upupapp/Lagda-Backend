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
/**
 * Branded, like the ID types — and for a sharper reason than most.
 *
 * `Static<>` of a string schema is plain `string`, which made
 * `preparedDocumentHash` and `signedDocumentHash` mutually assignable: swapping
 * them compiled, and the swap publishes the input's digest as the verification
 * value for the output. Two adjacent columns in `document_seals` carry exactly
 * those two values.
 *
 * Branding was deferred in BACKEND-09 (OD-022) on the grounds that
 * `@lagda/contracts` is shared with the frontend. That reason was wrong — the
 * frontend consumes nothing from this package (OD-005), so the change costs
 * nothing today and gets more expensive every command that persists a digest.
 *
 * The brand is compile-time only: on the wire this is still a 64-character
 * string, and `Sha256DigestSchema` still validates it.
 */
declare const digestBrand: unique symbol;
export type Sha256Digest = Static<typeof Sha256DigestSchema>
  & { readonly [digestBrand]: "Sha256Digest" };

/**
 * The single validating entry point into the branded type.
 *
 * Everything that produces a digest goes through here, so the brand cannot be
 * acquired by assertion in ordinary code — which is what stops it degrading
 * back into a decorative type.
 *
 * @throws if the value is not lowercase hex of exactly 64 characters. Uppercase
 *         is rejected rather than normalized: a digest that silently changes
 *         case is a digest that fails a string comparison somewhere else.
 */
export function toSha256Digest(value: string): Sha256Digest {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Not a lowercase hex SHA-256 digest: ${JSON.stringify(value)}`);
  }
  return value as Sha256Digest;
}

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
