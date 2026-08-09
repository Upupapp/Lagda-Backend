// The worker process.
//
// A SEPARATE process role from the API, in the same codebase and the same
// release artifact. The API must never start queue consumers: they scale,
// restart and fail for different reasons, and coupling them means one cannot be
// restarted without the other.

import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import {
  createDatabase, loadDatabaseConfig, createIdempotencyRepository,
  createRateLimitCounterRepository, type LagdaDatabase,
} from "@lagda/db";
import {
  IdempotencyCleanupJob, RateLimitCleanupJob, JOB_DEFINITIONS,
  type JobDefinition, type SystemJobContext,
} from "@lagda/application";
import { loadWorkerConfig, type WorkerConfig } from "../config/index.js";
import {
  handleIdempotencyCleanup, handleRateLimitCleanup, type CleanupDependencies,
} from "../handlers/cleanup.js";

export interface StartedWorker {
  readonly config: WorkerConfig;
  readonly boss: PgBoss;
  close(): Promise<void>;
}

/**
 * Structured logging, matching the API's conventions.
 *
 * Written directly rather than by importing `@lagda/api` — the worker must not
 * depend on the HTTP package. The FIELDS are what an aggregator queries, and
 * they are the same ones the API emits, so a job failure is findable next to the
 * request that caused it.
 */
function emit(
  level: "info" | "error" | "fatal",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level: level === "fatal" ? 60 : level === "error" ? 50 : 30,
    time: Date.now(),
    service: "lagda-backend",
    processRole: "worker",
    event,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
}

export async function startWorker(): Promise<StartedWorker> {
  // 1. Configuration. An invalid concurrency or retry setting stops the process
  //    here rather than producing a subtly wrong worker.
  const config = loadWorkerConfig();
  const databaseConfig = loadDatabaseConfig();

  // 2. The application database. NO MIGRATIONS — the same invariant the API
  //    holds. Migration is an explicit deployment step, and a worker that
  //    migrated on boot would race every API replica during a rolling deploy.
  const database: LagdaDatabase = createDatabase(databaseConfig);

  const reachable = await database.ping();
  if (!reachable) {
    await database.close();
    throw new Error(`Database is not reachable at ${database.describe()}.`);
  }

  // 3. pg-boss. It owns its own schema in a SEPARATE PostgreSQL schema
  //    (`pgboss`), managed by the library rather than by LAGDA migrations —
  //    hand-writing another project's schema is a maintenance burden with no
  //    benefit. `migrate` is configurable so a deployment that wants the schema
  //    created by a controlled step can disable it here.
  const boss = new PgBoss({
    connectionString: databaseConfig.connectionString,
    schema: config.queueSchema,
    migrate: config.queueMigrate,
    // Its own small pool, separate from the application pool. Sized modestly:
    // the total connection count across API replicas, worker application pool
    // and this is a real production constraint (BACKEND-61).
    max: config.queuePoolMax,
  });

  boss.on("error", (error: Error) => {
    // pg-boss surfaces background failures here. Swallowing them would leave a
    // worker that looks alive and consumes nothing.
    emit("error", "worker.queue_error", { error: error.message });
  });

  await boss.start();

  // 4. Handlers. Registered centrally and explicitly — no filesystem scanning,
  //    so what runs is what a reviewer can see.
  const cleanupDeps: CleanupDependencies = {
    idempotency: createIdempotencyRepository(database.db),
    rateLimits: createRateLimitCounterRepository(database.db),
    clock: { now: () => Date.now() },
  };

  // 4a. Queues must EXIST before anything works or schedules against them.
  //     pg-boss 12 does not create them implicitly: without this the process
  //     died on boot with "Queue idempotency.cleanup not found". The integration
  //     tests did not catch it because they create their own queues — the gap
  //     between a green suite and a process that starts.
  for (const definition of [IdempotencyCleanupJob, RateLimitCleanupJob]) {
    await ensureQueue(boss, definition);
  }

  await registerSystemHandler(boss, config, IdempotencyCleanupJob, (raw, context) =>
    handleIdempotencyCleanup(raw, context, cleanupDeps));
  await registerSystemHandler(boss, config, RateLimitCleanupJob, (raw, context) =>
    handleRateLimitCleanup(raw, context, cleanupDeps));

  // 5. Recurring schedules, registered through pg-boss rather than a Node
  //    timer. `setInterval` disappears on restart and duplicates across worker
  //    instances; pg-boss's schedule table is keyed by queue name, so repeated
  //    registration by several workers is an upsert rather than a duplicate.
  if (config.schedulesEnabled) {
    for (const definition of [IdempotencyCleanupJob, RateLimitCleanupJob]) {
      await boss.schedule(
        definition.type,
        config.cleanupCron,
        { batchSize: config.cleanupBatchSize },
        // UTC explicitly. A server-local cron would silently shift with the
        // deployment's timezone.
        { tz: "UTC" },
      );
    }
  }

  emit("info", "worker.started", {
    jobTypes: JOB_DEFINITIONS.map(d => d.type),
    schedulesEnabled: config.schedulesEnabled,
  });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Idempotent. An orchestrator commonly sends SIGTERM then SIGINT moments
    // later, and two concurrent shutdowns would close the pool twice.
    if (closing !== null) return closing;
    closing = (async () => {
      emit("info", "worker.stopping");
      try {
        // Graceful: stop accepting new work, let active handlers finish within
        // the bound. Unfinished jobs stay durable and are retried — the queue
        // is the recovery mechanism, not a best-effort drain.
        await boss.stop({ graceful: true, timeout: config.shutdownTimeoutMs });
      } catch (error) {
        emit("error", "worker.stop_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await database.close();
      emit("info", "worker.stopped");
    })();
    return closing;
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      emit("info", "worker.signal", { signal });
      void close().then(() => { process.exit(0); });
    });
  }

  return { config, boss, close };
}

/**
 * Registers one system-scoped handler.
 *
 * Payload validation, observability and failure classification all live here,
 * so a handler is a small function rather than a queue callback carrying
 * infrastructure concerns.
 */
/**
 * Creates a queue if it is absent, and carries the definition's retry policy
 * onto the queue itself.
 *
 * The queue-level policy matters beyond convenience: recurring jobs are sent by
 * pg-boss's scheduler, not by LAGDA's `JobScheduler`, so the per-send retry
 * bound never reaches them. Without a bound HERE, a failing scheduled cleanup
 * would inherit the library default rather than the policy this codebase
 * declares (INV-193).
 *
 * Checked-then-created rather than created-unconditionally, so a restart against
 * an existing queue is a no-op instead of an error.
 */
export async function ensureQueue<TPayload>(
  boss: PgBoss,
  definition: JobDefinition<TPayload>,
): Promise<void> {
  const existing = await boss.getQueue(definition.type);
  if (existing !== null) return;
  await boss.createQueue(definition.type, {
    retryLimit: definition.maxAttempts - 1,
    retryDelay: definition.retryBackoffSeconds,
    retryBackoff: true,
  });
}

export async function registerSystemHandler<TPayload>(
  boss: PgBoss,
  config: WorkerConfig,
  definition: JobDefinition<TPayload>,
  handler: (raw: unknown, context: SystemJobContext) => Promise<unknown>,
): Promise<void> {
  await boss.work(
    definition.type,
    {
      // `includeMetadata` so `retryCount` is available. Without it the attempt
      // number would have to be guessed, and "attempt 1" on every retry makes
      // a retry storm indistinguishable from healthy traffic.
      includeMetadata: true,
      batchSize: config.concurrencyOverride ?? 1,
    },
    async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) {
        const started = performance.now();
        const context: SystemJobContext = {
          tenantScope: "system",
          jobId: job.id,
          jobType: definition.type,
          // pg-boss counts retries from 0; humans count attempts from 1.
          attempt: job.retryCount + 1,
        };

        try {
          const result = await handler(job.data, context);
          emit("info", "worker.job_completed", {
            jobId: job.id, jobType: definition.type, attempt: context.attempt,
            durationMs: Math.round(performance.now() - started),
            result: "success",
            // The RESULT SHAPE only — never `job.data`. A payload may carry
            // resource identifiers, and a full dump is how PII reaches logs.
            ...(typeof result === "object" && result !== null ? result : {}),
          });
        } catch (error) {
          const terminal = error instanceof Error && "retryable" in error
            && (error as { retryable: unknown }).retryable === false;

          emit("error", "worker.job_failed", {
            jobId: job.id, jobType: definition.type, attempt: context.attempt,
            durationMs: Math.round(performance.now() - started),
            result: "failure",
            errorCategory: terminal ? "terminal" : "retryable",
            error: error instanceof Error ? error.message : String(error),
          });

          // RETHROWN, always. Catching and returning success would silently
          // lose the work — the failure mode this whole layer exists to
          // prevent. pg-boss records the failure and applies the retry policy.
          throw error;
        }
      }
    },
  );
}
