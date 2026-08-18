// Finding transport work, across every tenant.
//
// ── What this closes ───────────────────────────────────────────────────────
//
// BACKEND-44 created durable PENDING deliveries and BACKEND-45 built the
// transport that sends one. Between them sat nothing: no process asked which
// deliveries were due, because asking spans tenants and a connection without a
// tenant sees nothing under RLS (OD-174).
//
// `notification_dispatch_index` answers the question with identifiers only.
// This use case reads it in a GLOBAL transaction, learns each delivery's scope,
// and then does every write inside that scope. A global read never becomes a
// global write.
//
// ── Why reclaim runs before enqueue ────────────────────────────────────────
//
// A reclaimed lease becomes FAILED_RETRYABLE with `next_attempt_at` set to now,
// which makes it due immediately. Running reclaim first means a delivery
// abandoned by a dead worker is re-enqueued in the SAME tick rather than
// waiting a full interval for the next one — and a security email should not
// wait an interval because a container restarted.
//
// ── Why this is not a claim ────────────────────────────────────────────────
//
// Enqueuing is not claiming. Two dispatchers running concurrently will enqueue
// the same delivery twice, and that is harmless by design: the claim is one
// conditional UPDATE, so the second job finds the row already claimed and
// returns NOT_CLAIMABLE without touching a provider. Trying to make dispatch
// exactly-once would put a second lock in front of the lock that already works.

import type { TransactionManager, Clock } from "../common/ports/index.js";
import type { JobScheduler } from "../common/ports/jobs.js";
import type { DispatchRef } from "../common/ports/notifications.js";
import { NotificationDeliveryJob } from "../jobs/definitions.js";

export interface DispatchDependencies {
  readonly transactions: Pick<
    TransactionManager, "runGlobal" | "runForNotificationDelivery"
  >;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  /**
   * How many of each kind to handle per tick.
   *
   * Bounded, and reported when it bites. An unbounded sweep on a large backlog
   * holds one transaction open across every tenant's rows, which is the shape
   * of an outage rather than a recovery.
   */
  readonly batchSize: number;
}

export interface DispatchOutcome {
  /** Leases returned to FAILED_RETRYABLE after their holder disappeared. */
  readonly reclaimed: number;
  readonly enqueued: number;
  /**
   * Whether either list filled its batch.
   *
   * Reported rather than hidden (S157). A sweep that silently truncates reads
   * as "nothing left to do", which is the one wrong answer a backlog monitor
   * must never be given.
   */
  readonly truncated: boolean;
}

/**
 * Groups refs by the scope they must be entered in.
 *
 * One transaction per distinct scope rather than one per delivery: a workspace
 * with forty abandoned leases is one transaction, not forty. The key is
 * prefixed by kind so a workspace id and a user id can never collide.
 */
function byScope(refs: readonly DispatchRef[]): Map<string, DispatchRef> {
  const scopes = new Map<string, DispatchRef>();
  for (const ref of refs) {
    const key = ref.scope.kind === "WORKSPACE"
      ? `w:${ref.scope.workspaceId}`
      : `u:${ref.scope.userId}`;
    if (!scopes.has(key)) scopes.set(key, ref);
  }
  return scopes;
}

export function dispatchNotifications(deps: DispatchDependencies) {
  return async (): Promise<DispatchOutcome> => {
    const now = deps.clock.now();

    // ── Reclaim ──────────────────────────────────────────────────────────────
    const expired = await deps.transactions.runGlobal(uow =>
      uow.notificationDispatch.listExpiredClaims(now, deps.batchSize));

    let reclaimed = 0;
    for (const ref of byScope(expired).values()) {
      // Inside the delivery's OWN scope. The reclaim statement is scoped by
      // RLS, so it returns that tenant's expired leases and no other's — which
      // is why grouping by scope is correct rather than merely cheaper.
      reclaimed += await deps.transactions.runForNotificationDelivery(
        ref.scope,
        async uow => {
          const ids = await uow.notificationTransport.reclaimExpiredLeases(
            now, deps.batchSize, null);
          return ids.length;
        });
    }

    // ── Enqueue ──────────────────────────────────────────────────────────────
    //
    // Read AFTER the reclaim, so this tick sees what the reclaim just freed.
    const due = await deps.transactions.runGlobal(uow =>
      uow.notificationDispatch.listDue(deps.clock.now(), deps.batchSize));

    for (const ref of due) {
      // The payload is the delivery id and nothing else (S265). The worker
      // resolves the scope from the index itself, so a hand-written job cannot
      // name its own tenant.
      await deps.scheduler.enqueue(NotificationDeliveryJob, {
        notificationDeliveryId: ref.notificationDeliveryId,
      });
    }

    return {
      reclaimed,
      enqueued: due.length,
      truncated: expired.length >= deps.batchSize || due.length >= deps.batchSize,
    };
  };
}
