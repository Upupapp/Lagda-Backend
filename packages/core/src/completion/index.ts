// Completion pipeline rules (BACKEND-38).
//
// Pure. No clock, no repository, no storage, no PDF — every function is a
// deterministic function of facts the caller has already loaded, which is what
// lets the eligibility rule be tested exhaustively without a database.
//
// ── What this module refuses to know ───────────────────────────────────────
//
// How a PDF is merged (BACKEND-39), what a certificate says (BACKEND-40), how
// bytes are sealed (BACKEND-41). It decides WHETHER completion may begin, WHAT
// order the steps run in, and WHETHER a failure is worth retrying. Nothing else.

import {
  COMPLETION_RUN_STATES, COMPLETION_STEPS, COMPLETION_FAILURE_CLASSIFICATION,
  type CompletionRunState, type CompletionStep, type CompletionStepState,
  type CompletionFailureClass, type CompletionFailureCode,
  type SigningRequestState,
} from "@lagda/contracts";
import { InvalidStateTransitionError, assertNever } from "../common/index.js";
import { isRequiredSigningParticipant, type WorkflowRecipient } from "../signing/index.js";

export {
  COMPLETION_RUN_STATES, COMPLETION_STEPS, COMPLETION_FAILURE_CLASSIFICATION,
};
export type {
  CompletionRunState, CompletionStep, CompletionStepState,
  CompletionFailureClass, CompletionFailureCode,
};

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * The ONE state completion may begin from.
 *
 * Not a list. `completion-ready` is the only value the signing workflow
 * produces that means "every obligation is satisfied and the document does not
 * exist", and completion has no business starting from anything else — not from
 * `partially-completed` (somebody is still owed), not from `completed` (it
 * already happened), not from a terminal state.
 */
export const COMPLETION_ELIGIBLE_REQUEST_STATE: SigningRequestState = "completion-ready";

/** Why completion may not begin. A closed set, and every value is a log-safe code. */
export type CompletionBlocker =
  | "not-completion-ready"
  | "missing-submission"
  | "missing-field-value"
  | "input-inconsistent"
  | "source-artifact-missing";

/**
 * What the eligibility rule needs to know about one required field.
 *
 * `recipientId` is on BOTH sides so the rule can check that a value belongs to
 * the assignment it claims. §247 asks for that, and doing it here means the
 * check exists even where a foreign key does not.
 */
export interface CompletionFieldFact {
  readonly fieldId: string;
  readonly recipientId: string;
  readonly required: boolean;
  /** The accepted value's recipient, or `null` when no value exists. */
  readonly valueRecipientId: string | null;
}

export interface CompletionEligibilityInput {
  readonly requestState: SigningRequestState;
  /** Whether the exact artifact the request froze still exists. */
  readonly sourceArtifactPresent: boolean;
  readonly recipients: readonly WorkflowRecipient[];
  /** Whether each SIGNED recipient has an accepted submission. */
  readonly submittedRecipientIds: readonly string[];
  readonly fields: readonly CompletionFieldFact[];
}

export type CompletionEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly blocker: CompletionBlocker };

/**
 * Whether this request may enter the completion pipeline.
 *
 * ── State is checked, and then NOT trusted ─────────────────────────────────
 *
 * §6 is the point of this function. `completion-ready` is a projection that
 * BACKEND-37 wrote from durable facts, and a projection can be wrong — through
 * a bug, a partial restore, or a hand-edited row. So every fact behind it is
 * re-derived here before anything expensive happens, and a disagreement is an
 * integrity failure rather than something to work around.
 *
 * ── The order is cheapest-first, and that is deliberate ────────────────────
 *
 * State, then artifact presence, then the participant sweep, then the field
 * sweep. A request that is not `completion-ready` is rejected in one comparison
 * rather than after two passes over its recipients.
 */
export function assessCompletionEligibility(
  input: CompletionEligibilityInput,
): CompletionEligibility {
  const deny = (blocker: CompletionBlocker): CompletionEligibility =>
    ({ eligible: false, blocker });

  if (input.requestState !== COMPLETION_ELIGIBLE_REQUEST_STATE) {
    return deny("not-completion-ready");
  }
  // The EXACT bytes the request froze. Never the document's current artifact —
  // §9, and the whole reason `sourceArtifactId` is on the request.
  if (!input.sourceArtifactPresent) return deny("source-artifact-missing");

  const submitted = new Set(input.submittedRecipientIds);

  for (const recipient of input.recipients) {
    // A required participant who has not signed means readiness was wrong.
    if (isRequiredSigningParticipant(recipient) && recipient.state !== "signed") {
      return deny("missing-submission");
    }
    // And every recipient the workflow CALLS signed must have the submission
    // that word is supposed to mean (§246). This is the check that would catch
    // a `signed` row whose submission was somehow removed.
    if (recipient.state === "signed" && !submitted.has(recipient.recipientId)) {
      return deny("missing-submission");
    }
  }

  for (const field of input.fields) {
    if (field.valueRecipientId === null) {
      // An optional field nobody filled in is not a failure; a required one is.
      if (field.required) return deny("missing-field-value");
      continue;
    }
    // A value that exists but names a different recipient than the assignment
    // is corruption, not a missing value, and the two must not be conflated.
    if (field.valueRecipientId !== field.recipientId) return deny("input-inconsistent");
  }

  return { eligible: true };
}

// ── The run state machine ────────────────────────────────────────────────────

export const COMPLETION_RUN_ACTIONS = [
  "start", "failRetryable", "failTerminal", "succeed", "abandon",
] as const;
export type CompletionRunAction = (typeof COMPLETION_RUN_ACTIONS)[number];

/**
 * The complete transition table. Anything absent is forbidden.
 *
 * Note what `succeeded` and `failed-terminal` carry: nothing. §111 — a
 * successful run is never re-run automatically, and §215 — a terminal failure
 * is not casually restarted. Both are decisions, so both are empty sets rather
 * than omitted entries, and adding a sixth state is a compile error.
 *
 * `abandon` exists for the crash case: a `processing` run whose worker died
 * returns to `waiting-retry` rather than staying `processing` forever, which is
 * what makes §133 and §270 recoverable.
 */
const RUN_TRANSITIONS: Record<
  CompletionRunState,
  Partial<Record<CompletionRunAction, CompletionRunState>>
> = {
  pending: { start: "processing" },
  processing: {
    succeed: "succeeded",
    failRetryable: "waiting-retry",
    failTerminal: "failed-terminal",
    abandon: "waiting-retry",
  },
  "waiting-retry": { start: "processing", failTerminal: "failed-terminal" },
  succeeded: {},
  "failed-terminal": {},
};

export function isCompletionRunTerminal(state: CompletionRunState): boolean {
  switch (state) {
    case "succeeded":
    case "failed-terminal":
      return true;
    case "pending":
    case "processing":
    case "waiting-retry":
      return false;
    default:
      return assertNever(state, "isCompletionRunTerminal");
  }
}

/** Whether a run may be picked up by a worker attempt right now. */
export function isCompletionRunClaimable(state: CompletionRunState): boolean {
  return state === "pending" || state === "waiting-retry";
}

export function canTransitionCompletionRun(
  from: CompletionRunState, action: CompletionRunAction,
): boolean {
  return RUN_TRANSITIONS[from][action] !== undefined;
}

/** @throws InvalidStateTransitionError when the transition is not permitted. */
export function transitionCompletionRun(
  from: CompletionRunState, action: CompletionRunAction,
): CompletionRunState {
  const next = RUN_TRANSITIONS[from][action];
  if (next === undefined) {
    throw new InvalidStateTransitionError("CompletionRun", from, action);
  }
  return next;
}

// ── Step order ───────────────────────────────────────────────────────────────

/**
 * The steps, in the only order they may run.
 *
 * A frozen array rather than a graph. §71 and §283 both forbid a generic DAG
 * builder, and the reason is that a closed sequence can be read, tested and
 * reasoned about — while a dynamic workflow engine moves the ordering rules out
 * of the type system and into data nobody reviews.
 */
export const COMPLETION_STEP_ORDER: readonly CompletionStep[] = COMPLETION_STEPS;

/**
 * The next step to run, given what has already succeeded.
 *
 * Returns `null` when every step is done. This is what makes a retry resume
 * rather than restart: a run whose `seal` succeeded comes back and is told to
 * run `persist`, and the sealer is never invoked a second time (§117, §254).
 *
 * @throws InvalidStateTransitionError if a LATER step succeeded while an
 *         earlier one did not. That combination cannot be produced by this
 *         module and means the ledger was written by something else.
 */
export function nextCompletionStep(
  succeeded: readonly CompletionStep[],
): CompletionStep | null {
  const done = new Set(succeeded);
  let seenOutstanding = false;

  for (const step of COMPLETION_STEP_ORDER) {
    if (done.has(step)) {
      if (seenOutstanding) {
        throw new InvalidStateTransitionError(
          "CompletionRun", "step-ledger", `"${step}" succeeded out of order`);
      }
      continue;
    }
    seenOutstanding = true;
  }

  return COMPLETION_STEP_ORDER.find(step => !done.has(step)) ?? null;
}

/** Whether every step has succeeded — the precondition for finalization. */
export function isCompletionSatisfied(succeeded: readonly CompletionStep[]): boolean {
  const done = new Set(succeeded);
  return COMPLETION_STEP_ORDER.every(step => done.has(step));
}

// ── Failure classification ───────────────────────────────────────────────────

/**
 * Whether this failure is worth another attempt.
 *
 * A total lookup, so every code has an answer and no code silently defaults.
 * §43: retrying deterministic corruption forever burns the attempt budget that
 * would otherwise surface a real outage.
 */
export function classifyCompletionFailure(
  code: CompletionFailureCode,
): CompletionFailureClass {
  return COMPLETION_FAILURE_CLASSIFICATION[code];
}

/** The run action a failure implies. One place, so the two cannot disagree. */
export function runActionForFailure(
  code: CompletionFailureCode,
): "failRetryable" | "failTerminal" {
  return classifyCompletionFailure(code) === "retryable"
    ? "failRetryable" : "failTerminal";
}

/**
 * Whether another attempt is permitted.
 *
 * Bounded, per §46. A retryable failure that has exhausted its attempts becomes
 * terminal — not because the cause changed, but because unbounded retry is how
 * a broken dependency turns into a queue nobody can drain.
 */
export function mayAttemptAgain(input: {
  readonly code: CompletionFailureCode;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}): boolean {
  return classifyCompletionFailure(input.code) === "retryable"
    && input.attemptCount < input.maxAttempts;
}

/**
 * Deliberately absent from this module.
 *
 * **Any PDF knowledge.** No page, no coordinate, no font, no library type.
 * BACKEND-39 renders fields and BACKEND-40 lays out the certificate, both
 * inside `@lagda/sealing` behind `DocumentSealer.seal()`.
 *
 * **Any path that marks a request completed.** The guard belongs with the
 * orchestrator that can prove the outputs exist, and BACKEND-41 makes the seal
 * step executable. A pure module cannot verify that an object is in storage.
 *
 * **Any clock.** `completedAt` is the pipeline's success time, read by the
 * orchestrator once and passed down.
 */
export type CompletionOperationsDeferred = never;
