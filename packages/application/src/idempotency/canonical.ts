// Canonicalizing a logical request so it fingerprints deterministically.
//
// The problem this solves: `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same
// logical request and different bytes. Hashing raw HTTP bytes would make a
// retry from a client that serializes keys in a different order look like a
// completely different operation — and then the framework would execute it
// twice, which is the exact failure it exists to prevent.
//
// Small and LAGDA-owned rather than a canonical-JSON dependency: the input is
// already schema-validated JSON, so the general cases a specification has to
// handle (dates, class instances, cycles) are programmer errors here and are
// rejected loudly instead of accommodated.

/** Values a canonical request may contain. Anything else is a defect. */
export type CanonicalValue =
  | string | number | boolean | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path === "" ? "<root>" : path}`);
    this.name = "CanonicalizationError";
  }
}

/**
 * Depth bound.
 *
 * A hostile or buggy payload must not be able to spend unbounded time in the
 * fingerprint path — which runs before the operation is executed and therefore
 * before any business authorization has cost anything.
 */
const MAX_DEPTH = 32;

function canonicalize(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError("Request nesting is too deep", path);
  }

  // `null` is a VALUE and is preserved. `{a: null}` and `{}` are different
  // requests — "clear this field" is not "leave this field alone" — so they
  // must fingerprint differently.
  if (value === null) return "null";

  if (value === undefined) {
    // Never silently dropped. `undefined` has no JSON representation, so
    // treating it as absent would make `{a: undefined}` and `{}` collide, and
    // one of those is a bug worth surfacing.
    throw new CanonicalizationError("undefined is not a canonical value", path);
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);

    case "number":
      if (!Number.isFinite(value)) {
        // `NaN` and `Infinity` serialize to `null` in JSON, so two different
        // requests would fingerprint identically.
        throw new CanonicalizationError("Non-finite numbers are not canonical", path);
      }
      // `JSON.stringify` gives JavaScript's canonical shortest round-trip form,
      // so `1` and `1.0` both render as `1` — the same logical value producing
      // the same fingerprint, which is what we want.
      return JSON.stringify(value);

    case "boolean":
      return value ? "true" : "false";

    case "bigint":
      // Silently stringifying would make `1n` and `"1"` collide.
      throw new CanonicalizationError("BigInt is not a canonical value", path);

    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} is not a canonical value`, path);

    default:
      break;
  }

  if (Array.isArray(value)) {
    // Array ORDER IS PRESERVED. Recipients [A, B] and [B, A] are different
    // signing orders, so sorting would make two genuinely different requests
    // fingerprint the same and the second would be silently replayed.
    return `[${value
      .map((item, index) => canonicalize(item, `${path}[${String(index)}]`, depth + 1))
      .join(",")}]`;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // A Date, a Buffer, a class instance. Each has a `toJSON` or a coercion
    // that varies by environment, and none belongs in a schema-validated
    // request.
    throw new CanonicalizationError(
      `Only plain objects are canonical, received ${value.constructor.name}`,
      path,
    );
  }

  // OBJECT KEYS ARE SORTED. The whole reason this module exists.
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalize(item, path === "" ? key : `${path}.${key}`, depth + 1)}`)
    .join(",")}}`;
}

/**
 * The canonical string for a logical request.
 *
 * Fed to SHA-256 by the digester. Cycles are caught by the depth bound rather
 * than by cycle tracking — a cyclic request object is a programmer error, and
 * failing at depth 33 fails just as safely without carrying a `WeakSet`
 * through every call.
 */
export function canonicalRequest(value: unknown): string {
  return canonicalize(value, "", 0);
}
