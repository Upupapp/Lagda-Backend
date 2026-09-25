// Send readiness: who must have a field before a request can be sent.

import { describe, it, expect } from "vitest";
import { assessSnapshotReadiness } from "../index.js";
import type { RecipientType } from "@lagda/contracts";

const recipient = (recipientId: string, type: RecipientType, isRequired = true) =>
  ({ recipientId, type, isRequired });
const fieldFor = (recipientId: string) =>
  ({ type: "signature" as const, recipientId, hasStaticValue: false });

describe("send readiness", () => {
  it("does not require a field for an approver (069: they approve or skip)", () => {
    expect(assessSnapshotReadiness(
      [recipient("s", "signer"), recipient("a", "approver")],
      [fieldFor("s")],
    )).toEqual({ ready: true });
  });

  it("still requires a field for every required signer", () => {
    const result = assessSnapshotReadiness(
      [recipient("s", "signer"), recipient("a", "approver")],
      [fieldFor("a")],
    );
    expect(result).toEqual({
      ready: false, blockers: [{ kind: "participant-without-field", recipientIndex: 0 }],
    });
  });

  it("still requires a field for a required reviewer", () => {
    const result = assessSnapshotReadiness(
      [recipient("s", "signer"), recipient("r", "reviewer")],
      [fieldFor("s")],
    );
    expect(result.ready).toBe(false);
  });
});
