// PostgreSQL adapter for delivery claiming and attempt history.
//
// ── The claim is one statement, and that is the whole point ────────────────
//
// `UPDATE … WHERE state IN (…) AND (next_attempt_at IS NULL OR next_attempt_at
// <= now)` decides eligibility and takes the lease in a single conditional
// write. Two workers handed the same job both run it; exactly one matches a
// claimable row, because PostgreSQL serialises the update and the second sees a
// row already in PROCESSING.
//
// Reading the state and then updating would let both read PENDING and both
// proceed to a provider — sending one security email twice, and passing every
// single-threaded test on the way in. The same argument the completion run
// makes for its own claim.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No provider call, and no way to make one: this module imports no HTTP client
// and its transaction must be closed before a send begins (S71, S73).

import type { Selectable, Transaction } from "kysely";
import type {
  NotificationTransportRepository, ClaimDeliveryInput, ClaimedDelivery,
  CompleteAttemptInput, NotificationDeliveryAttemptRecord,
  NotificationDeliveryAttemptId, NotificationDeliveryId, NotificationIntentId,
  AttemptOutcome, AttemptFailureCode,
} from "@lagda/application";
import type { Database, NotificationDeliveryAttemptsTable } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { createNotificationRepository } from "./notifications.js";

type Trx = Transaction<Database>;

/** States a claim may be taken from. Anything else is not sendable work. */
const CLAIMABLE_STATES = ["PENDING", "FAILED_RETRYABLE"] as const;

function toAttempt(
  row: Selectable<NotificationDeliveryAttemptsTable>,
): NotificationDeliveryAttemptRecord {
  return {
    notificationDeliveryAttemptId:
      row.notification_delivery_attempt_id as NotificationDeliveryAttemptId,
    notificationDeliveryId: row.notification_delivery_id as NotificationDeliveryId,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at.getTime(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.getTime() }),
    ...(row.outcome === null ? {} : { outcome: row.outcome as AttemptOutcome }),
    ...(row.failure_code === null
      ? {}
      : { failureCode: row.failure_code as AttemptFailureCode }),
    ...(row.provider_message_reference === null
      ? {}
      : { providerMessageReference: row.provider_message_reference }),
  };
}

export function createNotificationTransportRepository(
  trx: Trx,
): NotificationTransportRepository {
  const notifications = createNotificationRepository(trx);

  return {
    async claimForDelivery(input: ClaimDeliveryInput): Promise<ClaimedDelivery | null> {
      try {
        // One conditional write: eligibility, the lease and the attempt counter
        // move together. `attempt_count` is incremented HERE rather than after
        // the provider call, so a crash mid-send still burns an attempt — the
        // alternative retries forever against a provider that keeps timing out.
        const claimed = await trx.updateTable("notification_deliveries")
          .set(eb => ({
            state: "PROCESSING",
            attempt_count: eb("attempt_count", "+", 1),
            processing_started_at: new Date(input.now),
            claim_expires_at: new Date(input.now + input.leaseMs),
          }))
          .where("notification_delivery_id", "=", input.notificationDeliveryId as string)
          .where("state", "in", [...CLAIMABLE_STATES])
          .where(eb => eb.or([
            eb("next_attempt_at", "is", null),
            eb("next_attempt_at", "<=", new Date(input.now)),
          ]))
          .returningAll()
          .executeTakeFirst();

        // Not an error. Another worker won the race, the delivery was cancelled
        // or suppressed while queued, or the backoff has not elapsed.
        if (claimed === undefined) return null;

        await trx.insertInto("notification_delivery_attempts")
          .values({
            notification_delivery_attempt_id: input.attemptId as string,
            notification_delivery_id: input.notificationDeliveryId as string,
            workspace_id: claimed.workspace_id,
            user_id: claimed.user_id,
            attempt_number: claimed.attempt_count,
            started_at: new Date(input.now),
            completed_at: null,
            outcome: null,
            failure_code: null,
            provider_message_reference: null,
          })
          .execute();

        const intent = await notifications.findIntentById(
          claimed.notification_intent_id as NotificationIntentId);
        if (intent === null) {
          // The FK makes this unreachable; if it ever fires, the transaction
          // rolls back and the claim is released rather than held over a
          // delivery nothing can render.
          throw new PersistenceMappingError(
            "notification_deliveries", "notification_intent_id",
            "Claimed a delivery whose intent is not readable.");
        }

        const delivery = await notifications.findDeliveryById(
          input.notificationDeliveryId);
        if (delivery === null) {
          throw new PersistenceMappingError(
            "notification_deliveries", "notification_delivery_id",
            "Claimed a delivery that is no longer readable.");
        }

        const attemptRow = await trx.selectFrom("notification_delivery_attempts")
          .selectAll()
          .where("notification_delivery_attempt_id", "=", input.attemptId as string)
          .executeTakeFirstOrThrow();

        return { delivery, intent, attempt: toAttempt(attemptRow) };
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async completeAttempt(input: CompleteAttemptInput): Promise<boolean> {
      try {
        // Conditional on the attempt still being open. A duplicated completion
        // — a retried job whose first pass succeeded after the worker lost its
        // connection — must not write a second outcome over the first.
        const attempt = await trx.updateTable("notification_delivery_attempts")
          .set({
            completed_at: new Date(input.now),
            outcome: input.outcome,
            failure_code: input.failureCode ?? null,
            provider_message_reference: input.providerMessageReference ?? null,
          })
          .where("notification_delivery_attempt_id", "=", input.attemptId as string)
          .where("completed_at", "is", null)
          .executeTakeFirst();

        if (Number(attempt.numUpdatedRows ?? 0n) !== 1) return false;

        // The lease is released in the same statement that moves the state, so
        // a delivery can never sit in a non-PROCESSING state holding a claim —
        // which the CHECK constraint would refuse anyway.
        await trx.updateTable("notification_deliveries")
          .set({
            state: input.nextState,
            processing_started_at: null,
            claim_expires_at: null,
            next_attempt_at:
              input.nextAttemptAt === undefined ? null : new Date(input.nextAttemptAt),
            ...(input.providerMessageReference === undefined
              ? {}
              : { provider_message_reference: input.providerMessageReference }),
          })
          .where("notification_delivery_id", "=", input.notificationDeliveryId as string)
          .where("state", "=", "PROCESSING")
          .execute();

        return true;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async applyConfirmedProviderEvent(input) {
      // One conditional UPDATE, guarded on the states the transition table
      // permits. PROVIDER_ACCEPTED is the only origin for either edge: a
      // callback about a delivery that was never accepted, or that already
      // reached a terminal state, matches zero rows and moves nothing.
      //
      // This is where duplicate, out-of-order and late callbacks all become
      // no-ops without a dedupe table -- the state machine already forbids
      // every regression they could cause.
      const moved = await trx.updateTable("notification_deliveries")
        .set({
          state: input.state,
          // The lease is released. A delivery that reached a terminal state
          // while a claim was somehow outstanding must not keep one, or the
          // reclaim sweep would resurrect it.
          processing_started_at: null,
          claim_expires_at: null,
          next_attempt_at: null,
        })
        .where("notification_delivery_id", "=", input.notificationDeliveryId as string)
        .where("state", "=", "PROVIDER_ACCEPTED")
        .returning("notification_delivery_id")
        .executeTakeFirst();

      return moved !== undefined;
    },

    async reclaimExpiredLeases(now, limit) {
      // Back to FAILED_RETRYABLE rather than PENDING: the attempt was made and
      // its budget consumed, and calling it pending again would present a
      // crashed send as work that had never been tried.
      const rows = await trx.updateTable("notification_deliveries")
        .set({
          state: "FAILED_RETRYABLE",
          processing_started_at: null,
          claim_expires_at: null,
          next_attempt_at: new Date(now),
        })
        .where("state", "=", "PROCESSING")
        .where("claim_expires_at", "<=", new Date(now))
        .where("notification_delivery_id", "in", eb => eb
          .selectFrom("notification_deliveries")
          .select("notification_delivery_id")
          .where("state", "=", "PROCESSING")
          .where("claim_expires_at", "<=", new Date(now))
          .limit(limit))
        .returning("notification_delivery_id")
        .execute();

      return rows.map(row => row.notification_delivery_id as NotificationDeliveryId);
    },

    async listAttempts(notificationDeliveryId) {
      const rows = await trx.selectFrom("notification_delivery_attempts")
        .selectAll()
        .where("notification_delivery_id", "=", notificationDeliveryId as string)
        .orderBy("attempt_number", "asc")
        .execute();
      return rows.map(toAttempt);
    },
  };
}
