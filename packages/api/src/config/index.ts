// API runtime configuration.
//
// Parsed ONCE, at startup, and passed as a value. `process.env` is read in this
// file and nowhere else in the package — a route or plugin reading the
// environment is a route that behaves differently in tests than in production
// for reasons nobody can see at the call site.
//
// Invalid configuration fails startup. A server that boots with an unparseable
// port and silently picks a default is a server whose deployment config is
// wrong and nobody knows.

export type NodeEnvironment = "development" | "test" | "production";

/**
 * How much of the `X-Forwarded-*` chain to believe.
 *
 * NOT a boolean, because the honest answer is not binary. `true` tells Fastify
 * to trust the entire chain, and any client can prepend an address to
 * `X-Forwarded-For` — so with one careless setting the "observed" client IP
 * becomes attacker-supplied text that ends up in signing evidence.
 *
 * A hop count is the meaningful production value: with one reverse proxy in
 * front, trust exactly one hop and everything further left is discarded.
 */
export type TrustProxySetting =
  | { readonly mode: "none" }
  | { readonly mode: "hops"; readonly hops: number }
  | { readonly mode: "addresses"; readonly addresses: readonly string[] };

export interface ApiConfig {
  readonly environment: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly trustProxy: TrustProxySetting;
  /** Exact origins. Never a pattern, never a wildcard. */
  readonly corsOrigins: readonly string[];
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** JSON bodies only. Uploads get their own limit on their own routes (BACKEND-18). */
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;

  // ── Session cookies ────────────────────────────────────────────────────────

  /**
   * `Lax` by default, and OD-028 does NOT block this.
   *
   * SameSite is evaluated per SITE, not per origin. `app.lagda.io` calling
   * `api.lagda.io` is same-site, so `Lax` works under both candidate
   * deployments. Only a frontend on a different registrable domain would need
   * `none`, which is why that value additionally requires `Secure`.
   */
  readonly sessionCookieSameSite: "lax" | "strict" | "none";
  /** Forced true in production. See `assertProductionSafety`. */
  readonly sessionCookieSecure: boolean;
  readonly sessionAbsoluteLifetimeMs: number;
  /** Handoff §3: "default 8 hours idle". */
  readonly sessionIdleTimeoutMs: number;
  readonly sessionTouchIntervalMs: number;

  /**
   * Base64 key for encrypting TOTP secrets at rest (BACKEND-23).
   *
   * NULL when unset, and MFA enrolment is then unavailable rather than
   * silently storing plaintext. A missing key must fail loudly at the point of
   * use — a deployment that quietly degraded to unencrypted second-factor
   * secrets would be worse than one that refuses to enrol.
   *
   * Never logged, never persisted, never in a queue payload (§16).
   */
  readonly mfaSecretKey: string | null;
  /** Which key encrypted a stored secret. Enables rotation without a migration. */
  readonly mfaSecretKeyVersion: string;

  /**
   * Base64 key for sealing signing-invitation credentials (BACKEND-33).
   *
   * A SEPARATE key from `mfaSecretKey`, deliberately. They protect
   * different things with different blast radii: one compromises second
   * factors, the other lets an attacker mint signing links for pending
   * agreements. Sharing a key would mean rotating both to respond to either.
   *
   * NULL when unset, and Send then FAILS rather than storing a credential
   * nobody can render - the same shape MFA enrolment takes.
   *
   * Never logged, never persisted, never in a queue payload.
   */
  readonly signingDeliveryKey: string | null;
  readonly signingDeliveryKeyVersion: string;

  /**
   * How long a signing bootstrap credential stays usable.
   *
   * 14 days. Long enough that a counterparty who reads email weekly is not
   * locked out, short enough that a link forwarded or archived does not
   * stay live for a year. Request EXPIRATION is a different, later question
   * (BACKEND-46); this bounds the CREDENTIAL regardless of it.
   */
  readonly signingAccessLifetimeMs: number;

  /**
   * How long an authenticated recipient signing session lasts.
   *
   * 8 hours, matching the workspace session's idle timeout - long enough
   * for a signer interrupted by a meeting, short enough that a shared or
   * abandoned browser does not stay authenticated overnight.
   *
   * ABSOLUTE, with no idle timeout. A signing session is short by
   * construction, and touching a row on every request buys nothing.
   */
  readonly recipientSessionLifetimeMs: number;
}

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigError";
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** 1 MiB. Generous for JSON, far too small to be an upload path by accident. */
const DEFAULT_BODY_LIMIT = 1_048_576;

function readInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  // Rejects "3000abc", which `parseInt` would happily read as 3000. A typo in a
  // deployment variable should stop the deploy, not silently half-apply.
  if (!/^\d+$/.test(raw)) {
    throw new ApiConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}.`);
  }
  return Number(raw);
}

/**
 * Parses the trust-proxy setting.
 *
 * Accepts `false`/unset (none), a hop count, or a comma-separated address list.
 * `true` is REJECTED outright: it means "believe the whole chain", which cannot
 * be correct behind an unknown number of proxies and is indistinguishable from
 * having thought about it. Someone who genuinely wants that must say how many
 * hops.
 */
function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (raw === undefined || raw === "" || raw === "false") return { mode: "none" };

  if (raw === "true") {
    throw new ApiConfigError(
      'TRUST_PROXY=true is not accepted. It trusts the entire X-Forwarded-For chain, '
      + 'which lets any client choose the IP recorded as signing evidence. Set a hop '
      + 'count (e.g. TRUST_PROXY=1) or a comma-separated list of trusted proxy addresses. '
      + 'See docs/backend/api/TRUST_PROXY.md.',
    );
  }

  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1) {
      throw new ApiConfigError("TRUST_PROXY hop count must be at least 1, or unset for none.");
    }
    return { mode: "hops", hops };
  }

  const addresses = raw.split(",").map(a => a.trim()).filter(a => a.length > 0);
  if (addresses.length === 0) {
    throw new ApiConfigError(`TRUST_PROXY could not be parsed: ${JSON.stringify(raw)}.`);
  }
  return { mode: "addresses", addresses };
}

/**
 * Parses allowed CORS origins.
 *
 * Each must be a well-formed absolute origin with no path. Validated rather than
 * accepted as text because the comparison later is exact equality, and a stray
 * trailing slash produces an origin that never matches while looking correct in
 * the config file.
 *
 * `*` is rejected. Session authentication is cookie-based, so a wildcard would
 * either be ignored by the browser or, if combined with credentials, would be a
 * serious hole. There is no configuration in which it is the right answer here.
 */
function parseCorsOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];

  const origins = raw.split(",").map(o => o.trim()).filter(o => o.length > 0);

  for (const origin of origins) {
    if (origin === "*") {
      throw new ApiConfigError(
        "CORS_ORIGINS must not contain '*'. Browser sessions use credentialed cookies, "
        + "and a wildcard is either ignored or unsafe. List exact origins.",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ApiConfigError(`CORS_ORIGINS entry is not a valid URL: ${JSON.stringify(origin)}.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ApiConfigError(`CORS origin must be http or https: ${JSON.stringify(origin)}.`);
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new ApiConfigError(
        `CORS origin must be scheme://host[:port] with no path: ${JSON.stringify(origin)}.`,
      );
    }
    // `new URL("https://x").origin` drops the trailing slash; if the configured
    // text differs from the canonical origin, exact matching would never fire.
    if (parsed.origin !== origin) {
      throw new ApiConfigError(
        `CORS origin must be written canonically as ${JSON.stringify(parsed.origin)}, `
        + `got ${JSON.stringify(origin)}.`,
      );
    }
  }
  return origins;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawEnvironment = env["NODE_ENV"] ?? "development";
  if (rawEnvironment !== "development" && rawEnvironment !== "test" && rawEnvironment !== "production") {
    throw new ApiConfigError(
      `NODE_ENV must be development, test or production, got ${JSON.stringify(rawEnvironment)}.`,
    );
  }
  const environment: NodeEnvironment = rawEnvironment;

  const port = readInt(env["API_PORT"], "API_PORT", 8080);
  if (port < 1 || port > 65_535) {
    throw new ApiConfigError(`API_PORT must be between 1 and 65535, got ${String(port)}.`);
  }

  // Loopback by default. Binding 0.0.0.0 in development exposes an unauthenticated
  // service to the local network, which is a surprising default for a laptop.
  const host = env["API_HOST"] ?? "127.0.0.1";

  const rawLogLevel = env["LOG_LEVEL"] ?? (environment === "test" ? "silent" : "info");
  if (!(LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
    throw new ApiConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}.`);
  }

  const config: ApiConfig = {
    environment,
    host,
    port,
    trustProxy: parseTrustProxy(env["TRUST_PROXY"]),
    corsOrigins: parseCorsOrigins(env["CORS_ORIGINS"]),
    logLevel: rawLogLevel as ApiConfig["logLevel"],
    bodyLimitBytes: readInt(env["REQUEST_BODY_LIMIT"], "REQUEST_BODY_LIMIT", DEFAULT_BODY_LIMIT),
    requestTimeoutMs: readInt(env["REQUEST_TIMEOUT_MS"], "REQUEST_TIMEOUT_MS", 30_000),
    shutdownTimeoutMs: readInt(env["SHUTDOWN_TIMEOUT_MS"], "SHUTDOWN_TIMEOUT_MS", 15_000),

    sessionCookieSameSite: parseSameSite(env["SESSION_COOKIE_SAMESITE"]),
    // Secure by default EVERYWHERE. Development must opt out explicitly, so a
    // missing variable can never silently produce an insecure production cookie.
    sessionCookieSecure: env["SESSION_COOKIE_SECURE"] !== "false",
    // 7 days. The handoff specifies an idle timeout but no absolute ceiling
    // (OD-033), so this is a conservative configurable default rather than an
    // invented business rule.
    sessionAbsoluteLifetimeMs: readInt(
      env["SESSION_ABSOLUTE_LIFETIME_MS"], "SESSION_ABSOLUTE_LIFETIME_MS", 7 * 24 * 3_600_000),
    // 8 hours — specified by handoff §3.
    sessionIdleTimeoutMs: readInt(
      env["SESSION_IDLE_TIMEOUT_MS"], "SESSION_IDLE_TIMEOUT_MS", 8 * 3_600_000),
    // 5 minutes. Precision of minutes is ample for an 8-hour window, and it
    // keeps a read path from writing a row on every request.
    sessionTouchIntervalMs: readInt(
      env["SESSION_TOUCH_INTERVAL_MS"], "SESSION_TOUCH_INTERVAL_MS", 300_000),
    // Read, never defaulted. A generated fallback would make every restart
    // invalidate every enrolled factor.
    mfaSecretKey: env["MFA_SECRET_KEY"] ?? null,
    mfaSecretKeyVersion: env["MFA_SECRET_KEY_VERSION"] ?? "v1",
    signingDeliveryKey: env["SIGNING_DELIVERY_KEY"] ?? null,
    signingDeliveryKeyVersion: env["SIGNING_DELIVERY_KEY_VERSION"] ?? "v1",
    signingAccessLifetimeMs: readInt(
      env["SIGNING_ACCESS_LIFETIME_MS"], "SIGNING_ACCESS_LIFETIME_MS",
      14 * 24 * 3_600_000),
    recipientSessionLifetimeMs: readInt(
      env["RECIPIENT_SESSION_LIFETIME_MS"], "RECIPIENT_SESSION_LIFETIME_MS",
      8 * 3_600_000),
  };

  assertProductionSafety(config);
  return config;
}

/**
 * Production-only checks.
 *
 * Deliberately not applied in development, where a permissive default is a
 * convenience rather than a vulnerability — but the moment `NODE_ENV` says
 * production, a configuration that would silently be insecure stops the boot.
 */
function parseSameSite(raw: string | undefined): "lax" | "strict" | "none" {
  const value = raw ?? "lax";
  if (value !== "lax" && value !== "strict" && value !== "none") {
    throw new ApiConfigError(
      `SESSION_COOKIE_SAMESITE must be lax, strict or none, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function assertProductionSafety(config: ApiConfig): void {
  if (config.environment !== "production") return;

  // Non-negotiable. A session cookie without Secure is sent over plaintext HTTP,
  // where any network position can read it.
  if (!config.sessionCookieSecure) {
    throw new ApiConfigError(
      "SESSION_COOKIE_SECURE=false is not permitted in production. A session "
      + "cookie without Secure is transmitted in the clear.",
    );
  }
  // `SameSite=None` disables the browser's cross-site protection entirely, and
  // without Secure the browser rejects the cookie outright.
  if (config.sessionCookieSameSite === "none" && !config.sessionCookieSecure) {
    throw new ApiConfigError("SameSite=none requires Secure cookies.");
  }
  if (config.sessionIdleTimeoutMs > config.sessionAbsoluteLifetimeMs) {
    // Otherwise the idle window can never elapse and the sliding expiry the
    // handoff requires would silently do nothing.
    throw new ApiConfigError(
      "SESSION_IDLE_TIMEOUT_MS cannot exceed SESSION_ABSOLUTE_LIFETIME_MS.",
    );
  }

  if (config.corsOrigins.length === 0) {
    // Not fatal in itself — an API on the same origin as its frontend needs no
    // CORS at all — but it is worth being explicit rather than surprising.
    return;
  }
  for (const origin of config.corsOrigins) {
    if (origin.startsWith("http://") && !origin.startsWith("http://localhost")) {
      throw new ApiConfigError(
        `Refusing to allow a plaintext CORS origin in production: ${origin}. `
        + "Session cookies are Secure, so a http:// origin cannot work anyway.",
      );
    }
  }
}
