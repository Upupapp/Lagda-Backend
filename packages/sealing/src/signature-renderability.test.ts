// One definition of "can the renderer draw this?", proven against the merger.
//
// ── The bug this guards ────────────────────────────────────────────────────
//
// The merge refuses typed signature text it cannot draw, and by then the
// signer is long gone: the merge runs in the completion pipeline, after the
// tab is closed. Before submission asked the same question, such a value was
// accepted, the completion run then failed, the request never reached
// `completed`, and neither the signer nor the sender was told.
//
// ── Why this file exists in this shape ─────────────────────────────────────
//
// The first version of the pre-flight check counted GLYPHS, and that was not
// the same question. Measured against the vendored face:
//
//   text            glyphs present?   layout()
//   ----            ---------------   -----------------------------------
//   田中 / 🎉 / محمد  no                succeeds, returning .notdef glyphs
//   क / नमस्ते         YES               throws
//
// So a coverage-only check accepted Devanagari the merge refuses, and a
// layout-only check would accept CJK that renders as blank boxes. Neither half
// is sufficient alone, which is the entire reason `signatureTextProblem` asks
// both.
//
// This file asserts the equivalence directly, against the REAL embedded face
// and the REAL merger, in both directions:
//
//   a problem reported  →  the merge refuses
//   no problem reported →  the merge accepts
//
// A fake cannot establish that, which is why the application-layer unit tests
// explicitly defer to this file.

import { describe, it, expect } from "vitest";
import type { MergeableField } from "@lagda/application";
import { NodeFieldMerger } from "./node-field-merger.js";
import { signatureTextProblem } from "./index.js";
import { buildTestPdf } from "./testing/fixtures.js";

const merger = new NodeFieldMerger();

/**
 * Whether the production merger refuses this typed signature.
 *
 * Any throw counts, deliberately. The merge has two distinct ways to refuse
 * these values — `UnrenderableTextError` for missing glyphs, and a
 * `PdfProcessingError` when the shaper fails inside `widthOfTextAtSize` — and
 * the pre-flight check must cover both. Narrowing to one error class here
 * would let the other diverge unnoticed, which is how this gap arose.
 */
async function mergeRefuses(text: string): Promise<boolean> {
  const field: MergeableField = {
    fieldId: "field-1",
    pageNumber: 1,
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
    value: {
      kind: "signature",
      representation: { kind: "typed", text, styleIndex: 0 },
    },
  };
  try {
    await merger.mergeFields({
      sourceDocument: await buildTestPdf(1),
      fields: [field],
      mergedAt: "2026-09-18T09:00:00.000Z",
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Text the renderer can draw.
 *
 * Not arbitrary: `Peñaflor` and `₱` are the two cases the embedded face was
 * adopted for (OD-163, and a Philippine product needing both a name and a peso
 * amount — the `latin` and `latin-ext` subsets are disjoint and neither
 * carries both).
 */
const RENDERABLE = [
  "Maria Santos",
  "Peñaflor Ángeles",
  "₱1,250.00",
  "O'Brien-Smith",
  "Ævar Þórðarson",
  "Мария Иванова",
];

/** Text it cannot, by either failure mode. */
const UNRENDERABLE = [
  // Missing glyphs.
  "田中太郎",
  "Мария 田中",
  "Maria 🎉",
  "محمد",
  // Every glyph present; the shaper throws. See the header.
  "क",
  "नमस्ते",
  "क Maria",
];

describe("the pre-flight check and the merger agree", () => {
  it.each(RENDERABLE)("both accept %s", async text => {
    expect(signatureTextProblem(text)).toBeNull();
    expect(await mergeRefuses(text)).toBe(false);
  });

  it.each(UNRENDERABLE)("both refuse %s", async text => {
    expect(signatureTextProblem(text)).not.toBeNull();
    expect(await mergeRefuses(text)).toBe(true);
  });

  it("agrees on mixed text where only part is unrenderable", async () => {
    // The realistic shape of the failure: a Latin name with one pasted
    // character. A check that sampled the first code point would pass this and
    // let the merge fail later.
    const text = "Maria Santos 田";

    expect(signatureTextProblem(text)).toEqual({
      reason: "missing-glyphs",
      codePoints: ["田".codePointAt(0)],
    });
    expect(await mergeRefuses(text)).toBe(true);
  });
});

// ── The distinction that made coverage insufficient ──────────────────────────

describe("glyph coverage is not renderability", () => {
  /**
   * Devanagari has FULL glyph coverage and still cannot be rendered.
   *
   * The throw comes from `widthOfTextAtSize` — which is `font.layout(text)`
   * plus a sum of advance widths — not from the coverage guard. The face
   * declares Indic shaping features, so fontkit routes the text to its Indic
   * shaper, which is Babel-transpiled with generators and references a
   * `regeneratorRuntime` that `@pdf-lib/fontkit` never bundles.
   *
   * It is an upstream packaging bug, not a font defect. Until it is fixed the
   * merge genuinely cannot draw these scripts, and submission must say so.
   *
   * This is the regression that keeps the discrepancy from returning silently:
   * it pins BOTH that the glyphs are present AND that the value is refused. A
   * change that fixed the upstream bug would fail this, which is exactly the
   * moment to revisit it.
   */
  const COVERED_BUT_UNRENDERABLE = ["क", "नमस्ते"];

  it.each(COVERED_BUT_UNRENDERABLE)(
    "%s has every glyph, is refused by the merge, and is caught up front",
    async text => {
      // Not a missing glyph — the shaper is what fails.
      expect(signatureTextProblem(text)).toEqual({ reason: "shaping-failed" });
      expect(await mergeRefuses(text)).toBe(true);
    });

  it("tracks fontkit even where its behaviour is surprising", async () => {
    // Measured, and genuinely unobvious: whether the Indic shaper runs depends
    // on the LEADING script of the run.
    //
    //   "क Maria"        shaper runs   → throws   → merge refuses
    //   "Maria क"        shaper skipped → no throw → merge SUCCEEDS
    //   "Maria नमस्ते"     shaper skipped → no throw → merge SUCCEEDS
    //
    // This is the case that vindicates probing over classifying. Any rule
    // written from character ranges — "reject text containing Devanagari" —
    // would refuse two values the merger renders perfectly well, blocking
    // signers for no reason. The probe calls the same function the merge
    // calls, so it inherits the real behaviour including its quirks.
    //
    // (Whether "Maria नमस्ते" renders with CORRECT conjuncts is a separate
    // question about shaping quality. Both sides agree it renders, which is
    // all this equivalence claims.)
    expect(signatureTextProblem("क Maria")).toEqual({ reason: "shaping-failed" });
    expect(await mergeRefuses("क Maria")).toBe(true);

    expect(signatureTextProblem("Maria क")).toBeNull();
    expect(await mergeRefuses("Maria क")).toBe(false);

    expect(signatureTextProblem("Maria नमस्ते")).toBeNull();
    expect(await mergeRefuses("Maria नमस्ते")).toBe(false);
  });

  it("still distinguishes a missing glyph from a shaping failure", () => {
    // The two reasons must stay distinguishable. Collapsing them to a boolean
    // would lose the only diagnostic available for the first case, and would
    // hide a shaper regression behind an apparent font problem.
    expect(signatureTextProblem("田中")?.reason).toBe("missing-glyphs");
    expect(signatureTextProblem("क")?.reason).toBe("shaping-failed");
  });
});

describe("what the check reports", () => {
  it("names each missing code point once, in first-seen order", () => {
    expect(signatureTextProblem("田中田")).toEqual({
      reason: "missing-glyphs",
      codePoints: ["田".codePointAt(0), "中".codePointAt(0)],
    });
  });

  it("reads an astral character as ONE code point, not two surrogates", () => {
    // An emoji is exactly what gets pasted into a name field. Reported as a
    // surrogate pair it would be two bogus code points, and neither would mean
    // anything to a signer trying to fix their input.
    expect(signatureTextProblem("🎉")).toEqual({
      reason: "missing-glyphs",
      codePoints: [0x1f389],
    });
  });

  it("ignores control characters rather than failing over them", async () => {
    // A stray carriage return has no glyph by definition. Reporting it would
    // refuse a submission over invisible whitespace.
    expect(signatureTextProblem("Maria\r\nSantos")).toBeNull();
    expect(await mergeRefuses("Maria\r\nSantos")).toBe(false);
  });

  it("returns null for empty text", () => {
    // Emptiness is rejected earlier, by the use case. This probe has no
    // opinion about it and must not invent one.
    expect(signatureTextProblem("")).toBeNull();
  });

  it("never throws, including on the input that throws inside the shaper", () => {
    // The Devanagari path throws a ReferenceError deep in fontkit. If that
    // escaped, a submission would 500 instead of returning a problem the
    // signer can act on.
    expect(() => signatureTextProblem("नमस्ते 田中 🎉")).not.toThrow();
  });
});

// ── No side effects ──────────────────────────────────────────────────────────

describe("the probe is inert", () => {
  it("produces no document and mutates nothing it is given", () => {
    // It shapes text in memory against an already-parsed face: no
    // `PDFDocument`, no embed, no bytes out. Asserted by the shape of what it
    // returns — a verdict, never a document — and by its repeatability below.
    const first = signatureTextProblem("田中");
    const second = signatureTextProblem("田中");

    expect(first).toEqual(second);
    expect(first).not.toHaveProperty("bytes");
  });

  it("is repeatable for renderable text too, so nothing is consumed", () => {
    // A probe that embedded or subset the face could behave differently the
    // second time. This one must not.
    expect(signatureTextProblem("Maria Santos")).toBeNull();
    expect(signatureTextProblem("Maria Santos")).toBeNull();
  });
});
