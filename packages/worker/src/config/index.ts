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

  // ── Notification delivery (BACKEND-45) ────────────────────────────────────

  /** How often the dispatcher sweeps for due deliveries and expired leases. */
  readonly dispatchCron: string;
  readonly expiryCron: string;
  readonly expiryBatchSize: number;
  readonly dispatchBatchSize: number;
  /**
   * How long a worker may hold a delivery claim before it is reclaimable.
   *
   * Must exceed the provider timeout with room to spare, or a slow-but-working
   * send is reclaimed underneath itself and retried — manufacturing exactly the
   * duplicate the lease exists to prevent.
   */
  readonly deliveryLeaseMs: number;
  /** Bounded. Nothing retries forever, least of all a credential-bearing mail. */
  readonly deliveryMaxAttempts: number;
  /**
   * Where first-party links point. Configuration only, never a request header
   * (S147).
   */
  readonly appBaseUrl: string;
  /** Opens sealed signing credentials at render time. Null disables delivery. */
  readonly signingDeliveryKey: string | null;
  readonly signingDeliveryKeyVersion: string;
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

  // Bounded like the cleanups. A sweep that took an unbounded batch would hold
  // one global read open across an arbitrary number of workspace transactions.
  const expiryBatchSize = readInt(env["EXPIRY_BATCH_SIZE"], "EXPIRY_BATCH_SIZE", 200);
  if (expiryBatchSize < 1 || expiryBatchSize > 10_000) {
    throw new WorkerConfigError("EXPIRY_BATCH_SIZE must be between 1 and 10000.");
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

  const dispatchBatchSize = readInt(
    env["DISPATCH_BATCH_SIZE"], "DISPATCH_BATCH_SIZE", 200);
  if (dispatchBatchSize < 1 || dispatchBatchSize > 10_000) {
    throw new WorkerConfigError("DISPATCH_BATCH_SIZE must be between 1 and 10000.");
  }

  // Every minute. A security email waiting an hour for a sweep is a login the
  // user gave up on, so this is deliberately far more frequent than the
  // cleanup cron beside it — the two look similar and are not.
  // Every fifteen minutes by default. A deadline is a DATE the sender chose,
  // not a moment: expiring at 00:07 instead of 00:00 changes nothing anyone
  // can observe, and a per-minute sweep would read the index 1440 times a day
  // to find nothing almost every time. Far less frequent than dispatch, where
  // a security email waiting is a login the user gave up on.
  const expiryCron = env["EXPIRY_CRON"] ?? "*/15 * * * *";
  if (expiryCron.trim().split(/\s+/).length !== 5) {
    throw new WorkerConfigError("EXPIRY_CRON must be a 5-field cron expression.");
  }

  const dispatchCron = env["DISPATCH_CRON"] ?? "* * * * *";
  if (dispatchCron.trim().split(/\s+/).length !== 5) {
    throw new WorkerConfigError("DISPATCH_CRON must be a 5-field cron expression.");
  }

  const deliveryLeaseMs = readInt(
    env["DELIVERY_LEASE_MS"], "DELIVERY_LEASE_MS", 120_000);
  // The floor is not arbitrary: EMAIL_TIMEOUT_MS is capped at 30s, and a lease
  // shorter than the provider call it protects reclaims a send in flight.
  if (deliveryLeaseMs < 60_000 || deliveryLeaseMs > 900_000) {
    throw new WorkerConfigError("DELIVERY_LEASE_MS must be between 60000 and 900000.");
  }

  const deliveryMaxAttempts = readInt(
    env["DELIVERY_MAX_ATTEMPTS"], "DELIVERY_MAX_ATTEMPTS", 3);
  if (deliveryMaxAttempts < 1 || deliveryMaxAttempts > 10) {
    throw new WorkerConfigError("DELIVERY_MAX_ATTEMPTS must be between 1 and 10.");
  }

  const appBaseUrl = env["APP_BASE_URL"] ?? "";
  if (appBaseUrl !== "") {
    try {
      // Parsed here so a malformed base stops the process at boot rather than
      // producing a broken signing link in a real invitation.
      void new URL(appBaseUrl);
    } catch {
      throw new WorkerConfigError("APP_BASE_URL must be an absolute URL.");
    }
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
    dispatchCron,
    expiryCron,
    expiryBatchSize,
    dispatchBatchSize,
    deliveryLeaseMs,
    deliveryMaxAttempts,
    appBaseUrl,
    signingDeliveryKey: env["SIGNING_DELIVERY_KEY"] ?? null,
    signingDeliveryKeyVersion: env["SIGNING_DELIVERY_KEY_VERSION"] ?? "v1",
  };
}
