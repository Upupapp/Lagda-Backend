// 085. The Verify Document code-request throttle, on PostgreSQL.
//
// Each call is ONE transaction holding a transaction-scoped advisory lock on
// the verification key and then the pair key (always that order, so two
// calls cannot deadlock), so concurrent requests for one pair or one document
// are serialized and a rolling count is never a race.
//
// Keys arrive as domain-separated SHA-256 digests of what the caller TYPED
// (computed by the API's verification crypto — the one place that hashes
// them). Nothing here reads a document, a participant or a tenant.

import { sql, type Kysely, type Transaction } from "kysely";
import type {
  VerificationAccessThrottle, VerificationCodeReservation, VerificationThrottleRules,
} from "@lagda/application";
import type { Database } from "../schema/index.js";

type Trx = Transaction<Database>;

/** Rows past every window are purged this many at a time, as the store goes. */
const PURGE_BATCH = 100;

async function lock(trx: Trx, ...keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`verification-throttle:${key}`}, 0))`
      .execute(trx);
  }
}

async function purge(trx: Trx, now: number, rules: VerificationThrottleRules): Promise<void> {
  const horizon = new Date(now - Math.max(rules.pairDailyWindowMs, rules.verificationHourlyWindowMs));
  await sql`
    delete from verification_access_code_requests
     where request_id in (
       select request_id from verification_access_code_requests
        where requested_at <= ${horizon}
        limit ${PURGE_BATCH})
  `.execute(trx);
  // A pair state that has not moved for a full day and holds no live lockout
  // carries nothing the rules still read — except a streak, which is kept by
  // leaving any row with one.
  await sql`
    delete from verification_access_pair_states
     where pair_key in (
       select pair_key from verification_access_pair_states
        where updated_at <= ${horizon}
          and exhausted_streak = 0
          and (locked_until is null or locked_until <= ${new Date(now)})
        limit ${PURGE_BATCH})
  `.execute(trx);
}

export function createVerificationAccessThrottle(db: Kysely<Database>): VerificationAccessThrottle {
  return {
    reserveCodeRequest({ keys, now, rules }) {
      const { pairKey, verificationKey } = keys;
      return db.transaction().execute(async (trx): Promise<VerificationCodeReservation> => {
        await lock(trx, verificationKey, pairKey);

        const state = await trx.selectFrom("verification_access_pair_states")
          .where("pair_key", "=", pairKey)
          .select(["locked_until"])
          .executeTakeFirst();
        if (state !== undefined && state.locked_until !== null && state.locked_until.getTime() > now) {
          return { outcome: "limited", reason: "lockout", retryAt: state.locked_until.getTime() };
        }

        const forPair = await trx.selectFrom("verification_access_code_requests")
          .where("pair_key", "=", pairKey)
          .where("requested_at", ">", new Date(now - rules.pairDailyWindowMs))
          .select(["requested_at"])
          .orderBy("requested_at", "desc")
          .limit(rules.pairDailyLimit)
          .execute();
        const latest = forPair[0]?.requested_at.getTime();
        if (latest !== undefined && latest > now - rules.cooldownMs) {
          return { outcome: "limited", reason: "cooldown", retryAt: latest + rules.cooldownMs };
        }
        if (forPair.length >= rules.pairDailyLimit) {
          // The oldest of the newest `limit` — the one whose expiry frees a slot.
          const oldest = forPair[forPair.length - 1]?.requested_at.getTime() ?? now;
          return { outcome: "limited", reason: "pair-daily", retryAt: oldest + rules.pairDailyWindowMs };
        }

        const forVerification = await trx.selectFrom("verification_access_code_requests")
          .where("verification_key", "=", verificationKey)
          .where("requested_at", ">", new Date(now - rules.verificationHourlyWindowMs))
          .select(["requested_at"])
          .orderBy("requested_at", "desc")
          .limit(rules.verificationHourlyLimit)
          .execute();
        if (forVerification.length >= rules.verificationHourlyLimit) {
          const oldest = forVerification[forVerification.length - 1]?.requested_at.getTime() ?? now;
          return {
            outcome: "limited", reason: "verification-hourly",
            retryAt: oldest + rules.verificationHourlyWindowMs,
          };
        }

        await trx.insertInto("verification_access_code_requests").values({
          pair_key: pairKey, verification_key: verificationKey, requested_at: new Date(now),
        }).execute();
        // A fresh code is a fresh challenge window; the streak carries over.
        await trx.insertInto("verification_access_pair_states").values({
          pair_key: pairKey, attempts: 0, exhausted_streak: 0, locked_until: null,
          updated_at: new Date(now),
        }).onConflict(oc => oc.column("pair_key").doUpdateSet({
          attempts: 0, updated_at: new Date(now),
        })).execute();

        await purge(trx, now, rules);
        return { outcome: "allowed" };
      });
    },

    recordRedemption({ keys, now, success, rules }) {
      const { pairKey, verificationKey } = keys;
      return db.transaction().execute(async trx => {
        await lock(trx, verificationKey, pairKey);
        const state = await trx.selectFrom("verification_access_pair_states")
          .where("pair_key", "=", pairKey)
          .select(["attempts", "exhausted_streak", "locked_until"])
          .executeTakeFirst();

        let next: { attempts: number; exhausted_streak: number; locked_until: Date | null };
        if (success) {
          next = { attempts: 0, exhausted_streak: 0, locked_until: state?.locked_until ?? null };
        } else {
          const attempts = state?.attempts ?? 0;
          // An already-exhausted window spends nothing more.
          if (attempts >= rules.maxAttempts) return;
          let streak = state?.exhausted_streak ?? 0;
          let lockedUntil = state?.locked_until ?? null;
          if (attempts + 1 >= rules.maxAttempts) {
            streak += 1;
            if (streak >= rules.lockoutAfterExhausted) {
              lockedUntil = new Date(now + rules.lockoutMs);
              streak = 0;
            }
          }
          next = { attempts: attempts + 1, exhausted_streak: streak, locked_until: lockedUntil };
        }

        await trx.insertInto("verification_access_pair_states").values({
          pair_key: pairKey, ...next, updated_at: new Date(now),
        }).onConflict(oc => oc.column("pair_key").doUpdateSet({
          ...next, updated_at: new Date(now),
        })).execute();
      });
    },
  };
}
