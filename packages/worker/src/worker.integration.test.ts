// The worker against REAL PostgreSQL and a REAL pg-boss instance.
//
// The central claim — that a job insert can join a business transaction — is a
// claim about two libraries sharing one connection. "Both use PostgreSQL" does
// not make two connections atomic, so it is proven by rolling a transaction
// back and asserting no job exists.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgBoss } from "pg-boss";
import { sql } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import {
  IdempotencyCleanupJob, RateLimitCleanupJob, TerminalJobError,
  type IdempotencyRecordId, type IdempotencyScope, type IdempotencyKeyDigest,
  type RequestFingerprint,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, type LagdaDatabase,
  createIdempotencyRepository, createRateLimitCounterRepository,
} from "@lagda/db";
import { createJobScheduler } from "./queue/scheduler.js";
import {
  handleIdempotencyCleanup, handleRateLimitCleanup, parseCleanupPayload,
} from "./handlers/cleanup.js";
import { loadWorkerConfig, WorkerConfigError, type WorkerConfig } from "./config/index.js";
import { registerSystemHandler, ensureQueue } from "./server/start-worker.js";

const AT = Date.parse("2026-08-09T10:00:00.000Z");
const SCHEMA = "pgboss_test";

/** Waits for a condition without a fixed sleep, so tests stay fast and stable. */
async function until(
  predicate: () => Promise<boolean>, timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the queue.");
}

describe.skipIf(!hasIntegrationDatabase())("worker and queue on PostgreSQL", () => {
  let database: LagdaDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    database = await createTestDatabase();
    boss = new PgBoss({
      connectionString: process.env["DATABASE_TEST_URL"] ?? "",
      schema: SCHEMA,
      migrate: true,
      max: 2,
    });
    boss.on("error", () => undefined);
    await boss.start();
  }, 90_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await database?.close();
  });

  // ── Queue consistency: the decisive property ─────────────────────────────

  describe("transactional enqueue", () => {
    const QUEUE = "test.transactional";

    beforeAll(async () => { await boss.createQueue(QUEUE); });

    beforeEach(async () => {
      await sql.raw(`delete from ${SCHEMA}.job where name = '${QUEUE}'`).execute(database.db);
      // Only the rows this suite creates. A blanket delete trips the
      // ON DELETE RESTRICT relationships other suites leave behind.
      await database.db.deleteFrom("workspaces")
        .where("workspace_id", "in", ["ws_tx", "ws_rb"]).execute();
    });

    const definition = { ...IdempotencyCleanupJob, type: QUEUE as never };

    async function queuedCount(): Promise<number> {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from ${sql.raw(SCHEMA)}.job where name = ${QUEUE}
      `.execute(database.db);
      return Number(rows[0]?.n ?? 0);
    }

    it("COMMITS the business write and the job together", async () => {
      const scheduler = createJobScheduler(boss);

      await database.db.transaction().execute(async (trx) => {
        await trx.insertInto("workspaces").values({
          workspace_id: "ws_tx", name: "A",
          created_at: new Date(AT),
        }).execute();

        // The job insert rides the SAME transaction.
        await scheduler.enqueue(definition, { batchSize: 10 }, { transaction: trx });
      });

      const workspace = await database.db.selectFrom("workspaces").selectAll()
        .where("workspace_id", "=", "ws_tx").executeTakeFirst();
      expect(workspace).toBeDefined();
      expect(await queuedCount()).toBe(1);
    }, 30_000);

    it("ROLLS BACK the job with the business write", async () => {
      // The property an outbox would otherwise be needed for. Without the
      // transaction handle, this job would survive a failed mutation and the
      // worker would act on state that never existed.
      const scheduler = createJobScheduler(boss);

      await expect(
        database.db.transaction().execute(async (trx) => {
          await trx.insertInto("workspaces").values({
            workspace_id: "ws_rb", name: "B",
            created_at: new Date(AT),
          }).execute();
          await scheduler.enqueue(definition, { batchSize: 10 }, { transaction: trx });
          throw new Error("business rule violated");
        }),
      ).rejects.toThrow("business rule violated");

      const workspace = await database.db.selectFrom("workspaces").selectAll()
        .where("workspace_id", "=", "ws_rb").executeTakeFirst();
      expect(workspace).toBeUndefined();
      // No orphaned job.
      expect(await queuedCount()).toBe(0);
    }, 30_000);

    it("enqueues outside a transaction when no business write accompanies it", async () => {
      // Correct for maintenance work: there is no state to be atomic with.
      const scheduler = createJobScheduler(boss);
      await scheduler.enqueue(definition, { batchSize: 10 });
      expect(await queuedCount()).toBe(1);
    }, 30_000);

    it("refuses an oversized payload", async () => {
      // A payload this large means someone is queueing a document rather than
      // an identifier.
      const scheduler = createJobScheduler(boss);
      await expect(
        scheduler.enqueue(
          definition as never, { blob: "x".repeat(20_000) } as never,
        ),
      ).rejects.toThrow(/exceeds/);
    });
  });

  // ── Consume, retry, failure ──────────────────────────────────────────────

  describe("job execution", () => {
    it("delivers an enqueued job to a handler", async () => {
      const QUEUE = "test.deliver";
      await boss.createQueue(QUEUE);
      const received: unknown[] = [];

      await boss.work(QUEUE, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) received.push(job.data);
        return Promise.resolve();
      });

      await boss.send(QUEUE, { batchSize: 5 });
      await until(() => Promise.resolve(received.length > 0));

      expect(received[0]).toEqual({ batchSize: 5 });
      await boss.offWork(QUEUE);
    }, 30_000);

    it("RETRIES a transient failure and then succeeds", async () => {
      const QUEUE = "test.retry";
      await boss.createQueue(QUEUE);
      let attempts = 0;

      await boss.work(QUEUE, { batchSize: 1 }, async () => {
        attempts += 1;
        // Fails twice, succeeds on the third — the shape of a dependency blip.
        if (attempts < 3) throw new Error("transient dependency failure");
        return Promise.resolve();
      });

      await boss.send(QUEUE, {}, { retryLimit: 3, retryDelay: 1, retryBackoff: false });
      await until(() => Promise.resolve(attempts >= 3), 25_000);

      expect(attempts).toBe(3);
      await boss.offWork(QUEUE);
    }, 40_000);

    it("stops retrying and records a FAILED job", async () => {
      // Nothing retries forever. A permanently failing job must become
      // inspectable rather than loop.
      const QUEUE = "test.failure";
      await boss.createQueue(QUEUE);
      // Clear rows from a previous run. Without this the wait predicate matches
      // a stale failed row immediately and the test passes before the handler
      // has run even once - a green test asserting nothing.
      await sql.raw(`delete from ${SCHEMA}.job where name = '${QUEUE}'`).execute(database.db);
      let attempts = 0;

      await boss.work(QUEUE, { batchSize: 1 }, () => {
        attempts += 1;
        return Promise.reject(new Error("permanent failure"));
      });

      await boss.send(QUEUE, {}, { retryLimit: 1, retryDelay: 1, retryBackoff: false });

      await until(async () => {
        const { rows } = await sql<{ state: string }>`
          select state from ${sql.raw(SCHEMA)}.job where name = ${QUEUE}
        `.execute(database.db);
        return rows.some(r => r.state === "failed");
      }, 25_000);

      // Two executions: the original plus one retry. Not unbounded.
      expect(attempts).toBe(2);
      await boss.offWork(QUEUE);
    }, 40_000);

    it("CREATES its queues, carrying the declared retry bound", async () => {
      // Regression. pg-boss 12 does not create queues implicitly, and the worker
      // did not create them either: it died on boot with "Queue
      // idempotency.cleanup not found". Every test above passed, because tests
      // create their own queues. Only running the built process found it.
      const definition = { ...IdempotencyCleanupJob, type: "test.ensure" as never };
      await sql.raw(`delete from ${SCHEMA}.queue where name = 'test.ensure'`)
        .execute(database.db);

      expect(await boss.getQueue("test.ensure")).toBeNull();
      await ensureQueue(boss, definition);

      const created = await boss.getQueue("test.ensure");
      expect(created).not.toBeNull();
      // The bound reaches the QUEUE, not only individual sends. Recurring jobs
      // are sent by pg-boss's own scheduler and never pass through LAGDA's
      // JobScheduler, so a per-send bound would not apply to them.
      expect(created?.retryLimit).toBe(IdempotencyCleanupJob.maxAttempts - 1);
      expect(created?.retryBackoff).toBe(true);

      // Idempotent: a restart against an existing queue must not throw.
      await ensureQueue(boss, definition);
      expect(await boss.getQueue("test.ensure")).not.toBeNull();
    }, 30_000);

    it("PROPAGATES a handler failure through the worker's own registration", async () => {
      // The tests above drive `boss.work` directly, which proves pg-boss retries
      // but proves nothing about LAGDA's wrapper. The wrapper logs the failure
      // and must then RETHROW: catching it would report success to the queue and
      // silently discard the work. Exercised through the real registration path,
      // because a guarantee no test reaches is a guarantee only in the comment.
      const QUEUE = "test.wrapper-failure";
      await boss.createQueue(QUEUE);
      await sql.raw(`delete from ${SCHEMA}.job where name = '${QUEUE}'`).execute(database.db);

      const attemptsSeen: number[] = [];
      await registerSystemHandler(
        boss,
        { concurrencyOverride: 1 } as unknown as WorkerConfig,
        { ...IdempotencyCleanupJob, type: QUEUE as never },
        (_raw, context) => {
          attemptsSeen.push(context.attempt);
          return Promise.reject(new Error("handler exploded"));
        },
      );

      await boss.send(QUEUE, { batchSize: 1 },
        { retryLimit: 1, retryDelay: 1, retryBackoff: false });

      await until(async () => {
        const { rows } = await sql<{ state: string }>`
          select state from ${sql.raw(SCHEMA)}.job where name = ${QUEUE}
        `.execute(database.db);
        return rows.some(r => r.state === "failed");
      }, 25_000);

      // Reached the queue as a failure, not as a success.
      expect(attemptsSeen.length).toBeGreaterThanOrEqual(2);
      // Attempts are 1-based for humans; pg-boss counts retries from 0.
      expect(attemptsSeen[0]).toBe(1);
      expect(attemptsSeen[1]).toBe(2);
      await boss.offWork(QUEUE);
    }, 40_000);
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  describe("cleanup handlers", () => {
    const context = {
      tenantScope: "system" as const, jobId: "job_1",
      jobType: "idempotency.cleanup" as const, attempt: 1,
    };

    beforeEach(async () => {
      await database.db.deleteFrom("idempotency_records").execute();
      await database.db.deleteFrom("rate_limit_counters").execute();
    });

    const deps = () => ({
      idempotency: createIdempotencyRepository(database.db),
      rateLimits: createRateLimitCounterRepository(database.db),
      clock: { now: () => AT + 10_000 },
    });

    it("deletes only expired idempotency records", async () => {
      const scope: IdempotencyScope = { type: "workspace", workspaceId: "ws_a" as WorkspaceId };
      const repo = createIdempotencyRepository(database.db);
      await repo.claim({
        recordId: "idem_old" as IdempotencyRecordId, scope,
        operation: "signingRequest.send",
        keyDigest: "a".repeat(64) as IdempotencyKeyDigest,
        requestFingerprint: "b".repeat(64) as RequestFingerprint,
        now: AT, expiresAt: AT + 1000,
      });
      await repo.claim({
        recordId: "idem_live" as IdempotencyRecordId, scope,
        operation: "signingRequest.send",
        keyDigest: "c".repeat(64) as IdempotencyKeyDigest,
        requestFingerprint: "b".repeat(64) as RequestFingerprint,
        now: AT, expiresAt: AT + 86_400_000,
      });

      const outcome = await handleIdempotencyCleanup({ batchSize: 100 }, context, deps());

      expect(outcome.deleted).toBe(1);
      // The unexpired record survives — deleting it would let a duplicate run.
      expect(await repo.find(scope, "signingRequest.send", "c".repeat(64) as IdempotencyKeyDigest))
        .not.toBeNull();
    });

    it("is safe to run twice", async () => {
      // At-least-once delivery means every handler runs more than once
      // eventually, including after a database restore.
      const first = await handleIdempotencyCleanup({ batchSize: 100 }, context, deps());
      const second = await handleIdempotencyCleanup({ batchSize: 100 }, context, deps());
      expect(first.deleted).toBe(0);
      expect(second.deleted).toBe(0);
    });

    it("deletes only expired rate-limit counters", async () => {
      const repo = createRateLimitCounterRepository(database.db);
      await repo.increment({
        policyId: "auth.signin.ip", scopeType: "ip", scopeKey: "a".repeat(64),
        windowStart: AT, expiresAt: AT + 1000,
      });
      await repo.increment({
        policyId: "auth.signin.ip", scopeType: "ip", scopeKey: "b".repeat(64),
        windowStart: AT, expiresAt: AT + 86_400_000,
      });

      const outcome = await handleRateLimitCleanup({ batchSize: 100 }, context, deps());

      expect(outcome.deleted).toBe(1);
      // A live counter surviving is a security property: deleting it would
      // reset an attacker's attempt count.
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from rate_limit_counters
      `.execute(database.db);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it("REJECTS a malformed payload as terminal", () => {
      // The queue is not trusted because LAGDA wrote to it: it holds rows from
      // a previous deployment, and possibly rows written by hand.
      for (const bad of [{}, { batchSize: 0 }, { batchSize: "many" },
                         { batchSize: 10, extra: true }, null]) {
        expect(() => parseCleanupPayload(bad)).toThrow(TerminalJobError);
      }
    });

    it("accepts a valid payload", () => {
      expect(parseCleanupPayload({ batchSize: 100 })).toEqual({ batchSize: 100 });
    });
  });

  // ── Schedules ────────────────────────────────────────────────────────────

  it("registers a recurring schedule idempotently", async () => {
    // Several worker instances start at once. pg-boss keys schedules by queue
    // name, so repeated registration is an upsert — a `setInterval` in each
    // process would instead give N sweeps per hour.
    const QUEUE = "test.schedule";
    await boss.createQueue(QUEUE);

    await boss.schedule(QUEUE, "0 * * * *", { batchSize: 1 }, { tz: "UTC" });
    await boss.schedule(QUEUE, "0 * * * *", { batchSize: 1 }, { tz: "UTC" });
    await boss.schedule(QUEUE, "0 * * * *", { batchSize: 1 }, { tz: "UTC" });

    const { rows } = await sql<{ n: string; timezone: string }>`
      select count(*) as n, max(timezone) as timezone
      from ${sql.raw(SCHEMA)}.schedule where name = ${QUEUE}
    `.execute(database.db);
    expect(Number(rows[0]?.n)).toBe(1);
    // UTC in the stored row, not merely in the call. A server-local cron would
    // shift silently with the deployment's timezone, and the drift would only
    // show up as sweeps running at the wrong hour.
    expect(rows[0]?.timezone).toBe("UTC");

    await boss.unschedule(QUEUE);
  }, 30_000);
});

// ── Configuration, no database required ─────────────────────────────────────

describe("worker configuration", () => {
  it("defaults schedules OFF", () => {
    // So importing or starting a worker in a test never registers a recurring
    // sweep against a shared database.
    expect(loadWorkerConfig({}).schedulesEnabled).toBe(false);
  });

  it("rejects a zero pool", () => {
    // "0 means unlimited" is never offered: an unbounded pool exhausts the
    // connections shared with every API replica.
    expect(() => loadWorkerConfig({ QUEUE_POOL_MAX: "0" })).toThrow(WorkerConfigError);
  });

  it("rejects an out-of-range batch size", () => {
    expect(() => loadWorkerConfig({ CLEANUP_BATCH_SIZE: "0" })).toThrow(WorkerConfigError);
    expect(() => loadWorkerConfig({ CLEANUP_BATCH_SIZE: "999999" })).toThrow(WorkerConfigError);
  });

  it("rejects a malformed cron expression", () => {
    expect(() => loadWorkerConfig({ CLEANUP_CRON: "every hour" })).toThrow(WorkerConfigError);
  });

  it("rejects a non-numeric setting rather than defaulting", () => {
    expect(() => loadWorkerConfig({ QUEUE_POOL_MAX: "4x" })).toThrow(WorkerConfigError);
  });

  it("declares every job with a retry bound and an idempotency strategy", () => {
    // Nothing retries forever, and no job leaves retry safety implicit.
    for (const definition of [IdempotencyCleanupJob, RateLimitCleanupJob]) {
      expect(definition.maxAttempts).toBeGreaterThan(0);
      expect(definition.maxAttempts).toBeLessThanOrEqual(10);
      expect(definition.idempotencyStrategy.length).toBeGreaterThan(20);
      expect(definition.tenantScope).toBe("system");
      expect(definition.concurrency).toBeGreaterThan(0);
    }
  });
});
