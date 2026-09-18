// The completion-retry handler.
//
// The piece that makes `waiting-retry` mean "will be tried again" rather than
// "stopped here". Sweeps the cross-tenant retry index and hands every due run
// to `completion.process`; gives up on a run whose attempts are spent.
//
// Scoped and shaped like `signing-request.expiry`'s handler rather than like
// `completion.reconcile`'s: this one takes a batch size and no tenant,
// because a parked run is invisible from inside the workspace that owns it
// and the sweep has to find out WHICH workspace to enter before entering one.

import { Value } from "@sinclair/typebox/value";
import {
  CleanupPayloadSchema, TerminalJobError, driveDueCompletionRuns,
  type CleanupPayload, type CompletionRetrySweepDependencies,
  type CompletionRetrySweepResult, type SystemJobContext,
} from "@lagda/application";

export function parseCompletionRetryPayload(raw: unknown): CleanupPayload {
  if (!Value.Check(CleanupPayloadSchema, raw)) {
    throw new TerminalJobError("Completion retry payload failed validation.");
  }
  return raw;
}

export async function handleCompletionRetry(
  raw: unknown,
  _context: SystemJobContext,
  deps: Omit<CompletionRetrySweepDependencies, "policy"> & {
    readonly policy: Omit<CompletionRetrySweepDependencies["policy"], "batchSize">;
  },
): Promise<CompletionRetrySweepResult> {
  // The batch size comes from the PAYLOAD, like every other sweep, so the
  // schedule can carry it and an operator can widen one tick without a
  // redeploy. The attempt cap does not: how many times a completion may be
  // retried is a durable policy decision, not a per-tick parameter.
  const payload = parseCompletionRetryPayload(raw);
  return driveDueCompletionRuns({
    ...deps,
    policy: { ...deps.policy, batchSize: payload.batchSize },
  });
}
