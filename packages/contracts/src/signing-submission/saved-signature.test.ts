// Asking to use a mark the server already holds.
//
// The whole safety of `applied-from-saved` rests on one property: a client
// cannot supply the content. If it could, it could assert that provenance for
// anything at all, and the value would mean nothing in a dispute.

import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { SignatureRepresentationSchema } from "./index.js";

describe("the saved representation", () => {
  it("is an instruction and nothing more", () => {
    expect(Value.Check(SignatureRepresentationSchema, { method: "saved" })).toBe(true);
  });

  it("REFUSES an attempt to smuggle bytes in with it", () => {
    // The one that matters. A client that could attach content could claim
    // `applied-from-saved` for a signature the account never stored.
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "saved", base64: "iVBORw0KGgoAAAANSUhEUg",
    })).toBe(false);
  });

  it("refuses an attempt to smuggle text in with it", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "saved", text: "Someone Else", styleIndex: 0,
    })).toBe(false);
  });

  it("refuses a provenance claim alongside it", () => {
    // Doubly refused: `applied-from-saved` is not in the client vocabulary at
    // all, and this shape accepts no extra properties either way.
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "saved", provenance: "applied-from-saved",
    })).toBe(false);
  });

  it("leaves the two existing shapes working unchanged", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: "iVBORw0KGgoAAAANSUhEUg",
    })).toBe(true);
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "typed", text: "Real User", styleIndex: 0,
    })).toBe(true);
  });
});
