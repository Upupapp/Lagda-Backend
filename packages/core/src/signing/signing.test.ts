// Signing domain rules, named as business rules rather than as test numbers.
//
// No mocks anywhere: pure domain logic needs none, and if it did, the logic
// would be sitting in the wrong layer. All timestamps are fixed, so these
// assertions mean the same thing in 2036.

import { describe, it, expect } from "vitest";
import {
  SIGNING_REQUEST_STATES, SIGNING_ACTIONS, NON_LIFECYCLE_STATUSES,
  isTerminal, isEditable, isActive, canTransition, transition, allowedActions,
  isExpired, type SigningRequestState,
} from "./lifecycle.js";
import {
  PARTICIPANT_ACTIONS, isBlockingAction, actionAlwaysRequiresSignature,
  requiresSignatureField,
} from "./participants.js";
import {
  evaluateSendReadiness, evaluateRecipientEligibility,
  evaluateCompletionEligibility, computeProgress,
  type ParticipantView, type SigningRequestView,
} from "./policies.js";
import { InvalidStateTransitionError, InvariantViolationError, type Instant } from "../common/index.js";

const NOW = Date.parse("2026-08-09T00:00:00.000Z") as Instant;
const YESTERDAY = Date.parse("2026-08-08T00:00:00.000Z") as Instant;
const TOMORROW = Date.parse("2026-08-10T00:00:00.000Z") as Instant;

// ── Builders ─────────────────────────────────────────────────────────────────

const participant = (over: Partial<ParticipantView> = {}): ParticipantView => ({
  assignmentId: "asg_1",
  action: "sign",
  signatureRequested: false,
  assignedSignatureFieldCount: 1,
  order: 1,
  completed: false,
  declined: false,
  ...over,
});

const request = (over: Partial<SigningRequestView> = {}): SigningRequestView => ({
  state: "draft",
  hasDocument: true,
  participants: [participant()],
  expiresAt: null,
  ...over,
});

const codes = (result: { ok: boolean; issues?: readonly { code: string }[] }) =>
  result.ok ? [] : (result.issues ?? []).map(i => i.code);

// ── Participant actions ──────────────────────────────────────────────────────

describe("participant actions", () => {
  it("lets viewers and copy recipients never hold up a request", () => {
    expect(isBlockingAction("view")).toBe(false);
    expect(isBlockingAction("receive-copy")).toBe(false);
    for (const action of ["sign", "approve", "review", "acknowledge"] as const) {
      expect(isBlockingAction(action), action).toBe(true);
    }
  });

  it("classifies every canonical action", () => {
    // Adding a seventh action without deciding whether it blocks fails here.
    for (const action of PARTICIPANT_ACTIONS) {
      expect(typeof isBlockingAction(action), action).toBe("boolean");
    }
  });

  it("always requires a signature field to sign, and only to sign", () => {
    expect(actionAlwaysRequiresSignature("sign")).toBe(true);
    for (const action of ["approve", "review", "acknowledge", "view", "receive-copy"] as const) {
      expect(actionAlwaysRequiresSignature(action), action).toBe(false);
    }
  });

  it("lets approve, review and acknowledge optionally require a signature", () => {
    expect(requiresSignatureField("approve", false)).toBe(false);
    expect(requiresSignatureField("approve", true)).toBe(true);
    expect(requiresSignatureField("review", true)).toBe(true);
    expect(requiresSignatureField("acknowledge", true)).toBe(true);
  });

  it("refuses to require a signature from a viewer", () => {
    // Not a stricter configuration — an impossible one.
    expect(() => requiresSignatureField("view", true)).toThrow(InvariantViolationError);
    expect(() => requiresSignatureField("receive-copy", true)).toThrow(InvariantViolationError);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("signing request lifecycle", () => {
  it("treats completed, declined, cancelled and expired as terminal", () => {
    for (const state of ["completed", "declined", "cancelled", "expired"] as const) {
      expect(isTerminal(state), state).toBe(true);
    }
    for (const state of ["draft", "ready-to-send", "sent", "partially-completed"] as const) {
      expect(isTerminal(state), state).toBe(false);
    }
  });

  it("classifies every modelled state", () => {
    for (const state of SIGNING_REQUEST_STATES) {
      expect(typeof isTerminal(state), state).toBe("boolean");
      expect(typeof isEditable(state), state).toBe("boolean");
      expect(typeof isActive(state), state).toBe("boolean");
    }
  });

  it("records why some canonical statuses are not lifecycle states", () => {
    // These are facts that occurred, not states a request is in. Documented
    // rather than silently dropped.
    for (const status of ["delivered", "viewed", "authentication-completed"]) {
      expect(Object.keys(NON_LIFECYCLE_STATUSES)).toContain(status);
    }
  });

  it.each([
    ["draft", "markReadyToSend", "ready-to-send"],
    ["draft", "cancel", "cancelled"],
    ["ready-to-send", "returnToDraft", "draft"],
    ["ready-to-send", "send", "sent"],
    ["sent", "recordParticipantCompletion", "partially-completed"],
    // BACKEND-37 replaced the direct `complete` edge. The last signature makes
    // a request COMPLETION-READY, not completed: the signed document does not
    // exist until the completion pipeline has produced it, and `completed` is
    // terminal and cannot be walked back if that fails.
    ["sent", "markCompletionReady", "completion-ready"],
    ["sent", "decline", "declined"],
    ["sent", "expire", "expired"],
    ["partially-completed", "markCompletionReady", "completion-ready"],
    // The ONLY edge into `completed`, and BACKEND-37 cannot take it.
    ["completion-ready", "complete", "completed"],
    ["partially-completed", "cancel", "cancelled"],
  ] as const)("allows %s --%s--> %s", (from, action, expected) => {
    expect(transition(from, action)).toBe(expected);
  });

  it.each([
    ["completed", "send"],
    ["completed", "decline"],
    ["completed", "cancel"],
    ["cancelled", "send"],
    ["cancelled", "complete"],
    ["expired", "complete"],
    ["declined", "complete"],
    ["draft", "complete"],
    ["draft", "send"],
    ["ready-to-send", "complete"],
  ] as const)("forbids %s --%s-->", (from, action) => {
    expect(canTransition(from, action)).toBe(false);
    expect(() => transition(from, action)).toThrow(InvalidStateTransitionError);
  });

  it("never lets a terminal request become active again", () => {
    // The durable invariant, checked across the whole action set rather than
    // one case at a time.
    for (const state of SIGNING_REQUEST_STATES.filter(isTerminal)) {
      expect(allowedActions(state), state).toEqual([]);
      for (const action of SIGNING_ACTIONS) {
        expect(canTransition(state, action), `${state} → ${action}`).toBe(false);
      }
    }
  });

  it("accounts for every state in the transition table", () => {
    for (const state of SIGNING_REQUEST_STATES) {
      expect(() => allowedActions(state), state).not.toThrow();
    }
  });
});

describe("expiry", () => {
  it("is derived from a supplied time, never a clock read", () => {
    expect(isExpired("sent", YESTERDAY, NOW)).toBe(true);
    expect(isExpired("sent", TOMORROW, NOW)).toBe(false);
  });

  it("treats a request with no deadline as never expiring", () => {
    expect(isExpired("sent", null, NOW)).toBe(false);
  });

  it("does not expire a request that already finished", () => {
    // A completed transaction does not stop being completed at midnight.
    for (const state of ["completed", "declined", "cancelled"] as const) {
      expect(isExpired(state, YESTERDAY, NOW), state).toBe(false);
    }
  });
});

// ── Send readiness ───────────────────────────────────────────────────────────

describe("send readiness", () => {
  it("accepts a well-formed draft", () => {
    expect(evaluateSendReadiness(request()).ok).toBe(true);
  });

  it("cannot send without a document", () => {
    expect(codes(evaluateSendReadiness(request({ hasDocument: false })))).toContain("no-document");
  });

  it("cannot send to viewers alone", () => {
    // Nobody could advance it, so it would wait forever.
    const viewersOnly = request({
      participants: [
        participant({ assignmentId: "a", action: "view", assignedSignatureFieldCount: 0 }),
        participant({ assignmentId: "b", action: "receive-copy", assignedSignatureFieldCount: 0 }),
      ],
    });
    expect(codes(evaluateSendReadiness(viewersOnly))).toContain("no-blocking-participant");
  });

  it("cannot send when a signer has no signature field", () => {
    const unsigned = request({ participants: [participant({ assignedSignatureFieldCount: 0 })] });
    expect(codes(evaluateSendReadiness(unsigned))).toContain("missing-signature-field");
  });

  it("does not demand a signature field from an approver who was not asked for one", () => {
    const approver = request({
      participants: [participant({ action: "approve", assignedSignatureFieldCount: 0 })],
    });
    expect(evaluateSendReadiness(approver).ok).toBe(true);
  });

  it("cannot send an already-sent request", () => {
    expect(codes(evaluateSendReadiness(request({ state: "sent" })))).toContain("not-editable");
  });

  it("requires signing order to start at 1", () => {
    const zeroBased = request({ participants: [participant({ order: 0 })] });
    expect(codes(evaluateSendReadiness(zeroBased))).toContain("invalid-signing-order");
  });

  it("rejects a gap in signing order", () => {
    const gap = request({
      participants: [
        participant({ assignmentId: "a", order: 1 }),
        participant({ assignmentId: "b", order: 3 }),
      ],
    });
    expect(codes(evaluateSendReadiness(gap))).toContain("invalid-signing-order");
  });

  it("allows several participants to share a position and act in parallel", () => {
    const parallel = request({
      participants: [
        participant({ assignmentId: "a", order: 1 }),
        participant({ assignmentId: "b", order: 1 }),
      ],
    });
    expect(evaluateSendReadiness(parallel).ok).toBe(true);
  });

  it("reports every problem at once rather than the first", () => {
    const broken = request({
      hasDocument: false,
      participants: [participant({ assignedSignatureFieldCount: 0, order: 5 })],
    });
    const found = codes(evaluateSendReadiness(broken));
    expect(found).toContain("no-document");
    expect(found).toContain("missing-signature-field");
    expect(found).toContain("invalid-signing-order");
  });
});

// ── Recipient eligibility ────────────────────────────────────────────────────

describe("recipient eligibility", () => {
  const twoStep = (over: Partial<ParticipantView>[] = []) =>
    request({
      state: "sent",
      participants: [
        participant({ assignmentId: "first", order: 1, ...over[0] }),
        participant({ assignmentId: "second", order: 2, ...over[1] }),
      ],
    });

  it("lets the first participant act immediately", () => {
    expect(evaluateRecipientEligibility(twoStep(), "first", NOW).ok).toBe(true);
  });

  it("makes a later participant wait for an earlier one", () => {
    expect(codes(evaluateRecipientEligibility(twoStep(), "second", NOW)))
      .toContain("waiting-for-earlier-participant");
  });

  it("releases the later participant once the earlier one has acted", () => {
    const advanced = twoStep([{ completed: true }]);
    expect(evaluateRecipientEligibility(advanced, "second", NOW).ok).toBe(true);
  });

  it("does not make same-position participants wait for each other", () => {
    const parallel = request({
      state: "sent",
      participants: [
        participant({ assignmentId: "a", order: 1 }),
        participant({ assignmentId: "b", order: 1 }),
      ],
    });
    expect(evaluateRecipientEligibility(parallel, "b", NOW).ok).toBe(true);
  });

  it("refuses a participant who already acted", () => {
    const done = twoStep([{ completed: true }]);
    expect(codes(evaluateRecipientEligibility(done, "first", NOW))).toContain("already-completed");
  });

  it("refuses to let a viewer act", () => {
    const viewer = request({
      state: "sent",
      participants: [
        participant({ assignmentId: "signer", order: 1 }),
        participant({ assignmentId: "watcher", action: "view", order: 1, assignedSignatureFieldCount: 0 }),
      ],
    });
    expect(codes(evaluateRecipientEligibility(viewer, "watcher", NOW)))
      .toContain("action-does-not-block");
  });

  it("refuses when the request is not active", () => {
    for (const state of ["draft", "completed", "cancelled"] as SigningRequestState[]) {
      const inactive = request({ state, participants: [participant({ assignmentId: "only" })] });
      expect(codes(evaluateRecipientEligibility(inactive, "only", NOW)), state)
        .toContain("request-not-active");
    }
  });

  it("refuses after the deadline", () => {
    const lapsed = request({
      state: "sent", expiresAt: YESTERDAY,
      participants: [participant({ assignmentId: "only" })],
    });
    expect(codes(evaluateRecipientEligibility(lapsed, "only", NOW))).toContain("request-expired");
  });

  it("refuses an unknown participant", () => {
    expect(evaluateRecipientEligibility(twoStep(), "stranger", NOW).ok).toBe(false);
  });
});

// ── Completion ───────────────────────────────────────────────────────────────

describe("completion eligibility", () => {
  it("completes when every blocking participant has acted", () => {
    const done = request({ state: "sent", participants: [participant({ completed: true })] });
    expect(evaluateCompletionEligibility(done, NOW).ok).toBe(true);
  });

  it("cannot complete while a required participant is pending", () => {
    const pending = request({
      state: "sent",
      participants: [
        participant({ assignmentId: "a", completed: true }),
        participant({ assignmentId: "b", order: 2, completed: false }),
      ],
    });
    expect(codes(evaluateCompletionEligibility(pending, NOW)))
      .toContain("blocking-participant-outstanding");
  });

  it("ignores viewers who never opened the document", () => {
    const withViewer = request({
      state: "sent",
      participants: [
        participant({ assignmentId: "signer", completed: true }),
        participant({ assignmentId: "watcher", action: "view", assignedSignatureFieldCount: 0 }),
      ],
    });
    expect(evaluateCompletionEligibility(withViewer, NOW).ok).toBe(true);
  });

  it("cannot complete once a participant declined", () => {
    const declined = request({
      state: "sent",
      participants: [participant({ completed: true, declined: true })],
    });
    expect(codes(evaluateCompletionEligibility(declined, NOW))).toContain("participant-declined");
  });

  it("cannot complete a request that is not active", () => {
    const draft = request({ participants: [participant({ completed: true })] });
    expect(codes(evaluateCompletionEligibility(draft, NOW))).toContain("request-not-active");
  });

  it("cannot complete after the deadline", () => {
    const lapsed = request({
      state: "sent", expiresAt: YESTERDAY,
      participants: [participant({ completed: true })],
    });
    expect(codes(evaluateCompletionEligibility(lapsed, NOW))).toContain("request-expired");
  });
});

describe("progress", () => {
  it("counts only participants who can hold the request up", () => {
    const mixed = request({
      participants: [
        participant({ assignmentId: "a", completed: true }),
        participant({ assignmentId: "b", order: 2 }),
        participant({ assignmentId: "c", action: "view", assignedSignatureFieldCount: 0 }),
      ],
    });
    expect(computeProgress(mixed)).toEqual({ completed: 1, total: 2 });
  });
});
