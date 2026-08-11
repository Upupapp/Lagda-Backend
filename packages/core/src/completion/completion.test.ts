// Completion pipeline rules (BACKEND-38).

import { describe, it, expect } from "vitest";
import {
  COMPLETION_RUN_STATES, COMPLETION_STEPS, COMPLETION_RUN_ACTIONS,
  COMPLETION_ELIGIBLE_REQUEST_STATE, COMPLETION_STEP_ORDER,
  assessCompletionEligibility, canTransitionCompletionRun, transitionCompletionRun,
  isCompletionRunTerminal, isCompletionRunClaimable,
  nextCompletionStep, isCompletionSatisfied,
  classifyCompletionFailure, runActionForFailure, mayAttemptAgain,
  COMPLETION_FAILURE_CLASSIFICATION,
  type CompletionEligibilityInput, type CompletionFieldFact,
  type WorkflowRecipient,
} from "../index.js";
import {
  COMPLETION_FAILURE_CODES, SIGNING_REQUEST_STATES,
  type RecipientType,
} from "@lagda/contracts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function signer(over: Partial<WorkflowRecipient> = {}): WorkflowRecipient {
  return {
    recipientId: over.recipientId ?? "r1",
    type: over.type ?? "signer",
    isRequired: over.isRequired ?? true,
    routingOrder: over.routingOrder ?? 1,
    state: over.state ?? "signed",
  };
}

function field(over: Partial<CompletionFieldFact> = {}): CompletionFieldFact {
  return {
    fieldId: over.fieldId ?? "f1",
    recipientId: over.recipientId ?? "r1",
    required: over.required ?? true,
    valueRecipientId: over.valueRecipientId === undefined
      ? "r1" : over.valueRecipientId,
  };
}

function eligible(over: Partial<CompletionEligibilityInput> = {}): CompletionEligibilityInput {
  return {
    requestState: over.requestState ?? "completion-ready",
    sourceArtifactPresent: over.sourceArtifactPresent ?? true,
    recipients: over.recipients ?? [signer()],
    submittedRecipientIds: over.submittedRecipientIds ?? ["r1"],
    fields: over.fields ?? [field()],
  };
}

// ── Eligibility ──────────────────────────────────────────────────────────────

describe("completion eligibility", () => {
  it("accepts a genuinely ready request", () => {
    expect(assessCompletionEligibility(eligible())).toEqual({ eligible: true });
  });

  it("begins from exactly one request state", () => {
    expect(COMPLETION_ELIGIBLE_REQUEST_STATE).toBe("completion-ready");
    for (const state of SIGNING_REQUEST_STATES) {
      if (state === "completion-ready") continue;
      expect(assessCompletionEligibility(eligible({ requestState: state })), state)
        .toEqual({ eligible: false, blocker: "not-completion-ready" });
    }
  });

  it("refuses when the exact source artifact is gone", () => {
    // §251. The bytes the request FROZE, not the document's current artifact.
    expect(assessCompletionEligibility(eligible({ sourceArtifactPresent: false })))
      .toEqual({ eligible: false, blocker: "source-artifact-missing" });
  });

  it("refuses a required participant who has not signed", () => {
    // Readiness said otherwise, and readiness is a projection. §6.
    expect(assessCompletionEligibility(eligible({
      recipients: [signer({ state: "active" })],
    }))).toEqual({ eligible: false, blocker: "missing-submission" });
  });

  it("refuses a SIGNED recipient with no accepted submission", () => {
    // §246. The state says signed and the fact behind it is missing — the exact
    // corruption that state-as-truth would hide.
    expect(assessCompletionEligibility(eligible({ submittedRecipientIds: [] })))
      .toEqual({ eligible: false, blocker: "missing-submission" });
  });

  it("refuses a required field with no accepted value", () => {
    expect(assessCompletionEligibility(eligible({
      fields: [field({ valueRecipientId: null })],
    }))).toEqual({ eligible: false, blocker: "missing-field-value" });
  });

  it("permits an OPTIONAL field nobody filled in", () => {
    expect(assessCompletionEligibility(eligible({
      fields: [field({ required: false, valueRecipientId: null })],
    }))).toEqual({ eligible: true });
  });

  it("refuses a value that belongs to a different recipient", () => {
    // §247. Distinguished from a MISSING value, because they are different
    // failures: one is incomplete, the other is corrupt.
    expect(assessCompletionEligibility(eligible({
      fields: [field({ recipientId: "r1", valueRecipientId: "r2" })],
    }))).toEqual({ eligible: false, blocker: "input-inconsistent" });
  });

  it("does not wait for a carbon-copy", () => {
    expect(assessCompletionEligibility(eligible({
      recipients: [signer(), signer({
        recipientId: "cc", type: "carbon-copy" as RecipientType, state: "active",
      })],
    }))).toEqual({ eligible: true });
  });
});

// ── The run state machine ────────────────────────────────────────────────────

describe("the completion run state machine", () => {
  it("has the five operationally distinct states", () => {
    expect([...COMPLETION_RUN_STATES]).toEqual([
      "pending", "processing", "waiting-retry", "succeeded", "failed-terminal",
    ]);
  });

  it.each([
    ["pending", "start", "processing"],
    ["processing", "succeed", "succeeded"],
    ["processing", "failRetryable", "waiting-retry"],
    ["processing", "failTerminal", "failed-terminal"],
    ["processing", "abandon", "waiting-retry"],
    ["waiting-retry", "start", "processing"],
  ] as const)("allows %s --%s--> %s", (from, action, expected) => {
    expect(transitionCompletionRun(from, action)).toBe(expected);
  });

  it("never re-runs a succeeded run", () => {
    // §111. A successful completion is not repeated automatically, and §112
    // says a deliberate re-completion would be a new explicit operation.
    for (const action of COMPLETION_RUN_ACTIONS) {
      expect(canTransitionCompletionRun("succeeded", action), action).toBe(false);
    }
    expect(isCompletionRunTerminal("succeeded")).toBe(true);
  });

  it("never restarts a terminally failed run by itself", () => {
    // §215. Recovery from a terminal failure is a decision, not a retry.
    for (const action of COMPLETION_RUN_ACTIONS) {
      expect(canTransitionCompletionRun("failed-terminal", action), action).toBe(false);
    }
  });

  it("makes an abandoned attempt claimable again", () => {
    // §133, §270. A worker that died leaves `processing`; without this the run
    // would sit there forever looking busy.
    expect(transitionCompletionRun("processing", "abandon")).toBe("waiting-retry");
    expect(isCompletionRunClaimable("waiting-retry")).toBe(true);
    expect(isCompletionRunClaimable("processing")).toBe(false);
  });

  it("claims only work that is not already in flight or finished", () => {
    for (const state of COMPLETION_RUN_STATES) {
      const expected = state === "pending" || state === "waiting-retry";
      expect(isCompletionRunClaimable(state), state).toBe(expected);
    }
  });
});

// ── Steps ────────────────────────────────────────────────────────────────────

describe("the completion step order", () => {
  it("is the three steps this architecture has", () => {
    // BACKEND-39 REVERSED migration 025's three. `field-merge` has to be a
    // distinct durable step producing a distinct artifact AND must not invoke
    // the sealer, and both together are only satisfiable if merging is
    // separable from sealing. See the vocabulary's own comment.
    expect([...COMPLETION_STEPS]).toEqual(
      ["field-merge", "certificate", "final-seal", "finalize"]);
    expect([...COMPLETION_STEP_ORDER]).toEqual([...COMPLETION_STEPS]);
  });

  it("resumes rather than restarts", () => {
    // §117, §254. A run whose seal succeeded never invokes the sealer again —
    // which matters because a certificate carrying a backend timestamp would
    // otherwise produce different bytes on every attempt.
    expect(nextCompletionStep([])).toBe("field-merge");
    expect(nextCompletionStep(["field-merge"])).toBe("certificate");
    expect(nextCompletionStep(["field-merge", "certificate"])).toBe("final-seal");
    expect(nextCompletionStep(
      ["field-merge", "certificate", "final-seal"])).toBe("finalize");
    expect(nextCompletionStep(
      ["field-merge", "certificate", "final-seal", "finalize"])).toBeNull();
  });

  it("refuses a ledger where a later step succeeded before an earlier one", () => {
    // A combination this module cannot produce. Reaching it means the ledger
    // was written by something else, and guessing would be worse than failing.
    expect(() => nextCompletionStep(["certificate"])).toThrow();
    expect(() => nextCompletionStep(["finalize"])).toThrow();
  });

  it("is satisfied only when every step succeeded", () => {
    expect(isCompletionSatisfied([])).toBe(false);
    expect(isCompletionSatisfied(["field-merge"])).toBe(false);
    expect(isCompletionSatisfied(["field-merge", "certificate"])).toBe(false);
    expect(isCompletionSatisfied(
      ["field-merge", "certificate", "final-seal"])).toBe(false);
    expect(isCompletionSatisfied(
      ["field-merge", "certificate", "final-seal", "finalize"])).toBe(true);
  });
});

// ── Failure classification ───────────────────────────────────────────────────

describe("failure classification", () => {
  it("classifies every code, with no default", () => {
    // A total record, so adding a code without deciding is a compile error —
    // and neither default is safe: retryable would retry corruption forever,
    // terminal would give up on an outage.
    for (const code of COMPLETION_FAILURE_CODES) {
      expect(COMPLETION_FAILURE_CLASSIFICATION[code], code).toBeDefined();
    }
    expect(Object.keys(COMPLETION_FAILURE_CLASSIFICATION).length)
      .toBe(COMPLETION_FAILURE_CODES.length);
  });

  it("treats deterministic corruption as terminal", () => {
    // §43, §244. These reproduce exactly on every attempt.
    for (const code of [
      "missing-submission", "missing-field-value", "input-inconsistent",
      "source-artifact-missing", "invalid-geometry", "output-missing",
    ] as const) {
      expect(classifyCompletionFailure(code), code).toBe("terminal");
      expect(runActionForFailure(code)).toBe("failTerminal");
    }
  });

  it("treats dependency outages as retryable", () => {
    for (const code of [
      "storage-unavailable", "sealer-unavailable", "database-unavailable",
      "attempt-abandoned",
    ] as const) {
      expect(classifyCompletionFailure(code), code).toBe("retryable");
      expect(runActionForFailure(code)).toBe("failRetryable");
    }
  });

  it("bounds retries even for a retryable cause", () => {
    // §46. Unbounded retry is how a broken dependency becomes a queue nobody
    // can drain.
    const base = { code: "storage-unavailable" as const, maxAttempts: 3 };
    expect(mayAttemptAgain({ ...base, attemptCount: 0 })).toBe(true);
    expect(mayAttemptAgain({ ...base, attemptCount: 2 })).toBe(true);
    expect(mayAttemptAgain({ ...base, attemptCount: 3 })).toBe(false);
  });

  it("never retries a terminal cause, however few attempts have run", () => {
    expect(mayAttemptAgain({
      code: "invalid-geometry", attemptCount: 0, maxAttempts: 10,
    })).toBe(false);
  });
});
