// Drives completion runs that are waiting to be retried.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// A run that fails retryably parks in `waiting-retry` and nothing brings it
// back. `abandonStaleRuns` only reclaims `processing`; `listReadyWithoutRun`
// only finds requests with no run at all; and the handler RETURNS its failure
// rather than throwing, so pg-boss sees a successful job and its own
// `maxAttempts` never applies. A real signed document sat unfinished for a
// day, with `attempt_count = 1`, until the job was enqueued by hand.
//
// ── Shape: read identifiers globally, act inside the workspace ──────────────
//
// Deliberately the same shape as `expireDueSigningRequests` and
// `dispatchDueNotifications` rather than a fourth invention. The index carries
// no tenancy policy and holds three columns; this reads it in a global
// transaction and then enters each workspace properly, so every write still
// happens under normal RLS.
//
// ── Enqueuing is not claiming ───────────────────────────────────────────────
//
// Two sweeps running concurrently will enqueue the same run twice, and that is
// harmless BY DESIGN — `claimRun` is one conditional UPDATE over
// `state IN ('pending','waiting-retry')`, so the second job finds the run
// already `processing` and does nothing. This is the same argument
// `dispatch.ts` records for notification deliveries: putting a second lock in
// front of the lock that already works would add a failure mode, not remove
// one.
//
// The index also disappears the moment a run becomes `processing` (the trigger
// deletes the row), so a run a worker is already inside is not even a
// candidate.

import type { Clock, TransactionManager } from "../common/ports/index.js";
import type { JobScheduler } from "../common/ports/jobs.js";
import { CompletionProcessJob } from "../jobs/definitions.js";

export interface CompletionRetrySweepDependencies {
  readonly transactions: Pick<TransactionManager, "runGlobal" | "runForWorkspace">;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  readonly policy: {
    /** How many due runs to handle per tick. */
    readonly batchSize: number;
    /**
     * How many attempts a run gets before the sweep gives up on it.
     *
     * The CAP is policy and lives here; WHEN the next attempt is due is data
     * and lives in the index's trigger. Under that trigger's curve
     * (60s doubling to an hour) eight attempts spans roughly three hours,
     * which is long enough to outlast an object-storage or database blip and
     * short enough that a genuinely broken run stops consuming ticks.
     */
     readonly maxAttempts: number;
  };
}

export interface CompletionRetrySweepResult {
  /** Due runs read from the index this tick. */
  readonly examined: number;
  /** Runs handed to `completion.process`. */
  readonly enqueued: number;
  /** Runs given up on because their attempts were spent. */
  readonly exhausted: number;
  /**
   * Ticks that could not be completed for one run.
   *
   * There is deliberately no `skipped` counter. A run that moved on between
   * the index read and the write is still ENQUEUED here — `claimRun` makes
   * that job a no-op — so "skipped" would be a state this sweep cannot
   * observe, and a counter that is always zero is a claim that it means
   * something.
   */
  readonly failed: number;
  /** The batch bound bit, so a backlog is visible rather than silent. */
  readonly truncated: boolean;
}

export async function driveDueCompletionRuns(
  deps: CompletionRetrySweepDependencies,
): Promise<CompletionRetrySweepResult> {
  const now = deps.clock.now();
  const due = await deps.transactions.runGlobal(uow =>
    uow.completionRetryIndex.listDue({ now, limit: deps.policy.batchSize }));

  let enqueued = 0;
  let exhausted = 0;
  let failed = 0;

  for (const ref of due) {
    try {
      // Give up FIRST, and conditionally. `exhaustRun` carries both the state
      // and the attempt condition in its own statement, so a run claimed by a
      // worker in the meantime matches zero rows and keeps its attempt — and
      // a run with attempts remaining also matches zero rows, which is the
      // signal to drive it instead.
      const gaveUp = await deps.transactions.runForWorkspace(ref.workspaceId, uow =>
        uow.completion.exhaustRun({
          runId: ref.completionRunId,
          maxAttempts: deps.policy.maxAttempts,
        }));

      if (gaveUp) {
        exhausted++;
        continue;
      }

      // The payload is the run id and the workspace the index named — never a
      // value from a request body, so a hand-written job cannot point the
      // pipeline at another tenant's run.
      await deps.scheduler.enqueue(CompletionProcessJob, {
        workspaceId: ref.workspaceId,
        completionRunId: ref.completionRunId,
      });
      enqueued++;
    } catch {
      // Swallowed without the error object, following the other two sweeps: an
      // exception message is unbounded text that may carry a value from the
      // row it failed on, and one workspace's trouble must not stop every
      // other workspace's completions.
      failed++;
    }
  }

  return {
    examined: due.length,
    enqueued,
    exhausted,
    failed,
    truncated: due.length >= deps.policy.batchSize,
  };
}
