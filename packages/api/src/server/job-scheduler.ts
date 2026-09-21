// The pg-boss adapter, for the API's own use as a PUBLISH-ONLY producer.
//
// `packages/worker/src/queue/scheduler.ts` already implements exactly this —
// but that file lives in `@lagda/worker`, which the API does not and must not
// depend on (the same reasoning as `@lagda/security`'s own header comment,
// applied in the other direction: pulling in pg-boss's job-CONSUMPTION
// surface, or any worker-role code, into the process that must never run a
// queue consumer). Phase 1-B is the first thing that needs the API itself to
// ENQUEUE a job (immediate completion processing, right after a signing
// submission commits) rather than only ever being enqueued FOR by the
// worker's own schedules — so this file mirrors that one's adapter exactly,
// duplicated rather than shared, for the same reason
// `packages/security/src/completion-identifiers.ts` duplicates a handful of
// the API's own id generators instead of re-pointing either process's
// composition root at the other's package.
//
// ── The atomicity mechanism ────────────────────────────────────────────────
//
// pg-boss's `send()` accepts `db?: IDatabase`, an interface whose only required
// member is `executeSql(text, values)`. Passing an adapter backed by an open
// Kysely transaction makes pg-boss insert its job row **through that
// transaction** — so business state and the intent to follow it up commit or
// roll back together. See the worker's own copy of this file for the
// integration test that proves it.

// INV-190 / OD-046. This file IS the queue adapter the rule says to extract,
// and after moving the client construction here out of start-server.ts it is
// the ONLY place under packages/api that names pg-boss at all.
//
// The isolation INV-190 protects is not enforced by this comment. It is
// enforced by two things: `createCompletionQueue` hands back
// `{ scheduler, close }` with no boss on it, so no caller can reach `.work`;
// and `job-scheduler.consumer.test.ts` asserts this file's own source
// contains no consumption call, and fails if a `boss` is ever added to that
// returned object. Lift verbatim into a shared queue package (OD-046) and
// delete this directive — the body is already identical to the worker's copy.
//
// The directive sits on the line directly above the import on purpose:
// `eslint-disable-next-line` means the NEXT line, and an explanation placed
// between the two silently disables nothing.
// eslint-disable-next-line no-restricted-imports
import { PgBoss, type SendOptions } from "pg-boss";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import type {
  JobDefinition, JobReference, JobScheduleOptions, JobScheduler,
} from "@lagda/application";
import type { Database } from "@lagda/db";

function transactionAdapter(trx: Transaction<Database>): {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
} {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const compiled = sql.raw(text).compile(trx);
      const result = await trx.executeQuery({
        ...compiled,
        parameters: values,
      });
      return { rows: result.rows };
    },
  };
}

const MAX_PAYLOAD_BYTES = 16 * 1024;

export function createJobScheduler(boss: PgBoss): JobScheduler {
  return {
    async enqueue<TPayload>(
      definition: JobDefinition<TPayload>,
      payload: TPayload,
      options: JobScheduleOptions & { transaction?: unknown } = {},
    ): Promise<JobReference> {
      const serialized = JSON.stringify(payload);
      if (serialized === undefined) {
        throw new TypeError(`Job ${definition.type} payload is not serializable.`);
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new TypeError(
          `Job ${definition.type} payload exceeds ${String(MAX_PAYLOAD_BYTES)} bytes. `
          + "Queue an identifier and let the handler load the resource.",
        );
      }

      const sendOptions: SendOptions = {
        retryLimit: definition.maxAttempts - 1,
        retryDelay: definition.retryBackoffSeconds,
        retryBackoff: true,
        ...(options.startAfter === undefined
          ? {}
          : { startAfter: new Date(options.startAfter) }),
        ...(options.singletonKey === undefined
          ? {}
          : { singletonKey: options.singletonKey }),
        ...(options.singletonSeconds === undefined
          ? {}
          : { singletonSeconds: options.singletonSeconds }),
        ...(options.transaction === undefined
          ? {}
          : { db: transactionAdapter(options.transaction as Transaction<Database>) }),
      };

      const jobId = await boss.send(
        definition.type,
        payload as unknown as object,
        sendOptions,
      );

      return { jobId, type: definition.type };
    },
  };
}

/**
 * A PUBLISH-ONLY queue client for the HTTP process.
 *
 * Enqueueing and shutting down are the only two things an API process may do
 * with a queue. The returned handle exposes exactly those and nothing else —
 * in particular it does not expose the PgBoss instance, so `.work()` is not
 * reachable from a caller even by accident. That is the difference between an
 * invariant and a note asking people to remember one.
 *
 * `migrate: false` because the WORKER owns pg-boss's schema, for the same
 * reason the API never runs database migrations: during a rolling deploy
 * every replica would race to alter it.
 */
export interface CompletionQueue {
  readonly scheduler: JobScheduler;
  close: () => Promise<void>;
}

export async function createCompletionQueue(
  config: { readonly connectionString: string },
): Promise<CompletionQueue> {
  const boss = new PgBoss({
    connectionString: config.connectionString,
    schema: "pgboss",
    migrate: false,
    max: 2,
  });
  boss.on("error", () => undefined);
  await boss.start();
  return {
    scheduler: createJobScheduler(boss),
    close: () => boss.stop({ graceful: false }),
  };
}
