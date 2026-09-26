// Reviewed over Name and Approved over Name (081): who may hold them, who
// supplies their value (nobody), and what a submission does with each.

import { describe, it, expect } from "vitest";
import { RECIPIENT_TYPES, PREPARATION_FIELD_TYPES } from "@lagda/contracts";
import { resolveSubmission } from "./submission.js";
import { fieldInputPolicy, isServerDerivedField } from "./field-input-policy.js";
import { assessSnapshotReadiness, describeBlocker } from "./snapshot.js";
import {
  mayHoldFieldType, reservedHolderFor, describeReservedHolder,
} from "../recipients/index.js";

const recipient = { name: "Maria Santos", email: "maria@example.com", organization: null };
const ACCEPTED_AT = Date.parse("2026-09-26T03:00:00.000Z");
const review = { fieldId: "f-review", type: "review-block" as const, required: true };
const approval = { fieldId: "f-approval", type: "approval-block" as const, required: false };

describe("outcome-block policy", () => {
  it("is server-derived: a review block is the acceptance date, an approval block stores nothing", () => {
    expect(fieldInputPolicy("review-block")).toMatchObject({
      authority: "SERVER_DERIVED", valueKind: "date", hasRecipientRenderer: true,
    });
    expect(fieldInputPolicy("approval-block")).toMatchObject({
      authority: "SERVER_DERIVED", valueKind: "none", hasRecipientRenderer: true,
    });
    expect(isServerDerivedField("review-block")).toBe(true);
    expect(isServerDerivedField("approval-block")).toBe(true);
  });
});

describe("who may hold an outcome block", () => {
  it("reserves a review block for a reviewer and an approval block for an approver", () => {
    expect(reservedHolderFor("review-block")).toBe("reviewer");
    expect(reservedHolderFor("approval-block")).toBe("approver");
    for (const type of RECIPIENT_TYPES) {
      expect(mayHoldFieldType(type, "review-block"), type).toBe(type === "reviewer");
      expect(mayHoldFieldType(type, "approval-block"), type).toBe(type === "approver");
    }
  });

  it("reserves nothing else", () => {
    for (const type of PREPARATION_FIELD_TYPES) {
      if (type === "review-block" || type === "approval-block") continue;
      expect(reservedHolderFor(type), type).toBeNull();
      expect(mayHoldFieldType("signer", type), type).toBe(true);
      expect(mayHoldFieldType("reviewer", type), type).toBe(true);
    }
  });

  it("still refuses a viewer and a copy recipient anything", () => {
    expect(mayHoldFieldType("viewer", "signature")).toBe(false);
    expect(mayHoldFieldType("carbon-copy", "text")).toBe(false);
  });

  it("names the types, and only the types, when it refuses", () => {
    expect(describeReservedHolder("review-block"))
      .toBe('"review-block" fields may be held only by a recipient of type "reviewer"');
    expect(describeReservedHolder("approval-block")).toContain('"approver"');
  });
});

describe("a reviewer's submission", () => {
  it("derives the review block from the acceptance instant, with nothing submitted", () => {
    const result = resolveSubmission({
      assigned: [review], recipient, acceptedAt: ACCEPTED_AT, submitted: [],
    });
    expect(result).toEqual({
      ok: true, needsSignature: false, needsInitials: false,
      values: [{
        fieldId: "f-review", type: "review-block", source: "SERVER_DERIVED",
        value: { kind: "instant", at: ACCEPTED_AT },
      }],
    });
  });

  it("is never failed as missing, though the block is required", () => {
    const result = resolveSubmission({
      assigned: [review, { fieldId: "f-note", type: "text", required: false }],
      recipient, acceptedAt: ACCEPTED_AT, submitted: [],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a client value for the review block rather than ignoring it", () => {
    const result = resolveSubmission({
      assigned: [review], recipient, acceptedAt: ACCEPTED_AT,
      submitted: [{ fieldId: "f-review", kind: "text", text: "2020-01-01" }],
    });
    expect(result).toEqual({
      ok: false, problems: [{ code: "field-server-owned", fieldId: "f-review" }],
    });
  });
});

describe("an approver's approval", () => {
  it("writes no row for an approval block", () => {
    const result = resolveSubmission({
      assigned: [approval], recipient, acceptedAt: ACCEPTED_AT, submitted: [],
    });
    expect(result).toEqual({ ok: true, values: [], needsSignature: false, needsInitials: false });
  });

  it("refuses a client value for it", () => {
    const result = resolveSubmission({
      assigned: [approval], recipient, acceptedAt: ACCEPTED_AT,
      submitted: [{ fieldId: "f-approval", kind: "checkbox", checked: true }],
    });
    expect(result).toMatchObject({
      ok: false, problems: [{ code: "field-server-owned", fieldId: "f-approval" }],
    });
  });
});

describe("readiness", () => {
  const people = [
    { recipientId: "r-signer", type: "signer" as const, isRequired: true },
    { recipientId: "r-reviewer", type: "reviewer" as const, isRequired: true },
    { recipientId: "r-approver", type: "approver" as const, isRequired: true },
  ];
  const sign = { type: "signature" as const, recipientId: "r-signer", hasStaticValue: false };

  it("accepts each block on its own role", () => {
    expect(assessSnapshotReadiness(people, [
      sign,
      { type: "review-block", recipientId: "r-reviewer", hasStaticValue: false },
      { type: "approval-block", recipientId: "r-approver", hasStaticValue: false },
    ])).toEqual({ ready: true });
  });

  it("refuses a block that reached the wrong role, naming the index and the rule", () => {
    const readiness = assessSnapshotReadiness(people, [
      sign,
      { type: "review-block", recipientId: "r-signer", hasStaticValue: false },
      { type: "approval-block", recipientId: "r-reviewer", hasStaticValue: false },
    ]);
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    const messages = readiness.blockers.map(describeBlocker);
    expect(messages).toContain(
      'fields[1]: "review-block" fields may be held only by a recipient of type "reviewer"');
    expect(messages).toContain(
      'fields[2]: "approval-block" fields may be held only by a recipient of type "approver"');
  });

  it("adds no send blocker for a reviewer without a review block", () => {
    // The reviewer's other field satisfies "a field per participant"; the
    // block itself is the frontend's to place, not a readiness rule.
    expect(assessSnapshotReadiness(people, [
      sign, { type: "text", recipientId: "r-reviewer", hasStaticValue: false },
    ])).toEqual({ ready: true });
  });
});
