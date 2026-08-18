// The delivery lifecycle, and the states BACKEND-44 refuses to write.

import { describe, it, expect } from "vitest";
import {
  DELIVERY_STATES, INITIAL_DELIVERY_STATE, PRODUCIBLE_BY_BACKEND_44,
  DELIVERY_ACTIONS, isDeliveryTerminal, isDeliverySendable,
  canApplyDeliveryAction, availableDeliveryActions, applyDeliveryAction,
  type DeliveryState,
} from "./delivery-state.js";

describe("delivery states", () => {
  it("creates deliveries in PENDING and nothing else", () => {
    expect(INITIAL_DELIVERY_STATE).toBe("PENDING");
  });

  it("has no SENT state", () => {
    // S117. `SENT` means queued, accepted or delivered depending on who reads
    // it -- the one word most likely to put a delivery claim in a UI backed by
    // a database insert.
    expect(DELIVERY_STATES as readonly string[]).not.toContain("SENT");
  });

  it("limits BACKEND-44 to states reachable without a provider", () => {
    // S267, S312. The three states LAGDA can reach on its own evidence.
    expect([...PRODUCIBLE_BY_BACKEND_44].sort())
      .toEqual(["CANCELLED", "PENDING", "SUPPRESSED"]);
    for (const claimed of ["PROVIDER_ACCEPTED", "DELIVERED", "BOUNCED"] as const) {
      expect(PRODUCIBLE_BY_BACKEND_44 as readonly string[]).not.toContain(claimed);
    }
  });

  it("treats provider acceptance as non-terminal", () => {
    // A provider that accepted a message may still report a bounce. Calling
    // acceptance the end is how "the queue took it" becomes "they received it".
    expect(isDeliveryTerminal("PROVIDER_ACCEPTED")).toBe(false);
    expect(isDeliveryTerminal("DELIVERED")).toBe(true);
    expect(isDeliveryTerminal("BOUNCED")).toBe(true);
  });

  it("treats a retryable failure as non-terminal", () => {
    expect(isDeliveryTerminal("FAILED_RETRYABLE")).toBe(false);
    expect(isDeliveryTerminal("FAILED_TERMINAL")).toBe(true);
  });

  it("classifies every state as terminal or not", () => {
    // The switch is exhaustive by `assertNever`; this proves no value throws.
    for (const state of DELIVERY_STATES) {
      expect(typeof isDeliveryTerminal(state)).toBe("boolean");
    }
  });

  it("permits transport only from PENDING and FAILED_RETRYABLE", () => {
    const sendable = DELIVERY_STATES.filter(isDeliverySendable);
    expect([...sendable].sort()).toEqual(["FAILED_RETRYABLE", "PENDING"]);
  });
});

describe("transitions", () => {
  it("gives terminal states no outgoing action", () => {
    // A delivered message cannot be walked back to pending and re-sent.
    for (const state of DELIVERY_STATES.filter(isDeliveryTerminal)) {
      expect(availableDeliveryActions(state)).toEqual([]);
    }
  });

  it("allows cancellation only while PENDING", () => {
    // S111, S113. Once a worker holds the row the decision is no longer purely
    // LAGDA's, and once a provider has the bytes nothing retracts them.
    expect(canApplyDeliveryAction("PENDING", "cancel")).toBe(true);
    for (const state of DELIVERY_STATES.filter(s => s !== "PENDING")) {
      expect(canApplyDeliveryAction(state, "cancel")).toBe(false);
    }
  });

  it("allows suppression where a credential can still be found dead", () => {
    // PENDING before claiming, PROCESSING after a validity check, and
    // FAILED_RETRYABLE before another attempt.
    const suppressible = DELIVERY_STATES
      .filter(state => canApplyDeliveryAction(state, "suppress"));
    expect([...suppressible].sort())
      .toEqual(["FAILED_RETRYABLE", "PENDING", "PROCESSING"]);
  });

  it("returns null for a forbidden transition rather than throwing", () => {
    // At-least-once delivery means a worker routinely tries to claim a row
    // another worker already claimed. That is contention, not a defect.
    expect(applyDeliveryAction("PROCESSING", "claim")).toBeNull();
    expect(applyDeliveryAction("PENDING", "claim")).toBe("PROCESSING");
  });

  it("never transitions into a state outside the declared vocabulary", () => {
    const declared = new Set<string>(DELIVERY_STATES);
    for (const state of DELIVERY_STATES) {
      for (const action of DELIVERY_ACTIONS) {
        const next = applyDeliveryAction(state, action);
        if (next !== null) expect(declared.has(next)).toBe(true);
      }
    }
  });

  it("reaches every non-initial state through some transition", () => {
    // A declared state nothing can reach is vocabulary with no machine behind
    // it. Every state except the initial one must have an inbound edge.
    const reachable = new Set<DeliveryState>();
    for (const state of DELIVERY_STATES) {
      for (const action of DELIVERY_ACTIONS) {
        const next = applyDeliveryAction(state, action);
        if (next !== null) reachable.add(next);
      }
    }
    for (const state of DELIVERY_STATES.filter(s => s !== INITIAL_DELIVERY_STATE)) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});
