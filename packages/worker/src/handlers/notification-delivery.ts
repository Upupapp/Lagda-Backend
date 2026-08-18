// The notification delivery handler.
//
// ── A thin seam, and deliberately so ───────────────────────────────────────
//
// Everything that decides anything lives in `deliverNotification`: the claim,
// the credential check, the render, the provider call and the state
// transition. This file validates a queue payload and calls it.
//
// That split is what makes the interesting behaviour testable without pg-boss,
// and it is why the use case takes `runInTransaction` rather than a
// `TransactionManager` — the worker resolves the scope, because a notification
// may be workspace- or user-scoped and only the delivery row knows which.
//
// The context is SYSTEM-scoped and unused. A delivery's tenant is a property of
// its row, not of the queue message, so the handler asks the dispatch index and
// enters the scope it names — see `dependenciesFor`.
//
// ── At-least-once, assumed rather than hoped ───────────────────────────────
//
// pg-boss will deliver this job twice. The handler does nothing to prevent
// that and does not need to: the claim is a conditional UPDATE, so a duplicate
// job finds the row already claimed or already terminal and returns
// NOT_CLAIMABLE without touching a provider.

import { Value } from "@sinclair/typebox/value";
import {
  NotificationDeliveryPayloadSchema, TerminalJobError,
  deliverNotification,
  type NotificationDeliveryPayload, type NotificationDeliveryId,
  type DeliverNotificationDependencies, type DeliveryRunOutcome,
  type SystemJobContext,
} from "@lagda/application";

/**
 * Validates the queue payload.
 *
 * The queue is not trusted because LAGDA wrote to it: it holds rows written by
 * a previous deployment and possibly rows written by an operator by hand. A
 * malformed payload is TERMINAL — retrying identical bad input three times only
 * delays the dead-letter signal.
 */
export function parseNotificationDeliveryPayload(
  raw: unknown,
): NotificationDeliveryPayload {
  if (!Value.Check(NotificationDeliveryPayloadSchema, raw)) {
    throw new TerminalJobError("Notification delivery payload failed validation.");
  }
  return raw;
}

export interface NotificationDeliveryHandlerDependencies {
  /**
   * Built per job, bound to the delivery's own scope.
   *
   * A factory rather than a fixed dependency set because the RLS context
   * depends on the row being delivered: a workspace notification and an account
   * security notification run under different transaction contexts, and a
   * handler that guessed would either see nothing or see too much.
   */
  readonly dependenciesFor: (
    notificationDeliveryId: NotificationDeliveryId,
  ) => Promise<DeliverNotificationDependencies | null>;
}

/**
 * Runs one delivery.
 *
 * Returns the outcome rather than throwing on a send failure. A failed provider
 * call is not a failed JOB — the attempt was recorded, the delivery was
 * transitioned, and the retry schedule lives in the database rather than in
 * pg-boss's own retry counter. Throwing would double the retry loops (S101),
 * and pg-boss's schedule knows nothing about a credential's expiry.
 */
export async function handleNotificationDelivery(
  raw: unknown,
  _context: SystemJobContext,
  deps: NotificationDeliveryHandlerDependencies,
): Promise<DeliveryRunOutcome> {
  const payload = parseNotificationDeliveryPayload(raw);
  const deliveryId = payload.notificationDeliveryId as NotificationDeliveryId;

  const dependencies = await deps.dependenciesFor(deliveryId);
  if (dependencies === null) {
    // The delivery is not readable in any scope. Either it was deleted, or the
    // id was written by hand. Terminal: a retry re-reads the same absence.
    throw new TerminalJobError("Notification delivery is not resolvable.");
  }

  return deliverNotification(dependencies)(deliveryId);
}
