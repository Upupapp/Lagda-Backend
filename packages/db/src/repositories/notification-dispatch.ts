// Finding transport work without a tenant.
//
// ── The one table in the notification schema with no policy ────────────────
//
// `notification_dispatch_index` is derived from `notification_deliveries` by a
// trigger and carries no row level security, because the three callers below
// have no tenant by construction: a dispatcher asking which deliveries are due
// across every workspace, a sweep asking which leases expired, and a provider
// webhook holding one message reference and nothing else.
//
// The safety argument is the CONTENT, not a predicate — opaque identifiers, a
// bounded state and three timestamps. It is the shape `idempotency_records` and
// `signing_workflow_advance_intents` already established, and OD-174 records
// why the alternatives are worse.
//
// ── The discipline this file must keep ─────────────────────────────────────
//
// Every method returns identifiers and a scope, and nothing else. Widening any
// of them to return a destination, a subject or a failure reason would not be a
// convenience — it would move personal data into the one place LAGDA cannot
// protect with a policy.

import type { Transaction } from "kysely";
import type {
  NotificationDispatchRepository, DispatchRef, NotificationDeliveryId,
  NotificationScope,
} from "@lagda/application";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";

interface DispatchRow {
  readonly notification_delivery_id: string;
  readonly workspace_id: string | null;
  readonly user_id: string | null;
}

/**
 * Turns a row into the scope a caller must enter.
 *
 * Throws rather than defaulting when neither column is set. A CHECK constraint
 * makes that unreachable, and if it ever fires the honest outcome is a failed
 * sweep rather than a guess about whose delivery this is — a guess here would
 * mean opening the wrong tenant's transaction.
 */
function toDispatchRef(row: DispatchRow): DispatchRef {
  const scope: NotificationScope = row.workspace_id !== null
    ? { kind: "WORKSPACE", workspaceId: row.workspace_id as WorkspaceId }
    : row.user_id !== null
      ? { kind: "GLOBAL_USER", userId: row.user_id as UserId }
      : (() => {
        throw new PersistenceMappingError(
          "notification_dispatch_index", "workspace_id",
          "A dispatch row carries neither a workspace nor a user scope.");
      })();

  return {
    notificationDeliveryId:
      row.notification_delivery_id as NotificationDeliveryId,
    scope,
  };
}

const SENDABLE = ["PENDING", "FAILED_RETRYABLE"] as const;

export function createNotificationDispatchRepository(
  trx: Transaction<Database>,
): NotificationDispatchRepository {
  const columns = [
    "notification_delivery_id", "workspace_id", "user_id",
  ] as const;

  return {
    async listDue(now, limit) {
      const rows = await trx.selectFrom("notification_dispatch_index")
        .select(columns)
        .where("state", "in", [...SENDABLE])
        // A delivery that has never been attempted has no `next_attempt_at`,
        // and is due immediately. Written as an explicit OR rather than
        // coalescing to zero, because a NULL here means "never tried" and a
        // date in 1970 would mean the same thing only by accident.
        .where(eb => eb.or([
          eb("next_attempt_at", "is", null),
          eb("next_attempt_at", "<=", new Date(now)),
        ]))
        // Oldest first, so a backlog drains in the order it accumulated rather
        // than starving whatever sorts last.
        .orderBy("next_attempt_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toDispatchRef);
    },

    async listExpiredClaims(now, limit) {
      const rows = await trx.selectFrom("notification_dispatch_index")
        .select(columns)
        .where("state", "=", "PROCESSING")
        .where("claim_expires_at", "<=", new Date(now))
        .orderBy("claim_expires_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toDispatchRef);
    },

    async findByProviderReference(reference) {
      // By reference alone. The destination the provider reports is never a
      // lookup key (S39) — an attacker who guesses an address must not be able
      // to reach the delivery belonging to it.
      const row = await trx.selectFrom("notification_dispatch_index")
        .select(columns)
        .where("provider_message_reference", "=", reference)
        .executeTakeFirst();
      return row === undefined ? null : toDispatchRef(row);
    },
  };
}
