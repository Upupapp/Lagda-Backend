// The pg-boss adapter.
//
// ── The atomicity mechanism ────────────────────────────────────────────────
//
// pg-boss's `send()` accepts `db?: IDatabase`, an interface whose only required
// member is `executeSql(text, values)`. Passing an adapter backed by an open
// Kysely transaction makes pg-boss insert its job row **through that
// transaction** — so business state and the intent to follow it up commit or
// roll back together.
//
// That is what removes the need for an outbox table, and it was verified
// against the installed version's types rather than assumed. It is also proven
// by an integration test that rolls a transaction back and asserts no job
// exists: "both use PostgreSQL" does NOT by itself make two connections atomic.

import type { PgBoss, SendOptions } from "pg-boss";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import type {
  JobDefinition, JobReference, JobScheduleOptions, JobScheduler,
} from "@lagda/application";
import type { Database } from "@lagda/db";

/**
 * Bridges a Kysely transaction to the interface pg-boss expects.
 *
 * Deliberately minimal: pg-boss asks for `executeSql` and gets exactly that.
 * The optional `listen` capability is NOT implemented — a transaction is not a
 * place to hold a LISTEN subscription, and pg-boss only uses it for its own
 * polling on the main connection.
 */
function transactionAdapter(trx: Transaction<Database>): {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
} {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      // `sql.raw` with separately bound parameters — the text comes from
      // pg-boss, the values are parameterised, so nothing is concatenated.
      const compiled = sql.raw(text).compile(trx);
      const result = await trx.executeQuery({
        ...compiled,
        parameters: values,
      });
      return { rows: result.rows };
    },
  };
}

/** Guards against a payload becoming a second database. */
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
        // A payload this large means someone is queueing a document or a
        // resource snapshot. Jobs carry identifiers; the worker reloads
        // authoritative state.
        throw new TypeError(
          `Job ${definition.type} payload exceeds ${String(MAX_PAYLOAD_BYTES)} bytes. `
          + "Queue an identifier and let the handler load the resource.",
        );
      }

      const sendOptions: SendOptions = {
        retryLimit: definition.maxAttempts - 1,
        retryDelay: definition.retryBackoffSeconds,
        // Exponential, so a failing dependency is not hammered at a fixed
        // interval by every retry in the queue.
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
        // THE line that provides atomicity. Absent, pg-boss uses its own pool
        // and the insert commits independently of the caller's transaction.
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
