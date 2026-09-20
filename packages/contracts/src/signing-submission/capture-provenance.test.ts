// What a client may say about how a signature was made.
//
// The contract is the boundary here: `applied-from-saved` must be
// unrepresentable in a request, because only the server knows whether it took
// bytes from a stored signature. A value a client can claim is a value a
// dispute cannot rest on.

import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  SignatureRepresentationSchema, CAPTURE_PROVENANCE,
} from "./index.js";

const PNG = "iVBORw0KGgoAAAANSUhEUg";

describe("capture provenance in a submission", () => {
  it("accepts a drawn signature that reports how it was made", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: PNG, provenance: "drawn-live",
    })).toBe(true);
  });

  it("accepts an uploaded one, which used to be filed as drawn", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: PNG, provenance: "uploaded-live",
    })).toBe(true);
  });

  it("accepts a typed one", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "typed", text: "Real User", styleIndex: 0, provenance: "typed-live",
    })).toBe(true);
  });

  it("still accepts a client that says nothing", () => {
    // Older clients exist and must keep working. The record is then blank,
    // which is the honest reading of "nobody told us".
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: PNG,
    })).toBe(true);
  });

  it("REFUSES a client claiming the signature came from a saved one", () => {
    // The one value a dispute would turn on. The server decides it; a request
    // cannot contain it at all.
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: PNG, provenance: "applied-from-saved",
    })).toBe(false);
  });

  it("refuses an invented value", () => {
    expect(Value.Check(SignatureRepresentationSchema, {
      method: "drawn", base64: PNG, provenance: "wet-ink",
    })).toBe(false);
  });

  it("offers exactly the three a client may claim", () => {
    expect([...CAPTURE_PROVENANCE]).toEqual(
      ["typed-live", "drawn-live", "uploaded-live"]);
  });
});
