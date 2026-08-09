// Database configuration, parsed and validated ONCE.
//
// This is the only place in the backend that reads `process.env` for database
// settings. Repositories never do — a repository that reads the environment is
// one that behaves differently depending on where it runs.
//
// Invalid configuration fails HERE, at startup, rather than surfacing as a
// confusing failure inside an unrelated request an hour later.

/** Parsed configuration. Contains the URL, so it is never logged whole. */
export interface DatabaseConfig {
  readonly connectionString: string;
  readonly poolMin: number;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  /** TLS. Off for local development, required in production — see `describe`. */
  readonly ssl: boolean;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(`Database configuration is invalid: ${message}`);
    this.name = "DatabaseConfigError";
  }
}

function requiredInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  // `Number("10abc")` is NaN, and `parseInt` would silently accept it as 10.
  // A pool size that quietly became something else is worth failing over.
  if (!Number.isInteger(value) || value < 0) {
    throw new DatabaseConfigError(`${name} must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const connectionString = env["DATABASE_URL"];
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new DatabaseConfigError("DATABASE_URL is required.");
  }

  // Parsed rather than pattern-matched, so a malformed URL fails now.
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    // The URL is NOT echoed — it carries the password.
    throw new DatabaseConfigError("DATABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new DatabaseConfigError(
      `DATABASE_URL must be a PostgreSQL URL, got protocol "${parsed.protocol}".`,
    );
  }

  const poolMin = requiredInt(env["DATABASE_POOL_MIN"], 0, "DATABASE_POOL_MIN");
  // Conservative on purpose. PostgreSQL tolerates many connections; a pool
  // sized for the database rather than for the workload is how a handful of
  // processes exhaust `max_connections`.
  const poolMax = requiredInt(env["DATABASE_POOL_MAX"], 10, "DATABASE_POOL_MAX");
  if (poolMax < 1) throw new DatabaseConfigError("DATABASE_POOL_MAX must be at least 1.");
  if (poolMin > poolMax) {
    throw new DatabaseConfigError("DATABASE_POOL_MIN cannot exceed DATABASE_POOL_MAX.");
  }

  return {
    connectionString,
    poolMin,
    poolMax,
    connectionTimeoutMs: requiredInt(env["DATABASE_CONNECTION_TIMEOUT_MS"], 10_000, "DATABASE_CONNECTION_TIMEOUT_MS"),
    idleTimeoutMs: requiredInt(env["DATABASE_IDLE_TIMEOUT_MS"], 30_000, "DATABASE_IDLE_TIMEOUT_MS"),
    // Never `rejectUnauthorized: false`. If a managed PostgreSQL needs a custom
    // CA, that is configured deliberately — disabling verification turns TLS
    // into decoration.
    ssl: env["DATABASE_SSL"] === "true",
  };
}

/**
 * A safe description for logs and health output.
 *
 * The connection string contains a password, so it is never logged. This
 * returns host, port and database name only — enough to answer "which database
 * am I talking to?" without leaking credentials.
 */
export function describeDatabase(config: DatabaseConfig): string {
  const parsed = new URL(config.connectionString);
  const database = parsed.pathname.replace(/^\//, "") || "(default)";
  return `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
}
