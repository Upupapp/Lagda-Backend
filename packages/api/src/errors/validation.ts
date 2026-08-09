// Translating Fastify/Ajv validation failures into LAGDA's error details.
//
// Ajv's error objects are a library shape: `instancePath`, `keyword`, `params`,
// and a `message` written for developers. Returning them raw would make the
// public API contract depend on the validator's internals — a validator upgrade
// would then be a breaking API change, and clients would be parsing
// `"must have required property 'email'"`.

import { API_ERROR_CODES, type ApiErrorDetail } from "@lagda/contracts";

/** The subset of Ajv's error shape this adapter reads. */
interface AjvErrorLike {
  readonly instancePath?: unknown;
  readonly schemaPath?: unknown;
  readonly keyword?: unknown;
  readonly message?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Converts `/recipients/0/email` into `recipients[0].email`.
 *
 * The dotted-with-brackets form is what API_CONVENTIONS §3 specifies and what
 * the frontend's field paths already look like. Numeric segments become indices.
 */
export function toFieldPath(instancePath: string): string {
  if (instancePath === "") return "";
  const segments = instancePath.split("/").filter(s => s.length > 0);

  let path = "";
  for (const segment of segments) {
    // Ajv escapes `/` and `~` in property names per JSON Pointer.
    const name = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(name)) {
      path += `[${name}]`;
    } else {
      path += path === "" ? name : `.${name}`;
    }
  }
  return path;
}

/**
 * Formats an Ajv constraint value for a message.
 *
 * `String(unknown)` renders an object as "[object Object]", which would put
 * "Must be at least [object Object] characters." in front of a user. Only
 * primitives are rendered; anything else falls back to wording that needs no
 * value at all.
 */
function limit(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

/**
 * A human message per validation keyword.
 *
 * Written here rather than passed through from Ajv so the wording is LAGDA's,
 * stays stable across validator upgrades, and — critically — **never echoes the
 * submitted value**. Ajv's own messages sometimes do, and a rejected password
 * or token in an error body ends up in the client's error reporting.
 */
function describe(error: AjvErrorLike, field: string): string {
  const keyword = typeof error.keyword === "string" ? error.keyword : "";
  const params = error.params ?? {};

  switch (keyword) {
    case "required": {
      const missing = params["missingProperty"];
      const name = typeof missing === "string" ? missing : "A required field";
      return `${name} is required.`;
    }
    case "additionalProperties": {
      const extra = params["additionalProperty"];
      // Named, because the whole point of rejecting unknown fields is telling a
      // stale client which one it sent.
      return typeof extra === "string"
        ? `Unknown field: ${extra}.`
        : "The request contains an unknown field.";
    }
    case "type": {
      const expected = params["type"];
      return typeof expected === "string"
        ? `Expected a value of type ${expected}.`
        : "The value has the wrong type.";
    }
    case "enum":
      return "The value is not one of the permitted options.";
    case "pattern":
      return "The value is not in the expected format.";
    case "format":
      return "The value is not in the expected format.";
    case "minLength":
      return `Must be at least ${limit(params["limit"], "the minimum")} characters.`;
    case "maxLength":
      return `Must be at most ${limit(params["limit"], "the maximum")} characters.`;
    case "minimum":
    case "exclusiveMinimum":
      return `Must be at least ${limit(params["limit"], "the minimum")}.`;
    case "maximum":
    case "exclusiveMaximum":
      return `Must be at most ${limit(params["limit"], "the maximum")}.`;
    case "minItems":
      return `Must contain at least ${limit(params["limit"], "the minimum")} items.`;
    case "maxItems":
      return `Must contain at most ${limit(params["limit"], "the maximum")} items.`;
    default:
      return field === ""
        ? "The request is not valid."
        : "The value is not valid.";
  }
}

/**
 * Maps Fastify's validation array to canonical details.
 *
 * `additionalProperties` is reported against the offending property rather than
 * its parent: Ajv points `instancePath` at the containing object, so without
 * this the client is told "unknown field" with no indication of which one and a
 * field path of `""`.
 */
export function toValidationDetails(validation: unknown): readonly ApiErrorDetail[] {
  if (!Array.isArray(validation)) return [];

  const details: ApiErrorDetail[] = [];
  for (const raw of validation) {
    if (typeof raw !== "object" || raw === null) continue;
    const error = raw as AjvErrorLike;

    const instancePath = typeof error.instancePath === "string" ? error.instancePath : "";
    let field = toFieldPath(instancePath);

    if (error.keyword === "additionalProperties") {
      const extra = error.params?.["additionalProperty"];
      if (typeof extra === "string") {
        field = field === "" ? extra : `${field}.${extra}`;
      }
    }
    if (error.keyword === "required") {
      const missing = error.params?.["missingProperty"];
      if (typeof missing === "string") {
        field = field === "" ? missing : `${field}.${missing}`;
      }
    }

    details.push({
      field,
      code: API_ERROR_CODES.validationError,
      message: describe(error, field),
    });
  }
  return details;
}
