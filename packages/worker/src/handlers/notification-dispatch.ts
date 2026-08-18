// The dispatch handler.
//
// Thin, like every handler in this directory: it validates a payload and calls
// the use case. What it adds is a bound on the batch, taken from the payload so
// an operator can lower it during an incident without a deploy.
//
// The outcome is RETURNED rather than logged here. A handler that logged would
// need a logger dependency in a package that deliberately has none, and the
// worker's own emitter is the single place log lines are shaped.

import { Value } from "@sinclair/typebox/value";
import {
  CleanupPayloadSchema, TerminalJobError,
  dispatchNotifications,
  type CleanupPayload, type DispatchDependencies, type DispatchOutcome,
  type SystemJobContext,
} from "@lagda/application";

export function parseNotificationDispatchPayload(raw: unknown): CleanupPayload {
  if (!Value.Check(CleanupPayloadSchema, raw)) {
    throw new TerminalJobError("Notification dispatch payload failed validation.");
  }
  return raw;
}

export type NotificationDispatchDependencies =
  Omit<DispatchDependencies, "batchSize">;

/**
 * Runs one sweep.
 *
 * Failures propagate. Unlike a delivery — where a provider refusal is an
 * outcome rather than a broken job — a dispatcher that cannot read the index
 * has nothing to record and nothing to retry against, so the job should fail
 * loudly and be retried by the queue.
 */
export function handleNotificationDispatch(
  raw: unknown,
  _context: SystemJobContext,
  deps: NotificationDispatchDependencies,
): Promise<DispatchOutcome> {
  const payload = parseNotificationDispatchPayload(raw);
  return dispatchNotifications({ ...deps, batchSize: payload.batchSize })();
}
