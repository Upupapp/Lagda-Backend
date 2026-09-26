import { describe, it, expect } from "vitest";
import { resolveSubmission } from "./submission.js";
import { fieldInputPolicy } from "./field-input-policy.js";
import { renderTypeFor } from "../preparation/index.js";

const recipient = { name: "Maria Santos", email: "maria@example.com", organization: null };
const block = { fieldId: "f-block", type: "signature-block" as const, required: true };

describe("signature-block field", () => {
  it("is signer-supplied, like a signature, with its own renderer", () => {
    expect(fieldInputPolicy("signature-block")).toMatchObject({
      authority: "RECIPIENT_SUPPLIED", valueKind: "signature-representation",
    });
    expect(renderTypeFor("signature-block")).toBe("signature-block");
  });

  it("accepts the signature and asks for the signature representation", () => {
    const result = resolveSubmission({
      assigned: [block], recipient, acceptedAt: 0,
      submitted: [{ fieldId: "f-block", kind: "signature" }],
    });
    expect(result).toMatchObject({
      ok: true, needsSignature: true, needsInitials: false,
      values: [{ fieldId: "f-block", type: "signature-block", source: "RECIPIENT_PROVIDED",
        value: { kind: "representation", purpose: "signature" } }],
    });
  });

  it("is required like a signature", () => {
    const result = resolveSubmission({ assigned: [block], recipient, acceptedAt: 0, submitted: [] });
    expect(result).toMatchObject({ ok: false, problems: [{ code: "field-required", fieldId: "f-block" }] });
  });

  it("refuses anything but a signature", () => {
    const result = resolveSubmission({
      assigned: [block], recipient, acceptedAt: 0,
      submitted: [{ fieldId: "f-block", kind: "text", text: "Maria" }],
    });
    expect(result).toMatchObject({ ok: false, problems: [{ code: "field-type-mismatch" }] });
  });
});
