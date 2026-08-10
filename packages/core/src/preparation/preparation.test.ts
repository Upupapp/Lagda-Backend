// Preparation domain rules. Pure functions, no PDF, no database.
//
// The geometry cases are the ones that matter: a rectangle that passes here and
// should not produces a signature in the wrong place on a signed contract, and
// nothing downstream can detect it.

import { describe, it, expect } from "vitest";
import {
  validateRect, roundRect, roundCoordinate, isValidPageNumber, canPlaceFields,
  validateFieldLabel, effectiveRequired, isInherentlyRequired,
  derivePreparationState, isPreparationEditable, renderTypeFor,
  MINIMUM_FIELD_EXTENT, COORDINATE_PRECISION,
  PREPARATION_FIELD_TYPES, PREPARATION_FIELD_LABEL_MAX_LENGTH,
} from "./index.js";

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height });

describe("validateRect", () => {
  it("accepts an ordinary field", () => {
    expect(validateRect(rect(0.1, 0.2, 0.3, 0.05))).toEqual({ ok: true });
  });

  it("accepts a field exactly filling the page", () => {
    expect(validateRect(rect(0, 0, 1, 1))).toEqual({ ok: true });
  });

  it("accepts a field flush against the bottom-right", () => {
    expect(validateRect(rect(0.9, 0.95, 0.1, 0.05))).toEqual({ ok: true });
  });

  it("REJECTS NaN and Infinity, and does so first", () => {
    // The case a purely comparative check would pass: every comparison against
    // NaN is false, so `x + width > 1` is false and the bounds test says fine.
    for (const bad of [
      rect(Number.NaN, 0, 0.1, 0.1),
      rect(0, Number.NaN, 0.1, 0.1),
      rect(0, 0, Number.NaN, 0.1),
      rect(0, 0, 0.1, Number.NaN),
      rect(Number.POSITIVE_INFINITY, 0, 0.1, 0.1),
      rect(0, 0, Number.POSITIVE_INFINITY, 0.1),
      rect(0, 0, 0.1, Number.NEGATIVE_INFINITY),
    ]) {
      expect(validateRect(bad)).toEqual({ ok: false, reason: "not-finite" });
    }
  });

  it("REJECTS zero and negative size", () => {
    expect(validateRect(rect(0.1, 0.1, 0, 0.1)))
      .toEqual({ ok: false, reason: "non-positive-size" });
    expect(validateRect(rect(0.1, 0.1, 0.1, 0)))
      .toEqual({ ok: false, reason: "non-positive-size" });
    expect(validateRect(rect(0.1, 0.1, -0.1, 0.1)))
      .toEqual({ ok: false, reason: "non-positive-size" });
  });

  it("REJECTS a field too small to see or click", () => {
    const tiny = MINIMUM_FIELD_EXTENT / 2;
    expect(validateRect(rect(0.1, 0.1, tiny, 0.1)))
      .toEqual({ ok: false, reason: "below-minimum-size" });
    // And accepts exactly the minimum.
    expect(validateRect(rect(0.1, 0.1, MINIMUM_FIELD_EXTENT, MINIMUM_FIELD_EXTENT)))
      .toEqual({ ok: true });
  });

  it("REJECTS negative coordinates", () => {
    expect(validateRect(rect(-0.01, 0.1, 0.1, 0.1)))
      .toEqual({ ok: false, reason: "out-of-bounds" });
    expect(validateRect(rect(0.1, -0.01, 0.1, 0.1)))
      .toEqual({ ok: false, reason: "out-of-bounds" });
  });

  it("REJECTS partial overflow, not just total", () => {
    // A field half off the page is a signature half off the page. Clipping
    // would produce a document that looks complete.
    expect(validateRect(rect(0.95, 0.1, 0.1, 0.1)))
      .toEqual({ ok: false, reason: "out-of-bounds" });
    expect(validateRect(rect(0.1, 0.98, 0.1, 0.1)))
      .toEqual({ ok: false, reason: "out-of-bounds" });
  });

  it("REJECTS a field entirely off the page", () => {
    expect(validateRect(rect(1.5, 1.5, 0.1, 0.1)))
      .toEqual({ ok: false, reason: "out-of-bounds" });
  });

  it("needs no page dimensions — the same rect is valid for A4 and Letter", () => {
    // The property that makes normalized coordinates worth having: bounds
    // checking is arithmetic on the rectangle alone.
    expect(validateRect(rect(0.25, 0.25, 0.5, 0.5))).toEqual({ ok: true });
  });
});

describe("coordinate precision", () => {
  it("rounds browser noise to six decimals", () => {
    expect(roundCoordinate(0.31415926535897931)).toBe(0.314159);
    expect(roundCoordinate(0.1234564999)).toBe(0.123456);
  });

  it("leaves an already-short value untouched", () => {
    for (const value of [0, 0.5, 1, 0.25, 0.125]) {
      expect(roundCoordinate(value)).toBe(value);
    }
  });

  it("survives a round trip without drift", () => {
    const original = rect(0.123456789, 0.987654321, 0.2500004, 0.0500006);
    const once = roundRect(original);
    // Rounding is idempotent, so persisting and re-reading cannot walk a
    // coordinate away from where the sender put it.
    expect(roundRect(once)).toEqual(once);
    expect(once).toEqual({ x: 0.123457, y: 0.987654, width: 0.25, height: 0.050001 });
  });

  it("keeps a rounded rect inside the page", () => {
    // The edge worth checking: rounding must not push a flush field over 1.
    const flush = roundRect(rect(0.9000004, 0.9500004, 0.0999996, 0.0499996));
    expect(validateRect(flush)).toEqual({ ok: true });
    expect(flush.x + flush.width).toBeLessThanOrEqual(1);
  });

  it("states its precision", () => {
    expect(COORDINATE_PRECISION).toBe(6);
  });
});

describe("page numbers are 1-based", () => {
  it("accepts the first and last page", () => {
    expect(isValidPageNumber(1, 10)).toBe(true);
    expect(isValidPageNumber(10, 10)).toBe(true);
  });

  it("REJECTS page 0", () => {
    // Not treated as page 1. A zero means the caller is on a different
    // convention, and accepting it would misplace every field.
    expect(isValidPageNumber(0, 10)).toBe(false);
  });

  it("REJECTS a page past the end", () => {
    expect(isValidPageNumber(11, 10)).toBe(false);
  });

  it("REJECTS negative and non-integer pages", () => {
    expect(isValidPageNumber(-1, 10)).toBe(false);
    expect(isValidPageNumber(1.5, 10)).toBe(false);
    expect(isValidPageNumber(Number.NaN, 10)).toBe(false);
    expect(isValidPageNumber(Number.POSITIVE_INFINITY, 10)).toBe(false);
  });

  it("accepts only page 1 in a single-page document", () => {
    expect(isValidPageNumber(1, 1)).toBe(true);
    expect(isValidPageNumber(2, 1)).toBe(false);
  });
});

describe("rotation", () => {
  it("permits placement only on a document with no rotated pages", () => {
    expect(canPlaceFields(0)).toBe(true);
  });

  it("REFUSES a document with any rotated page", () => {
    // Refused rather than misplaced. `page.getSize()` returns the unrotated
    // mediabox while the viewer renders the rotated page, so every coordinate
    // on that page would land in the wrong space with no error.
    expect(canPlaceFields(1)).toBe(false);
    expect(canPlaceFields(12)).toBe(false);
  });

  it("REFUSES when rotation is unknown", () => {
    // An artifact inspected before rotation was captured. Unknown is not
    // assumed-unrotated: assuming would silently accept the exact case this
    // exists to catch.
    expect(canPlaceFields(null)).toBe(false);
  });
});

describe("field types", () => {
  it("has nine, and every one has a render type", () => {
    expect(PREPARATION_FIELD_TYPES).toHaveLength(9);
    for (const type of PREPARATION_FIELD_TYPES) {
      expect(renderTypeFor(type)).toBeTruthy();
    }
  });

  it("maps the four semantic text fields onto text", () => {
    // Distinct in what they ask a signer for; identical in how they draw.
    for (const type of ["full-name", "email", "title", "company"] as const) {
      expect(renderTypeFor(type)).toBe("text");
    }
  });

  it("maps the directly renderable five onto themselves", () => {
    expect(renderTypeFor("signature")).toBe("signature");
    expect(renderTypeFor("initials")).toBe("initials");
    expect(renderTypeFor("checkbox")).toBe("checkbox");
    expect(renderTypeFor("text")).toBe("text");
    // The one rename: the product says `date-signed`, the sealer says `date`.
    expect(renderTypeFor("date-signed")).toBe("date");
  });

  it("renders onto only the five types the sealer knows", () => {
    const rendered = new Set(PREPARATION_FIELD_TYPES.map(renderTypeFor));
    expect([...rendered].sort())
      .toEqual(["checkbox", "date", "initials", "signature", "text"]);
  });

  it("excludes the types with no renderer", () => {
    for (const absent of [
      "radio-group", "multiline-text", "acknowledgment", "sender-text", "dropdown",
    ]) {
      expect(PREPARATION_FIELD_TYPES as readonly string[]).not.toContain(absent);
    }
  });
});

describe("requiredness", () => {
  it("forces signature and initials to be required", () => {
    // A signature field that is optional is a contradiction. The domain
    // resolves it rather than persisting a lie.
    expect(effectiveRequired("signature", false)).toBe(true);
    expect(effectiveRequired("initials", false)).toBe(true);
    expect(isInherentlyRequired("signature")).toBe(true);
  });

  it("honours the flag for every other type", () => {
    for (const type of ["text", "checkbox", "date-signed", "email"] as const) {
      expect(effectiveRequired(type, false)).toBe(false);
      expect(effectiveRequired(type, true)).toBe(true);
      expect(isInherentlyRequired(type)).toBe(false);
    }
  });
});

describe("field labels", () => {
  it("trims and accepts ordinary labels", () => {
    expect(validateFieldLabel("  Landlord signature  "))
      .toEqual({ ok: true, value: "Landlord signature" });
  });

  it("accepts an EMPTY label", () => {
    // Unlike a document title. The editor defaults labels from the field type
    // and a sender may legitimately clear one.
    expect(validateFieldLabel("")).toEqual({ ok: true, value: "" });
    expect(validateFieldLabel("   ")).toEqual({ ok: true, value: "" });
  });

  it("accepts non-Latin labels", () => {
    for (const label of ["Lagda ng Nangungupahan", "署名", "Firma del arrendador"]) {
      expect(validateFieldLabel(label)).toEqual({ ok: true, value: label });
    }
  });

  it("REJECTS control and format characters", () => {
    // A label is shown to the signer, so a bidi override can make it read as
    // something other than what is stored on the one screen where that matters.
    for (const label of [
      "Landlord\u0000signature", "Landlord\nsignature",
      "Landlord\u202esignature", "Landlord\u200bsignature",
    ]) {
      expect(validateFieldLabel(label))
        .toEqual({ ok: false, reason: "control-characters" });
    }
  });

  it("REJECTS an over-long label, counting code points", () => {
    expect(validateFieldLabel("a".repeat(PREPARATION_FIELD_LABEL_MAX_LENGTH)).ok).toBe(true);
    expect(validateFieldLabel("a".repeat(PREPARATION_FIELD_LABEL_MAX_LENGTH + 1)))
      .toEqual({ ok: false, reason: "too-long" });
    expect(validateFieldLabel("😀".repeat(PREPARATION_FIELD_LABEL_MAX_LENGTH)).ok).toBe(true);
  });
});

describe("preparation state", () => {
  it("derives from lockedAt alone", () => {
    expect(derivePreparationState(null)).toBe("editable");
    expect(derivePreparationState(Date.parse("2026-08-10T00:00:00Z"))).toBe("locked");
  });

  it("treats epoch zero as locked, not absent", () => {
    // The trap a `!lockedAt` check would fall into.
    expect(derivePreparationState(0)).toBe("locked");
    expect(isPreparationEditable(0)).toBe(false);
  });

  it("makes only an unlocked preparation editable", () => {
    expect(isPreparationEditable(null)).toBe(true);
    expect(isPreparationEditable(Date.now())).toBe(false);
  });
});
