// The canonical signing workflow state policy (BACKEND-37).
//
// Every case here is a function of arguments — no clock, no database, no mock.
// That is what lets the routing rules be asserted exhaustively instead of
// sampled, and it is why the domain was kept pure.

import { describe, it, expect } from "vitest";
import {
  RECIPIENT_WORKFLOW_STATES, RECIPIENT_WORKFLOW_ACTIONS,
  canTransitionRecipient, transitionRecipient, isRecipientTerminal,
  isRequiredSigningParticipant, canParticipantSubmit,
  assessSigningEligibility, SIGNABLE_REQUEST_STATES, isRequestSignableState,
  isRequestTerminal, planWorkflowAdvance, deriveRequestState,
  isActive, SIGNING_REQUEST_STATES,
  type WorkflowRecipient, type RecipientWorkflowState,
} from "./index.js";
import type { RecipientType, SigningRequestState } from "@lagda/contracts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function person(over: Partial<WorkflowRecipient> = {}): WorkflowRecipient {
  seq += 1;
  return {
    recipientId: over.recipientId ?? `srr_${String(seq)}`,
    type: over.type ?? "signer",
    isRequired: over.isRequired ?? true,
    routingOrder: over.routingOrder ?? 1,
    state: over.state ?? "active",
  };
}

// ── The recipient state machine ──────────────────────────────────────────────

describe("the recipient state machine", () => {
  it("has exactly the four states the product can distinguish", () => {
    expect([...RECIPIENT_WORKFLOW_STATES]).toEqual(
      ["waiting", "active", "signed", "declined"]);
  });

  it.each([
    ["waiting", "activate", "active"],
    ["active", "sign", "signed"],
    ["active", "decline", "declined"],
  ] as const)("allows %s --%s--> %s", (from, action, expected) => {
    expect(transitionRecipient(from, action)).toBe(expected);
  });

  it("refuses waiting --sign--> signed", () => {
    // §28. An accepted submission for a recipient whose turn never came is an
    // integrity failure, not an early signature — they hold no credential, so
    // either provisioning or the routing evaluation is wrong.
    expect(canTransitionRecipient("waiting", "sign")).toBe(false);
    expect(() => transitionRecipient("waiting", "sign")).toThrow();
  });

  it("refuses waiting --decline--> declined", () => {
    // You cannot refuse a document you have never been given access to.
    expect(canTransitionRecipient("waiting", "decline")).toBe(false);
  });

  it("never lets a terminal recipient move again", () => {
    for (const state of ["signed", "declined"] as const) {
      expect(isRecipientTerminal(state)).toBe(true);
      for (const action of RECIPIENT_WORKFLOW_ACTIONS) {
        expect(canTransitionRecipient(state, action), `${state}/${action}`).toBe(false);
      }
    }
  });

  it("has no action that reaches signed except from active", () => {
    // The invariant §18 states: there is no pathway to SIGNED that does not
    // start from a recipient who was eligible to sign.
    const reaching = RECIPIENT_WORKFLOW_STATES.filter(
      from => RECIPIENT_WORKFLOW_ACTIONS.some(
        action => canTransitionRecipient(from, action)
          && transitionRecipient(from, action) === "signed"));
    expect(reaching).toEqual(["active"]);
  });
});

// ── Who the workflow waits for ───────────────────────────────────────────────

describe("required signing participants", () => {
  const REQUIRED: readonly RecipientType[] = [
    "signer", "approver", "reviewer", "acknowledgment-recipient",
  ];

  it.each(REQUIRED)("counts a required %s", type => {
    expect(isRequiredSigningParticipant({ type, isRequired: true })).toBe(true);
  });

  it.each(["viewer", "carbon-copy"] as const)("never counts a %s", type => {
    // §36 and §39. A carbon-copy that blocked completion would stall the
    // transaction forever waiting for somebody who was never asked for
    // anything — and `signedCount === recipientCount` is exactly that bug.
    expect(isRequiredSigningParticipant({ type, isRequired: true })).toBe(false);
    expect(canParticipantSubmit(type)).toBe(false);
  });

  it("does not count an OPTIONAL signer", () => {
    // BACKEND-31 persists `is_required` per recipient, so optional
    // participants are a product shape rather than an invention. They may act;
    // the request does not wait for them.
    expect(isRequiredSigningParticipant({ type: "signer", isRequired: false }))
      .toBe(false);
    expect(canParticipantSubmit("signer")).toBe(true);
  });
});

// ── Signability ──────────────────────────────────────────────────────────────

describe("signability is one answer", () => {
  it("permits exactly the two ACTIVE request states", () => {
    expect([...SIGNABLE_REQUEST_STATES]).toEqual(["sent", "partially-completed"]);
  });

  it("agrees with the lifecycle's own notion of active", () => {
    // Two modules, one answer. If either list is edited without the other this
    // fails, which is the drift §128 exists to prevent.
    for (const state of SIGNING_REQUEST_STATES) {
      expect(isRequestSignableState(state), state).toBe(isActive(state));
    }
  });

  it("refuses signing once the request is completion-ready", () => {
    // §96. Every required obligation is satisfied, so the workflow is shut even
    // though the document does not exist yet.
    expect(isRequestSignableState("completion-ready")).toBe(false);
    expect(isRequestTerminal("completion-ready")).toBe(false);
  });

  it.each(["completed", "declined", "cancelled", "expired"] as const)(
    "refuses signing on a %s request", state => {
      const access = assessSigningEligibility({
        requestState: state, recipientState: "active", recipientType: "signer",
      });
      expect(access.mayEnter).toBe(false);
      expect(access.maySubmit).toBe(false);
      expect(access.mayDecline).toBe(false);
      expect(access.blocker).toBe("request-not-signable");
    });

  it("tells a recipient who already signed so, rather than a generic denial", () => {
    // §191. After the last required signature the request is
    // `completion-ready`, so a request-first check would tell the person who
    // just signed that the document is not signable — true of the request and
    // misleading about them.
    const access = assessSigningEligibility({
      requestState: "completion-ready", recipientState: "signed",
      recipientType: "signer",
    });
    expect(access.blocker).toBe("already-signed");
    expect(access.maySubmit).toBe(false);
  });

  it("treats a MISSING workflow row as waiting, never as active", () => {
    const access = assessSigningEligibility({
      requestState: "sent", recipientState: null, recipientType: "signer",
    });
    expect(access.blocker).toBe("routing-waiting");
  });

  it("lets a viewer enter and neither submit nor decline", () => {
    // A viewer was not asked for anything, so there is nothing for them to
    // refuse either.
    const access = assessSigningEligibility({
      requestState: "sent", recipientState: "active", recipientType: "viewer",
    });
    expect(access.mayEnter).toBe(true);
    expect(access.maySubmit).toBe(false);
    expect(access.mayDecline).toBe(false);
  });

  it("returns a blocker exactly when entry is refused", () => {
    const states: readonly (RecipientWorkflowState | null)[] =
      [...RECIPIENT_WORKFLOW_STATES, null];
    for (const requestState of SIGNING_REQUEST_STATES) {
      for (const recipientState of states) {
        const access = assessSigningEligibility({
          requestState, recipientState, recipientType: "signer",
        });
        expect(access.mayEnter === (access.blocker === null),
          `${requestState}/${String(recipientState)}`).toBe(true);
      }
    }
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe("parallel routing", () => {
  it("leaves the other signers active when one signs", () => {
    // §40. One recipient's completion neither blocks nor deactivates anybody.
    const plan = planWorkflowAdvance([
      person({ routingOrder: 1, state: "signed" }),
      person({ routingOrder: 1, state: "active" }),
    ]);
    expect(plan.kind).toBe("waiting");
  });

  it("is completion-ready when the LAST required signer signs", () => {
    const plan = planWorkflowAdvance([
      person({ routingOrder: 1, state: "signed" }),
      person({ routingOrder: 1, state: "signed" }),
    ]);
    expect(plan.kind).toBe("completion-ready");
  });

  it("is not blocked by a carbon-copy that never acts", () => {
    // §36, §248. The CC is activated and receives the document; the request
    // does not wait for them.
    const plan = planWorkflowAdvance([
      person({ routingOrder: 1, state: "signed" }),
      person({ routingOrder: 1, state: "active", type: "carbon-copy" }),
    ]);
    expect(plan.kind).toBe("completion-ready");
  });
});

describe("sequential routing", () => {
  it("activates the next cohort when the first signer signs", () => {
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan).toEqual({
      kind: "activate", cohort: 2, active: ["b"], provision: ["b"],
    });
  });

  it("does NOT activate the next cohort on a partial one", () => {
    // §48, §234. A signs, B has not, C must stay waiting.
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "b", routingOrder: 1, state: "active" }),
      person({ recipientId: "c", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan.kind).toBe("waiting");
  });

  it("activates the next cohort ONCE the whole current cohort is signed", () => {
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "b", routingOrder: 1, state: "signed" }),
      person({ recipientId: "c", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan).toEqual({
      kind: "activate", cohort: 2, active: ["c"], provision: ["c"],
    });
  });

  it("activates EVERY member of an equal-order cohort together", () => {
    // §47. Equal routing order means parallel WITHIN the step.
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
      person({ recipientId: "c", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan.kind).toBe("activate");
    if (plan.kind !== "activate") throw new Error("unreachable");
    expect([...plan.active].sort()).toEqual(["b", "c"]);
  });

  it("activates a viewer WITHOUT provisioning them", () => {
    // The `active` / `provision` split: a viewer is activated and receives no
    // signing credential, because a signing credential is not what they need.
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "v", routingOrder: 2, state: "waiting", type: "viewer" }),
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan.kind).toBe("activate");
    if (plan.kind !== "activate") throw new Error("unreachable");
    expect([...plan.active].sort()).toEqual(["b", "v"]);
    expect(plan.provision).toEqual(["b"]);
  });

  it("walks THROUGH a cohort that contains nobody it would wait for", () => {
    // A cohort of viewers has nothing that could ever complete it, so stopping
    // there would strand the request with no future trigger. Every barren
    // cohort on the way is still genuinely activated.
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "v", routingOrder: 2, state: "waiting", type: "viewer" }),
      person({ recipientId: "b", routingOrder: 3, state: "waiting" }),
    ]);
    expect(plan.kind).toBe("activate");
    if (plan.kind !== "activate") throw new Error("unreachable");
    expect([...plan.active].sort()).toEqual(["b", "v"]);
    expect(plan.provision).toEqual(["b"]);
  });

  it("uses the earliest cohort PRESENT, not the literal 1", () => {
    // BACKEND-31 permits a non-contiguous sequence, so deleting the only
    // recipient at step 1 leaves 2 and 3. Assuming 1 would advance nobody.
    const plan = planWorkflowAdvance([
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
      person({ recipientId: "c", routingOrder: 3, state: "waiting" }),
    ]);
    expect(plan.kind).toBe("activate");
    if (plan.kind !== "activate") throw new Error("unreachable");
    expect(plan.cohort).toBe(2);
    expect(plan.active).toEqual(["b"]);
  });

  it("is deterministic", () => {
    // §137. Same states in, same plan out — including the ORDER of the lists,
    // which a caller uses to provision.
    const people = [
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "c", routingOrder: 2, state: "waiting" }),
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
    ];
    expect(planWorkflowAdvance(people)).toEqual(planWorkflowAdvance(people));
  });
});

describe("decline outranks everything", () => {
  it("ends the request even when a cohort was ready to advance", () => {
    // Checked FIRST, so a request cannot activate its next cohort on the same
    // evaluation that discovers it is over.
    const plan = planWorkflowAdvance([
      person({ recipientId: "a", routingOrder: 1, state: "signed" }),
      person({ recipientId: "d", routingOrder: 1, state: "declined" }),
      person({ recipientId: "b", routingOrder: 2, state: "waiting" }),
    ]);
    expect(plan).toEqual({ kind: "declined", declinedBy: "d" });
  });
});

describe("routing integrity", () => {
  it("refuses to guess on an empty request", () => {
    expect(planWorkflowAdvance([])).toEqual(
      { kind: "invalid", reason: "no-recipients" });
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses routing order %s", order => {
    // §139. A corrupt snapshot must fail safely rather than send a legal
    // document to somebody nobody chose.
    const plan = planWorkflowAdvance([person({ routingOrder: order })]);
    expect(plan).toEqual({ kind: "invalid", reason: "invalid-routing-order" });
  });

  it("refuses a request nobody is required to act on", () => {
    // §140. Answering "completion-ready" would mean a request completing with
    // nobody having signed anything. Send eligibility already refuses to send
    // one, so this is a corruption check.
    const plan = planWorkflowAdvance([
      person({ type: "carbon-copy" }), person({ type: "viewer" }),
    ]);
    expect(plan).toEqual({ kind: "invalid", reason: "no-required-participants" });
  });
});

// ── The request state that follows ───────────────────────────────────────────

describe("the derived request state", () => {
  it("never produces completed", () => {
    // §12 and §69. BACKEND-37 holds no path to it, and this asserts the
    // absence over EVERY combination rather than over a sample.
    const plans = [
      { kind: "completion-ready" } as const,
      { kind: "declined", declinedBy: "x" } as const,
      { kind: "waiting", outstandingRequired: 1 } as const,
      { kind: "activate", cohort: 2, active: ["b"], provision: ["b"] } as const,
      { kind: "invalid", reason: "no-recipients" } as const,
    ];
    for (const state of SIGNING_REQUEST_STATES) {
      for (const plan of plans) {
        expect(deriveRequestState(state, plan), `${state}/${plan.kind}`)
          .not.toBe("completed");
      }
    }
  });

  it("moves a sent request to partially-completed while work remains", () => {
    expect(deriveRequestState("sent", { kind: "waiting", outstandingRequired: 1 }))
      .toBe("partially-completed");
  });

  it("returns null rather than rewriting the same state", () => {
    // No write, so no spurious `updated_at`, no duplicate transition and
    // nothing for a second attempt to converge on (§176).
    expect(deriveRequestState(
      "partially-completed", { kind: "waiting", outstandingRequired: 1 })).toBeNull();
  });

  it("refuses to move a request that is not signable", () => {
    const terminal: readonly SigningRequestState[] =
      ["completed", "declined", "cancelled", "expired", "completion-ready", "draft"];
    for (const state of terminal) {
      expect(deriveRequestState(state, { kind: "completion-ready" }), state).toBeNull();
    }
  });
});
