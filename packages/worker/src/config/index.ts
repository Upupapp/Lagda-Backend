// Worker runtime configuration.
//
// Parsed once at startup, `process.env` read here and nowhere else — the same
// rule the API follows, for the same reason.

export interface WorkerConfig {
  /** pg-boss's own PostgreSQL schema. Separate from LAGDA's tables. */
  readonly queueSchema: string;
  /**
   * Whether pg-boss creates and migrates its own schema on start.
   *
   * True by default: hand-maintaining another project's schema in LAGDA
   * migrations is a burden with no benefit, and pg-boss versions its own.
   * Configurable to false so a deployment that requires all DDL to run in a
   * controlled step can do that instead.
   */
  readonly queueMigrate: boolean;
  readonly queuePoolMax: number;
  readonly shutdownTimeoutMs: number;
  /** Off in tests, so a suite does not race a background sweep. */
  readonly schedulesEnabled: boolean;
  readonly cleanupCron: string;
  readonly cleanupBatchSize: number;
  readonly concurrencyOverride?: number;
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

function readInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new WorkerConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}.`);
  }
  return Number(raw);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const queuePoolMax = readInt(env["QUEUE_POOL_MAX"], "QUEUE_POOL_MAX", 4);
  if (queuePoolMax < 1) {
    // "0 means unlimited" is never offered: an unbounded pool exhausts
    // PostgreSQL connections shared with every API replica.
    throw new WorkerConfigError("QUEUE_POOL_MAX must be at least 1.");
  }

  const cleanupBatchSize = readInt(env["CLEANUP_BATCH_SIZE"], "CLEANUP_BATCH_SIZE", 500);
  if (cleanupBatchSize < 1 || cleanupBatchSize > 10_000) {
    throw new WorkerConfigError("CLEANUP_BATCH_SIZE must be between 1 and 10000.");
  }

  const concurrency = env["WORKER_CONCURRENCY"];
  if (concurrency !== undefined && concurrency !== "") {
    const parsed = readInt(concurrency, "WORKER_CONCURRENCY", 1);
    if (parsed < 1) throw new WorkerConfigError("WORKER_CONCURRENCY must be at least 1.");
  }

  // Hourly, at UTC. Frequent enough that expired rows do not accumulate,
  // infrequent enough that the sweep is invisible.
  const cleanupCron = env["CLEANUP_CRON"] ?? "0 * * * *";
  if (cleanupCron.trim().split(/\s+/).length !== 5) {
    throw new WorkerConfigError(`CLEANUP_CRON must be a 5-field cron expression.`);
  }

  return {
    queueSchema: env["QUEUE_SCHEMA"] ?? "pgboss",
    queueMigrate: env["QUEUE_MIGRATE"] !== "false",
    queuePoolMax,
    shutdownTimeoutMs: readInt(env["WORKER_SHUTDOWN_TIMEOUT_MS"], "WORKER_SHUTDOWN_TIMEOUT_MS", 30_000),
    // Disabled unless explicitly enabled, so importing or starting a worker in
    // a test never registers a recurring schedule against a shared database.
    schedulesEnabled: env["WORKER_SCHEDULES_ENABLED"] === "true",
    cleanupCron,
    cleanupBatchSize,
    ...(concurrency === undefined || concurrency === ""
      ? {} : { concurrencyOverride: Number(concurrency) }),
  };
}
