// The completion pipeline orchestration (BACKEND-38).
//
// ── What is here, and what is deliberately not ─────────────────────────────
//
// Here: ensuring a run exists, reconciling requests that lost theirs, claiming
// a run for an attempt, and the GUARD that decides whether a request may be
// marked completed.
//
// Not here: any byte. No PDF, no certificate, no sealer call, no storage. The
// `seal` step becomes executable at BACKEND-41, and until then
// `processCompletionRun` cannot report success — not because a fake adapter
// throws, but because there is no adapter to call and the guard has nothing to
// verify (§22, §176, §178).

import type { WorkspaceId } from "@lagda/contracts";
import {
  COMPLETION_PIPELINE_VERSION, COMPLETION_STEPS,
  type CompletionFailureCode, type CompletionStep,
} from "@lagda/contracts";
import {
  assessCompletionEligibility, isCompletionSatisfied, nextCompletionStep,
  runActionForFailure,
  type CompletionBlocker, type CompletionFieldFact, type WorkflowRecipient,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  SigningRequestId, CompletionIdGenerator, CompletionRunId, CompletionRunRecord,
  ArtifactId,
} from "../common/ports/index.js";
import { ApplicationError, ResourceNotFoundError } from "../common/errors/index.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Completion may not begin, or may not finish.
 *
 * Always `internal`. Every blocker describes a disagreement between the request
 * state and the facts behind it, which the caller did not cause and cannot fix
 * — and a 4xx would invite a client to retry into the same corruption.
 */
export class CompletionNotEligibleError extends ApplicationError {
  readonly category = "internal" as const;
  readonly code = "completion_not_eligible";
  constructor(readonly blocker: CompletionBlocker) {
    super("This request cannot be completed.");
  }
}

/** The pipeline cannot run because a required step has no implementation. */
export class CompletionStepUnavailableError extends ApplicationError {
  readonly category = "internal" as const;
  readonly code = "completion_step_unavailable";
  constructor(readonly step: string) {
    super("The completion pipeline is not yet able to run.");
  }
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * A step this build can actually execute.
 *
 * Returns its own outcome and records its OWN failure with a bounded code,
 * because only the step knows which of its phases failed. The orchestrator does
 * not second-guess that.
 */
export type CompletionStepRunner = (input: {
  readonly workspaceId: WorkspaceId;
  readonly runId: CompletionRunId;
  readonly signingRequestId: SigningRequestId;
}) => Promise<{
  /**
   * Anything but `"failed"` means the step's output is accepted and the
   * pipeline may go on. The successful variants are named per step
   * (`merged`/`certified`, and their `already-` forms) because a run's history
   * should say whether work was DONE or REUSED — but the orchestrator only
   * distinguishes failure from progress.
   */
  readonly outcome: string;
  readonly failureCode?: CompletionFailureCode;
}>;

/**
 * The executable steps, by name.
 *
 * OPTIONAL, and absent means "this build cannot run it" rather than "it
 * failed". A caller that wires nothing gets exactly the pre-BACKEND-39
 * behaviour: the run parks itself with `step-not-implemented` and returns to
 * the claimable pool. That is what keeps a worker deployment that has not been
 * updated from failing requests terminally.
 */
export interface CompletionStepRunners {
  readonly fieldMerge?: CompletionStepRunner;
  readonly certificate?: CompletionStepRunner;
  /**
   * BACKEND-41. Unlike the others, this one TRANSITIONS THE REQUEST — it seals,
   * persists, and marks the request completed inside its own finalization
   * transaction. The orchestrator does not perform the transition and has no
   * method that could.
   */
  readonly finalSeal?: CompletionStepRunner;
}

export interface CompletionDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: CompletionIdGenerator;
  readonly policy: {
    /** How long an attempt may be silent before it is treated as abandoned. */
    readonly staleAttemptMs: number;
    readonly reconcileBatchSize: number;
  };
  readonly steps?: CompletionStepRunners;
}

// ── Ensuring a run ───────────────────────────────────────────────────────────

/**
 * Finds or creates the ONE completion run for a request.
 *
 * Callable on its own — the reconciler uses it — and also called INSIDE the
 * readiness transition, which is the path that matters. See the trigger comment
 * in `signing-workflow.ts`.
 */
export async function ensureCompletionRun(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: CompletionDependencies,
): Promise<CompletionRunRecord> {
  return deps.transactions.runForWorkspace(input.workspaceId, uow =>
    uow.completion.ensureRun({
      completionRunId: deps.ids.nextCompletionRunId(),
      signingRequestId: input.signingRequestId,
      pipelineVersion: COMPLETION_PIPELINE_VERSION,
      createdAt: deps.clock.now(),
    }));
}

// ── Eligibility, against the authoritative facts ─────────────────────────────

/**
 * Re-derives everything behind `completion-ready`.
 *
 * §6. The state is a projection BACKEND-37 wrote, and a projection can be wrong
 * — through a bug, a partial restore, or a hand-edited row. Nothing expensive
 * happens until these facts agree with it.
 *
 * Reads ONLY immutable sources: the request, its recipient and field snapshots,
 * the accepted submissions and values, and the exact `sourceArtifactId`. It
 * never touches contacts, preparations, or the document's current artifact
 * (§7, §9, §10, §11) — and an architecture guard asserts the absence.
 */
export async function assessRequestCompletionEligibility(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
): Promise<{ readonly eligible: boolean; readonly blocker?: CompletionBlocker }> {
  const request = await uow.signingRequests.find(signingRequestId);
  if (request === null) throw new ResourceNotFoundError("SigningRequest");

  // The EXACT artifact the request froze. Resolving the document's CURRENT
  // artifact here is the drift §9 forbids, and it would seal bytes nobody
  // agreed to.
  const artifacts = await uow.artifacts.listForDocument(request.documentId);
  const sourceArtifactPresent = artifacts.some(
    artifact => artifact.artifactId === request.sourceArtifactId);

  const workflowRows = await uow.signingWorkflow.listRecipientStates(signingRequestId);
  const recipients: WorkflowRecipient[] = workflowRows.map(row => ({
    recipientId: String(row.recipientId),
    type: row.type,
    isRequired: row.isRequired,
    routingOrder: row.routingOrder,
    state: row.state,
  }));

  // A `signed` state whose submission is gone is exactly the corruption that
  // trusting the projection would hide (§246).
  const submittedRecipientIds = workflowRows
    .filter(row => row.submissionId !== null)
    .map(row => String(row.recipientId));

  const fieldRows = await uow.signingRequests.listFields(signingRequestId);
  const values = await uow.completionInputs.listAcceptedFieldValues(signingRequestId);
  const valueByField = new Map(
    values.map(value => [String(value.fieldId), String(value.recipientId)]));

  const fields: CompletionFieldFact[] = fieldRows.map(row => ({
    fieldId: String(row.fieldId),
    recipientId: String(row.recipientId),
    required: row.required,
    valueRecipientId: valueByField.get(String(row.fieldId)) ?? null,
  }));

  const verdict = assessCompletionEligibility({
    requestState: request.state,
    sourceArtifactPresent,
    recipients,
    submittedRecipientIds,
    fields,
  });

  return verdict.eligible
    ? { eligible: true }
    : { eligible: false, blocker: verdict.blocker };
}

// ── Processing one run ───────────────────────────────────────────────────────

export interface ProcessCompletionRunResult {
  readonly runId: CompletionRunId;
  readonly outcome: "claimed-and-blocked" | "not-claimable" | "failed";
  readonly failureCode?: CompletionFailureCode;
  /** How many steps this attempt carried out. Absent before a claim. */
  readonly stepsCompleted?: number;
}

/**
 * Runs one completion attempt as far as this build can take it.
 *
 * ── Why this cannot succeed yet, and why that is correct ───────────────────
 *
 * It claims the run, revalidates eligibility, and asks the domain for the next
 * step. That step is `seal`, and the sealer is not wired into the completion
 * pipeline until BACKEND-41 — so the attempt stops there and the run returns to
 * the claimable pool.
 *
 * §22 and §178 forbid the alternative. A pass-through merger, an empty
 * certificate or a no-op sealer would each make this function report success,
 * and a request would be marked completed with no document behind it. The
 * repository would be green and the product would be broken in the one way
 * that cannot be walked back.
 *
 * §176 asks for the cleanest architecture given that. This is it: the
 * orchestration is real and tested, and the one thing it cannot do is the one
 * thing that has not been built.
 */
export async function processCompletionRun(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: CompletionRunId;
  },
  deps: CompletionDependencies,
): Promise<ProcessCompletionRunResult> {
  const now = deps.clock.now();

  // ── Phase 1: claim and validate, in ONE transaction ───────────────────────
  //
  // The claim MUST stay here and must stay conditional. `claimRun` is an UPDATE
  // with `where state in ('pending','waiting-retry')` in the statement itself,
  // so two workers handed the same job both run it and exactly one matches a
  // row (§63, §241). OD-155 proved that against real PostgreSQL rather than
  // against a fake, precisely because a fake runs both "concurrent" calls on one
  // thread and cannot show it.
  //
  // Moving the claim outside a transaction, or making it conditional in
  // application code instead of in the statement, breaks that silently — both
  // workers proceed and the second undoes the first's assumptions.
  const claim = await deps.transactions.runForWorkspace(input.workspaceId,
    async (uow): Promise<ClaimOutcome> => {
      const claimed = await uow.completion.claimRun({ runId: input.runId, at: now });
      if (claimed === null) return { kind: "not-claimable" };

      // A run started under a version this build cannot read must not be
      // reinterpreted (§212, §213). Failing safely beats silently reading old
      // step rows under new semantics.
      if (claimed.pipelineVersion !== COMPLETION_PIPELINE_VERSION) {
        return {
          kind: "failed",
          result: await fail(uow, input.runId, "pipeline-version-incompatible"),
        };
      }

      const eligibility =
        await assessRequestCompletionEligibility(uow, claimed.signingRequestId);
      if (!eligibility.eligible) {
        return {
          kind: "failed",
          result: await fail(uow, input.runId, blockerToFailureCode(eligibility.blocker)),
        };
      }

      return { kind: "claimed", signingRequestId: claimed.signingRequestId };
    });

  if (claim.kind === "not-claimable") {
    return { runId: input.runId, outcome: "not-claimable" };
  }
  if (claim.kind === "failed") return claim.result;

  // ── Phase 2: run steps, OUTSIDE the claim transaction ─────────────────────
  //
  // A step downloads an object, renders a PDF and uploads the result. Holding
  // the claim transaction open across that would pin a connection for the
  // duration of the slowest thing in the pipeline — and it would not make the
  // storage work transactional anyway, because object storage cannot enrol in
  // one.
  //
  // The run is already `processing` and claimed, so no other worker can take it
  // while this happens. That is what makes leaving the transaction safe.
  return advanceSteps(input.runId, claim.signingRequestId, input.workspaceId, deps);
}

type ClaimOutcome =
  | { readonly kind: "not-claimable" }
  | { readonly kind: "failed"; readonly result: ProcessCompletionRunResult }
  | { readonly kind: "claimed"; readonly signingRequestId: SigningRequestId };

/**
 * Runs as many steps as this build can, then parks the run.
 *
 * Every exit leaves the run OUT of `processing`, which matters more than it
 * looks: `processing` means "a worker is on it", and a run left there is
 * invisible to every other worker until the stale-attempt reconciler notices
 * (§133). The only paths out are a step's own recorded failure, or the
 * `step-not-implemented` park below.
 */
async function advanceSteps(
  runId: CompletionRunId,
  signingRequestId: SigningRequestId,
  workspaceId: WorkspaceId,
  deps: CompletionDependencies,
): Promise<ProcessCompletionRunResult> {
  let stepsCompleted = 0;

  // BOUNDED, one iteration per declared step plus one.
  //
  // Not a `while (true)`. A runner that reports success without ACCEPTING its
  // step leaves `nextCompletionStep` returning the same step forever, and an
  // unbounded loop would re-download, re-render and re-upload on every pass —
  // a runaway that looks like a hung worker rather than a bug.
  for (let pass = 0; pass <= COMPLETION_STEPS.length; pass += 1) {
    const succeeded = await deps.transactions.runForWorkspace(workspaceId, async uow => {
      const steps = await uow.completion.listSteps(runId);
      return steps.filter(step => step.state === "succeeded").map(step => step.step);
    });

    const next = nextCompletionStep(succeeded);
    if (next === null && isCompletionSatisfied(succeeded)) {
      // Every step accepted. The finalization guard is BACKEND-41's, because it
      // needs a `VerifiedCompletionResult` and nothing can produce one yet.
      return { runId, outcome: "claimed-and-blocked", stepsCompleted };
    }

    const runner = runnerFor(next, deps);
    if (runner === undefined) {
      // The step exists in the domain and has no executable implementation. The
      // run goes back to the claimable pool rather than failing terminally:
      // this is a build that cannot do the work, not data that cannot be
      // completed.
      await parkNotImplemented(runId, next ?? "field-merge", workspaceId, deps);
      return { runId, outcome: "claimed-and-blocked", stepsCompleted };
    }

    const outcome = await runner({ workspaceId, runId, signingRequestId });
    if (outcome.outcome === "failed") {
      // The step recorded its own failure with a bounded code, inside its own
      // transaction. Re-recording here would overwrite a specific cause with a
      // general one.
      return {
        runId, outcome: "failed", stepsCompleted,
        ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
      };
    }
    stepsCompleted += 1;
  }

  // The bound tripped: a runner keeps reporting success without its step
  // becoming `succeeded`. `output-missing` is the honest code — a step said it
  // succeeded and the durable evidence of that is not there.
  await deps.transactions.runForWorkspace(workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId, state: "failed-terminal", step: "field-merge", code: "output-missing",
    }));
  return { runId, outcome: "failed", failureCode: "output-missing", stepsCompleted };
}

/**
 * The runner for a step, or `undefined` when this build has none.
 *
 * A total switch over the vocabulary rather than a lookup by string: adding a
 * step without deciding whether it is executable is then a compile error, and
 * an un-run step parks the run rather than silently never running.
 */
function runnerFor(
  step: CompletionStep | null,
  deps: CompletionDependencies,
): CompletionStepRunner | undefined {
  switch (step) {
    case "field-merge": return deps.steps?.fieldMerge;
    case "certificate": return deps.steps?.certificate;
    case "final-seal": return deps.steps?.finalSeal;
    // `finalize` has no separate runner: `final-seal`'s own transaction
    // performs the finalization, because the request transition and the records
    // that justify it must commit together or not at all. A second step would
    // be a window in which a sealed document exists and the request does not
    // say so.
    case "finalize":
    case null:
      return undefined;
  }
}

async function parkNotImplemented(
  runId: CompletionRunId,
  step: CompletionStep,
  workspaceId: WorkspaceId,
  deps: CompletionDependencies,
): Promise<void> {
  await deps.transactions.runForWorkspace(workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId, state: "waiting-retry", step, code: "step-not-implemented",
    }));
}

async function fail(
  uow: WorkspaceUnitOfWork,
  runId: CompletionRunId,
  code: CompletionFailureCode,
): Promise<ProcessCompletionRunResult> {
  const action = runActionForFailure(code);
  await uow.completion.recordRunFailure({
    runId,
    state: action === "failRetryable" ? "waiting-retry" : "failed-terminal",
    step: "field-merge",
    code,
  });
  return { runId, outcome: "failed", failureCode: code };
}

/** Every blocker is deterministic, so every one of them is terminal. */
function blockerToFailureCode(blocker: CompletionBlocker | undefined): CompletionFailureCode {
  switch (blocker) {
    case "not-completion-ready": return "not-completion-ready";
    case "missing-submission": return "missing-submission";
    case "missing-field-value": return "missing-field-value";
    case "input-inconsistent": return "input-inconsistent";
    case "source-artifact-missing": return "source-artifact-missing";
    default: return "input-inconsistent";
  }
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface CompletionReconcileResult {
  /** Requests that were `completion-ready` with no run, and now have one. */
  readonly runsCreated: number;
  /** Attempts whose worker went away, returned to the claimable pool. */
  readonly runsAbandoned: number;
}

/**
 * Recovers completion work that would otherwise be stranded.
 *
 * Two checks, and each answers a §130 case that is genuinely reachable:
 *
 *   §131  a `completion-ready` request with NO run — a trigger lost to a crash
 *         between the transition and the commit that carried it, or a request
 *         that reached readiness before this pipeline existed
 *   §133  a `processing` run whose worker died — without this it sits there
 *         looking busy forever and no other worker will touch it
 *
 * Manual intervention is not the mechanism that prevents a stranded request,
 * which is what §26 of the definition of done requires.
 */
export async function reconcileCompletionRuns(
  workspaceId: WorkspaceId,
  deps: CompletionDependencies,
): Promise<CompletionReconcileResult> {
  const now = deps.clock.now();

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const stranded = await uow.completionReconciliation.listReadyWithoutRun(
      deps.policy.reconcileBatchSize);

    let runsCreated = 0;
    for (const signingRequestId of stranded) {
      await uow.completion.ensureRun({
        completionRunId: deps.ids.nextCompletionRunId(),
        signingRequestId,
        pipelineVersion: COMPLETION_PIPELINE_VERSION,
        createdAt: now,
      });
      runsCreated++;
    }

    const runsAbandoned = await uow.completion.abandonStaleRuns({
      lastAttemptBefore: now - deps.policy.staleAttemptMs,
      limit: deps.policy.reconcileBatchSize,
    });

    return { runsCreated, runsAbandoned };
  });
}

// ── The finalization guard ───────────────────────────────────────────────────

/**
 * Proof that a request may be marked completed.
 *
 * ── Why this type exists rather than a boolean ─────────────────────────────
 *
 * §171 and §172. `request.markCompleted()` with no argument is a method a
 * future caller invokes because the state looks right; a method that demands
 * THIS object can only be called by code that has the artifact identities and
 * the seal metadata in hand — which means the outputs exist.
 *
 * It is constructible only by `verifyCompletionOutputs` below, and that
 * function refuses unless every step is accepted.
 */
export interface VerifiedCompletionResult {
  readonly completionRunId: CompletionRunId;
  readonly finalArtifactId: ArtifactId;
  readonly certificateArtifactId: ArtifactId | null;
  readonly sealScheme: string;
  readonly sealVersion: number;
  readonly digestAlgorithm: string;
  /** The PIPELINE's success time. Never the last recipient's `acceptedAt`. */
  readonly completedAt: number;
}

/**
 * Whether the run's outputs justify completing the request.
 *
 * Returns `null` when they do not, so a caller cannot proceed without the
 * proof object. §175 asks that a missing seal or artifact PREVENT finalization,
 * and this is where that is decided.
 *
 * **It is not reachable today**: `isCompletionSatisfied` requires the `seal`
 * step to be accepted, and nothing can accept it until BACKEND-41 wires the
 * sealer. That is the correct state — the guard exists, and the path to it does
 * not.
 */
export async function verifyCompletionOutputs(
  uow: WorkspaceUnitOfWork,
  runId: CompletionRunId,
): Promise<VerifiedCompletionResult | null> {
  const steps = await uow.completion.listSteps(runId);
  const succeeded = steps
    .filter(step => step.state === "succeeded")
    .map(step => step.step);

  if (!isCompletionSatisfied(succeeded)) return null;

  // A step that SAYS succeeded and names no artifact has not produced one, and
  // §77 forbids trusting the status alone. Verifying the object is actually in
  // storage is BACKEND-41's, because only it knows what was uploaded.
  const sealed = steps.find(step => step.step === "final-seal");
  if (sealed === undefined || sealed.outputArtifactId === null) return null;

  return null;
}

/**
 * Deliberately absent from this module.
 *
 * **Any sealer call, any PDF, any storage call.** BACKEND-41 wires the seal
 * step; BACKEND-39 and BACKEND-40 refine what happens inside `@lagda/sealing`.
 * An architecture guard asserts this module imports none of them.
 *
 * **`markRequestCompleted`.** The transition needs a `VerifiedCompletionResult`
 * and nothing can construct one yet, so the repository method that would take
 * it does not exist either. Adding it now would be a path to `completed` with
 * nothing on the other end.
 *
 * **A no-op or pass-through step adapter.** §22, §178. It would make this
 * pipeline report success and mark a request completed with no document — the
 * one failure that cannot be walked back.
 *
 * **Orphan object cleanup.** Nothing uploads anything yet, so there is nothing
 * to orphan. The choreography is documented; the sweeper arrives with the
 * uploads it would sweep.
 */
export type CompletionOperationsDeferred = never;
