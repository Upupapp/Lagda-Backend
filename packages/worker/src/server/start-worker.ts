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
  createRateLimitCounterRepository, createPasswordResetRepository,
  type LagdaDatabase,
} from "@lagda/db";
import {
  IdempotencyCleanupJob, RateLimitCleanupJob, NotificationDeliveryJob,
  NotificationDispatchJob, JOB_DEFINITIONS,
  createTemplateRegistry, ALL_TEMPLATES, createNotificationLinkBuilder,
  noopMetrics,
  type JobDefinition, type SystemJobContext,
  type DeliverNotificationDependencies, type NotificationDeliveryId,
  type NotificationTransportRepository, type NotificationDeliveryUnitOfWork,
  type CompleteAttemptInput, type ClaimDeliveryInput,
} from "@lagda/application";
import { createTransactionManager } from "@lagda/db";
import { loadPostmarkConfig, createPostmarkEmailProvider, EmailConfigError } from "@lagda/email";
import {
  createSealedSecretResolver, createChallengeSecretResolver,
  createNotificationSecretResolver,
} from "@lagda/security";
import { randomUUID } from "node:crypto";
import { createJobScheduler } from "../queue/scheduler.js";
import {
  handleNotificationDelivery, recordDeliveryOutcome,
} from "../handlers/notification-delivery.js";
import {
  handleNotificationDispatch,
} from "../handlers/notification-dispatch.js";
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

  // ── 4b. Notification delivery (BACKEND-45) ─────────────────────────────────
  //
  // Registered only when the deployment can actually send. Three things are
  // required and none of them has a safe default: a provider token, a key that
  // opens sealed credentials, and the base URL links point at.
  //
  // Absent any of them, the handlers are NOT registered and the reason is
  // logged once at boot. That is deliberately louder than the alternatives. A
  // worker that registered anyway would claim deliveries it cannot complete,
  // burn their attempt budgets, and leave a queue that looks busy; one that
  // threw would stop idempotency and rate-limit cleanup from running on a
  // deployment that has simply not configured email yet.
  const transactions = createTransactionManager(database.db);
  const scheduler = createJobScheduler(boss);
  const clock = { now: () => Date.now() };

  const missing = deliveryPrerequisites(config);
  if (missing.length > 0) {
    emit("info", "worker.notification_delivery_disabled", { missing });
  } else {
    // Throws on a malformed value even though presence is already established:
    // a bad message stream or an unparseable timeout is a deployment fault that
    // must stop the process rather than surface on the first password reset.
    let postmark;
    try {
      postmark = loadPostmarkConfig(process.env);
    } catch (error) {
      if (error instanceof EmailConfigError) {
        throw new Error(`Email delivery is misconfigured: ${error.message}`);
      }
      throw error;
    }

    const provider = createPostmarkEmailProvider(postmark);

    // CHALLENGE credentials live in the domain that minted them (OD-184), and
    // password_reset_challenges carries no tenant column -- an account security
    // record belongs to a person, not a workspace -- so it is read on the plain
    // connection rather than through a scoped unit of work.
    const passwordResets = createPasswordResetRepository(database.db);
    const challengeSecrets = createChallengeSecretResolver(
      config.signingDeliveryKey, config.signingDeliveryKeyVersion,
      {
        findSealedIfActive: (sourceId, now) => passwordResets.findSealedIfActive({
          challengeId: sourceId as never, now,
        }),
      },
      clock,
    );
    const templates = createTemplateRegistry(ALL_TEMPLATES);
    const links = createNotificationLinkBuilder(config.appBaseUrl);

    /**
     * Builds one delivery's dependencies, bound to that delivery's own scope.
     *
     * The scope comes from the dispatch index and never from the job payload,
     * so an operator who writes a queue row by hand cannot nominate the tenant
     * it runs in.
     */
    const dependenciesFor = async (
      notificationDeliveryId: NotificationDeliveryId,
    ): Promise<DeliverNotificationDependencies | null> => {
      const ref = await transactions.runGlobal(uow =>
        uow.notificationDispatch.findScope(notificationDeliveryId));
      if (ref === null) return null;

      // "Is this credential still usable" is a question for the domain that
      // minted it, asked in that domain's own transaction rather than inside
      // the delivery's. A sealed signing credential is always workspace-owned,
      // so a sealed reference under an account scope is a composition error and
      // answers false rather than reaching for a workspace that is not there.
      const validity = {
        isStillUsable: (grantId: string): Promise<boolean> =>
          ref.scope.kind === "WORKSPACE"
            ? transactions.runForWorkspace(ref.scope.workspaceId, uow =>
              uow.signingAccess.isGrantUsable(grantId, clock.now()))
            : Promise.resolve(false),
      };

      return {
        transport: delegatingTransport,
        templates,
        // Both reference kinds, dispatched by a table rather than an if-chain
        // so a third kind becomes a compile error instead of a silent fall
        // through to "unusable".
        secrets: createNotificationSecretResolver(
          createSealedSecretResolver(
            config.signingDeliveryKey, config.signingDeliveryKeyVersion, validity),
          challengeSecrets),
        links,
        provider,
        ids: {
          nextNotificationDeliveryAttemptId: () =>
            `nda_${randomUUID()}` as NotificationDeliveryId as never,
        },
        clock,
        policy: {
          maxAttempts: config.deliveryMaxAttempts,
          leaseMs: config.deliveryLeaseMs,
        },
        // Each phase gets its OWN short transaction in the delivery's scope.
        // The provider call happens between them, holding none (S71, S73).
        runInTransaction: operation =>
          transactions.runForNotificationDelivery(ref.scope, uow => operation(uow)),
      };
    };

    // Separately rather than in a loop: the two carry different payload types,
    // and a loop over both widens the element type to a union that no longer
    // matches `ensureQueue`'s bound.
    await ensureQueue(boss, NotificationDeliveryJob);
    await ensureQueue(boss, NotificationDispatchJob);

    await registerSystemHandler(boss, config, NotificationDispatchJob, (raw, context) =>
      handleNotificationDispatch(raw, context, { transactions, scheduler, clock })
        .then(outcome => {
          // Truncation is the signal worth having here: a sweep that keeps
          // filling its batch means the backlog is growing faster than the
          // cadence drains it, and that is invisible in a success count.
          emit("info", "worker.notification_dispatch", { ...outcome });
          return outcome;
        }));
    await registerSystemHandler(boss, config, NotificationDeliveryJob,
      async (raw, context) => {
        const started = performance.now();
        const outcome = await handleNotificationDelivery(
          raw, context, { dependenciesFor });

        // Instrumented, collecting nothing. `noopMetrics` is the honest state
        // until BACKEND-66 selects an exporter -- the same INSTRUMENTED_NO_
        // EXPORTER position the API reports, rather than a claim that delivery
        // is being measured.
        recordDeliveryOutcome(noopMetrics, outcome, performance.now() - started);

        // S213. The delivery id and the outcome, and nothing else. Not the
        // destination (S214), not the subject or body (S215), not the provider
        // message reference -- which is the field most tempting to correlate on
        // and the one that ties a log line to a specific person's mail.
        emit("info", "worker.notification_delivery", {
          result: outcome.result,
          notificationDeliveryId:
            (raw as { notificationDeliveryId?: string }).notificationDeliveryId,
        });
        return outcome;
      });

    emit("info", "worker.notification_delivery_enabled", {
      provider: "postmark",
      leaseMs: config.deliveryLeaseMs,
      maxAttempts: config.deliveryMaxAttempts,
    });
  }

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

    // Its own cadence, far more frequent than cleanup. The two look alike and
    // are not: a security email waiting an hour for a sweep is a login the user
    // gave up on.
    if (deliveryPrerequisites(config).length === 0) {
      await boss.schedule(
        NotificationDispatchJob.type,
        config.dispatchCron,
        { batchSize: config.dispatchBatchSize },
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


/**
 * What is missing before this deployment can send email.
 *
 * Returns names rather than a boolean, so the boot log says which one to set
 * instead of "delivery disabled" — the difference between a two-minute fix and
 * an afternoon.
 */
function deliveryPrerequisites(config: WorkerConfig): string[] {
  const missing: string[] = [];
  if ((process.env["POSTMARK_SERVER_TOKEN"] ?? "") === "") {
    missing.push("POSTMARK_SERVER_TOKEN");
  }
  if (config.signingDeliveryKey === null || config.signingDeliveryKey === "") {
    // Without it a sealed credential cannot be opened, and every secret-bearing
    // message would resolve UNUSABLE and be suppressed — a worker that looked
    // healthy while silently sending nothing.
    missing.push("SIGNING_DELIVERY_KEY");
  }
  if (config.appBaseUrl === "") missing.push("APP_BASE_URL");
  return missing;
}

/**
 * Forwards each call to the repository carried by the transaction it is given.
 *
 * `DeliverNotificationDependencies` holds one `transport` for the whole run
 * while each phase opens its own transaction, and the db adapter's repositories
 * close over a transaction rather than taking one. This is the seam between
 * those two shapes, and it is exactly what the `transaction: unknown` parameter
 * on every port method exists for.
 */
const delegatingTransport: NotificationTransportRepository = {
  claimForDelivery: (input: ClaimDeliveryInput, transaction: unknown) =>
    (transaction as NotificationDeliveryUnitOfWork)
      .notificationTransport.claimForDelivery(input, transaction),
  completeAttempt: (input: CompleteAttemptInput, transaction: unknown) =>
    (transaction as NotificationDeliveryUnitOfWork)
      .notificationTransport.completeAttempt(input, transaction),
  reclaimExpiredLeases: (now: number, limit: number, transaction: unknown) =>
    (transaction as NotificationDeliveryUnitOfWork)
      .notificationTransport.reclaimExpiredLeases(now, limit, transaction),
  listAttempts: (id, transaction: unknown) =>
    (transaction as NotificationDeliveryUnitOfWork)
      .notificationTransport.listAttempts(id, transaction),
  applyConfirmedProviderEvent: (input, transaction: unknown) =>
    (transaction as NotificationDeliveryUnitOfWork)
      .notificationTransport.applyConfirmedProviderEvent(input, transaction),
};
