// Finding deliveries whose queue work went missing.
//
// ── The window this closes ─────────────────────────────────────────────────
//
// The intent, the delivery and the queue job are written in one transaction, so
// they commit together. That makes the common case safe.
//
// It does not make every case safe. A queue row can still be lost afterwards: a
// table truncated by an operator, a job dead-lettered and purged, a migration
// that rebuilt the queue. The delivery row survives all of those, and without a
// sweep it sits at PENDING forever — a message nobody sends and nothing reports
// (S131, S132).
//
// ── Why this is not a resend ───────────────────────────────────────────────
//
// Reconciliation recovers the delivery of one logical notification that was
// already decided (S133). It creates no intent, mints no credential, and
// changes no state. A user-requested resend is a different operation owned by
// the domain that owns the credential, and it is allowed to rotate secrets;
// this is not (S41, S44).
//
// ── Why it only reports ────────────────────────────────────────────────────
//
// It returns what it found. It does not re-enqueue, because there is nothing to
// enqueue INTO yet — the handler that would run the job cannot send mail until
// BACKEND-45 supplies a provider. Re-enqueueing now would produce a job that
// runs, finds no transport, and fails, over and over, at a rate proportional to
// the backlog.

import type {
  NotificationRepository, NotificationDeliveryRecord,
} from "../common/ports/notifications.js";
import type { Clock } from "../common/ports/index.js";

/**
 * How long a PENDING delivery must sit before it counts as stranded.
 *
 * Long enough that ordinary queue latency, a slow worker or a brief restart
 * never registers. A sweep that reports healthy backlog as stranded is a sweep
 * whose output gets ignored.
 */
export const RECONCILIATION_GRACE_MS = 15 * 60 * 1000;

/** Bounded, so one sweep cannot read an unbounded backlog into memory. */
export const RECONCILIATION_BATCH_SIZE = 200;

export interface ReconciliationReport {
  /** Deliveries pending past the grace period. */
  readonly stranded: readonly NotificationDeliveryRecord[];
  /** True when the batch limit was reached and more may remain. */
  readonly truncated: boolean;
}

export interface ReconcileNotificationDeliveriesDependencies {
  readonly notifications: NotificationRepository;
  readonly clock: Clock;
}

export function reconcileNotificationDeliveries(
  deps: ReconcileNotificationDeliveriesDependencies,
) {
  return async (transaction?: unknown): Promise<ReconciliationReport> => {
    const olderThan = deps.clock.now() - RECONCILIATION_GRACE_MS;
    const stranded = await deps.notifications.findPendingDeliveries(
      olderThan, RECONCILIATION_BATCH_SIZE, transaction);

    // Reported rather than silently capped. A sweep that truncates without
    // saying so reads as "nothing more is wrong".
    return { stranded, truncated: stranded.length === RECONCILIATION_BATCH_SIZE };
  };
}
