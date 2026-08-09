// Durable abuse counters.
//
// The increment is ONE statement. A read followed by a write is a race two
// processes both lose — and losing it here hands extra attempts to whoever is
// attacking.

import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { RateLimitCounterRepository } from "@lagda/application";
import type { Database } from "../schema/index.js";

type Executor = Kysely<Database> | Transaction<Database>;

export function createRateLimitCounterRepository(
  db: Executor,
): RateLimitCounterRepository {
  return {
    async increment(input): Promise<number> {
      const windowStart = new Date(input.windowStart);

      // `INSERT … ON CONFLICT … DO UPDATE … RETURNING` is atomic: PostgreSQL
      // serializes concurrent upserts on the primary key, so ten simultaneous
      // requests receive ten distinct counts, never two of the same.
      //
      // Deliberately NOT a transaction of its own. It is one statement, and
      // wrapping it would add a round trip for nothing — and if the caller is
      // already inside a transaction, the counter would roll back with it,
      // which would let a failed attempt go uncounted.
      const { rows } = await sql<{ count: number }>`
        insert into rate_limit_counters
          (policy, scope_type, scope_key, window_start, count, expires_at, updated_at)
        values (
          ${input.policyId}, ${input.scopeType}, ${input.scopeKey},
          ${windowStart}, 1, ${new Date(input.expiresAt)}, now()
        )
        on conflict (policy, scope_type, scope_key, window_start)
        do update set
          count = rate_limit_counters.count + 1,
          updated_at = now()
        returning count
      `.execute(db);

      const count = rows[0]?.count;
      if (count === undefined) {
        // Unreachable for a RETURNING upsert, and treated as a store failure
        // rather than silently reported as "1" — which would reset every
        // attacker's counter on each request.
        throw new Error("Rate-limit counter returned no row.");
      }
      return count;
    },

    async deleteExpired(before: number, limit: number): Promise<number> {
      // Bounded, so cleanup cannot lock the table for an unbounded time on the
      // hottest security path.
      //
      // Raw SQL and `ctid` because the table has a composite primary key: a
      // tuple `IN (subquery)` is awkward to express through the query builder,
      // and `ctid` batches a delete on any table without needing a surrogate
      // key the counters do not otherwise need.
      const { rows } = await sql<{ deleted: string }>`
        with doomed as (
          select ctid from rate_limit_counters
          where expires_at <= ${new Date(before)}
          limit ${limit}
        )
        delete from rate_limit_counters
        where ctid in (select ctid from doomed)
        returning 1 as deleted
      `.execute(db);
      return rows.length;
    },
  };
}
