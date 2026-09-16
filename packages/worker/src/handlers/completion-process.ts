// The completion-process handler (BACKEND-38/41, Phase 1-B).
//
// A SEAM, not a decision-maker — everything that decides anything lives in
// `processCompletionRun`: the claim, the eligibility check, and which step
// runs next. This file validates a queue payload and calls it.
//
// Enqueued the instant a request becomes `completion-ready` (the "immediate"
// half of the hybrid trigger — see completion-reconcile.ts for the recovery
// half). At-least-once, same as every other job here: `processCompletionRun`
// claims the run with a conditional UPDATE before doing anything, so a
// duplicate delivery of this job finds the run already claimed (or already
// terminal) and does nothing.

import { Value } from "@sinclair/typebox/value";
import {
  CompletionProcessPayloadSchema, TerminalJobError, processCompletionRun,
  type CompletionProcessPayload, type CompletionDependencies,
  type ProcessCompletionRunResult, type SystemJobContext,
  type WorkspaceId, type CompletionRunId,
} from "@lagda/application";

export function parseCompletionProcessPayload(raw: unknown): CompletionProcessPayload {
  if (!Value.Check(CompletionProcessPayloadSchema, raw)) {
    throw new TerminalJobError("Completion process payload failed validation.");
  }
  return raw;
}

export async function handleCompletionProcess(
  raw: unknown,
  _context: SystemJobContext,
  deps: CompletionDependencies,
): Promise<ProcessCompletionRunResult> {
  const payload = parseCompletionProcessPayload(raw);
  return processCompletionRun(
    {
      workspaceId: payload.workspaceId as WorkspaceId,
      runId: payload.completionRunId as CompletionRunId,
    },
    deps,
  );
}
