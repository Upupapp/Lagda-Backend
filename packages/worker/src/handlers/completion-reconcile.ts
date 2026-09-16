// The completion-reconcile handler (BACKEND-38, Phase 1-B).
//
// The recovery half of the hybrid trigger — see completion-process.ts for the
// immediate half. Recovers exactly ONE workspace's stranded completion work:
// a `completion-ready` request whose `completion.process` enqueue was lost,
// or a `processing` run whose worker died. `reconcileCompletionRuns` itself
// takes a single workspace (there is no system-wide completion index the way
// `signing-request.expiry` has one), so this job is scoped the same way and
// self-scheduled by the enqueuing site with a singleton key, rather than run
// on a fixed system-wide cron.

import { Value } from "@sinclair/typebox/value";
import {
  CompletionReconcilePayloadSchema, TerminalJobError, reconcileCompletionRuns,
  type CompletionReconcilePayload, type CompletionDependencies,
  type CompletionReconcileResult, type SystemJobContext, type WorkspaceId,
} from "@lagda/application";

export function parseCompletionReconcilePayload(raw: unknown): CompletionReconcilePayload {
  if (!Value.Check(CompletionReconcilePayloadSchema, raw)) {
    throw new TerminalJobError("Completion reconcile payload failed validation.");
  }
  return raw;
}

export async function handleCompletionReconcile(
  raw: unknown,
  _context: SystemJobContext,
  deps: CompletionDependencies,
): Promise<CompletionReconcileResult> {
  const payload = parseCompletionReconcilePayload(raw);
  return reconcileCompletionRuns(payload.workspaceId as WorkspaceId, deps);
}
