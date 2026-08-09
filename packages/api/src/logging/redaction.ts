// Redaction that actually holds.
//
// BACKEND-11 configured Pino's `redact` paths and BACKEND-12 probed them. Three
// things got through:
//
//   { password: "x" }              — `*.password` does NOT match a top-level key
//   { deep: { a: { token: "x" } } } — `*.token` matches ONE level, not any depth
//   new Error("postgres://u:pw@h") — a secret inside a MESSAGE is not a field
//
// Pino's path syntax cannot express "any key named `token`, at any depth", and
// the natural workaround — enumerating paths — fails the moment a new shape
// appears. So redaction happens in a `formatters.log` hook that walks the whole
// object.
//
// This runs on every log line, so it is bounded in depth, breadth and string
// length. An unbounded walk over a hostile object is a denial-of-service in the
// logger.

/** Replaces a redacted value. Present, so its absence is not mistaken for a bug. */
export const REDACTED = "[redacted]";

/**
 * Key names whose VALUE is always a secret.
 *
 * Matched case-insensitively against the normalized key (non-alphanumerics
 * stripped), so `set-cookie`, `setCookie` and `set_cookie` all match one entry.
 */
const SECRET_KEYS = new Set([
  "authorization", "cookie", "setcookie",
  "password", "currentpassword", "newpassword", "passwordhash",
  "otp", "otpcode", "verificationcode",
  "csrf", "csrftoken",
  "token", "accesstoken", "refreshtoken", "signingtoken", "resettoken",
  "sessiontoken", "sessionsecret", "sessionid",
  "apikey", "secret", "clientsecret", "privatekey", "signingsecret",
  "signature", "signatureimage", "signaturedata",
  "presignedurl", "connectionstring", "databaseurl",
  "idempotencykey",
]);

/**
 * Suffixes that make a key a secret regardless of prefix.
 *
 * Catches `webhookSigningSecret`, `stripeApiKey`, `signingAccessToken` without
 * enumerating every one. Deliberately does NOT include `key` alone — that would
 * redact `sortKey`, `routeKey` and every map key in a diagnostic object.
 */
const SECRET_SUFFIXES = ["password", "secret", "token", "apikey", "privatekey"];

/** Bounds. A log line is not a place to serialize an object graph. */
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_KEYS = 100;
const MAX_STRING_LENGTH = 2_048;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEYS.has(normalized)) return true;
  return SECRET_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/**
 * Strips credentials from URL-like text.
 *
 * A connection string or presigned URL frequently arrives inside an error
 * MESSAGE, where field-based redaction cannot reach it. This does not make
 * embedding secrets in messages safe — it is a backstop, and the real rule is
 * that errors must not be constructed with secrets in them (INV, §104).
 */
export function scrubSecretsFromText(text: string): string {
  return text
    // scheme://user:password@host  →  scheme://user:[redacted]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, `$1:${REDACTED}@`)
    // query-string credentials, including presigned-URL signatures
    .replace(
      /([?&](?:token|password|secret|signature|sig|apikey|api_key|x-amz-signature|access_token)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    );
}

/** Binary is never log content. Size is the only useful part. */
function describeBinary(value: ArrayBufferView): string {
  return `[binary ${String(value.byteLength)} bytes]`;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const scrubbed = scrubSecretsFromText(value);
    return scrubbed.length > MAX_STRING_LENGTH
      // Truncated rather than dropped: a 4 MB PDF read as a string must not
      // become a 4 MB log line, but the prefix still identifies what happened.
      ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…[truncated ${String(scrubbed.length)} chars]`
      : scrubbed;
  }

  if (typeof value !== "object") return value;

  if (ArrayBuffer.isView(value)) return describeBinary(value);
  if (value instanceof ArrayBuffer) return `[binary ${String(value.byteLength)} bytes]`;

  if (depth >= MAX_DEPTH) return "[depth limit]";

  // Cycles are ordinary in Node objects (a socket references its server, which
  // references the socket). Without this the formatter recurses forever and the
  // process dies inside the logger.
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => redactValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${String(value.length - MAX_ARRAY_ITEMS)} more items]`);
      }
      return items;
    }

    if (value instanceof Error) {
      return {
        type: value.name,
        message: scrubSecretsFromText(value.message),
        stack: value.stack === undefined ? undefined : scrubSecretsFromText(value.stack),
        ...(value.cause === undefined
          ? {}
          : { cause: redactValue(value.cause, depth + 1, seen) }),
      };
    }

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_KEYS) {
        out["…"] = "[key limit]";
        break;
      }
      count += 1;
      out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  } finally {
    // Released so a value appearing twice in SIBLING branches is not reported as
    // circular — only genuine ancestry cycles are.
    seen.delete(value);
  }
}

/**
 * The Pino `formatters.log` hook.
 *
 * Runs on the merged log object for every line, after serializers.
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactValue(object, 0, new WeakSet()) as Record<string, unknown>;
}
