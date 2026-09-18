// One definition of "can the renderer draw this?", proven.
//
// ── The bug this guards ────────────────────────────────────────────────────
//
// The merge refuses typed signature text the embedded face has no glyphs for,
// and that refusal is TERMINAL — `unrenderable_text` maps to
// `unrenderable-value`, which the completion pipeline classes terminal because
// retrying identical text fails identically.
//
// Correct at merge time, and far too late. The merge runs in the completion
// pipeline, after the signer has closed the tab: they were told they had
// signed, the completion run then failed permanently, the request never
// reached `completed`, and the sender was never notified.
//
// `uncoveredSignatureCodePoints` exists so submission can ask the same
// question while the signer is still present. "The same question" is the whole
// value of it, and it is not self-evident — a pre-flight check that consulted
// a different face, or a charset written out by hand, would agree on the day
// it shipped and drift the first time a face changed. Nothing would fail;
// submission would simply start accepting text the merge still refuses, which
// is the original bug restored by its own fix.
//
// So this file asserts the equivalence directly, against the REAL embedded
// face and the REAL merger, in both directions:
//
//   uncovered code points  →  the merge refuses
//   no uncovered points    →  the merge accepts
//
// A fake cannot establish this, which is why the application-layer unit tests
// explicitly defer to this file.

import { describe, it, expect } from "vitest";
import type { MergeableField } from "@lagda/application";
import { NodeFieldMerger } from "./node-field-merger.js";
import { uncoveredSignatureCodePoints } from "./index.js";
import { buildTestPdf } from "./testing/fixtures.js";
import { UnrenderableTextError } from "./errors/index.js";

const merger = new NodeFieldMerger();

/** Attempts a typed signature merge and reports only whether it was refused. */
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
  } catch (error) {
    // Only a COVERAGE refusal counts. Any other sealing failure would make
    // this test agree with the pre-flight check for the wrong reason.
    if (error instanceof UnrenderableTextError) return true;
    throw error;
  }
}

/**
 * Text the face is expected to draw, and text it is not.
 *
 * The renderable set is not arbitrary: `Peñaflor` and `₱` are the two cases
 * the embedded face was adopted for (OD-163, and a Philippine product that
 * needs both a name and a peso amount — the `latin` and `latin-ext` subsets
 * are disjoint and neither carries both).
 */
const RENDERABLE = [
  "Maria Santos",
  "Peñaflor Ángeles",
  "₱1,250.00",
  "O'Brien-Smith",
  "Ævar Þórðarson",
  // Cyrillic IS covered by the full face. Measured, not assumed.
  "Мария Иванова",
];

const UNRENDERABLE = [
  "田中太郎",
  "Мария 田中",
  "Maria 🎉",
  "محمد",
];

describe("the pre-flight check and the merger agree", () => {
  it.each(RENDERABLE)("both accept %s", async text => {
    expect(uncoveredSignatureCodePoints(text)).toEqual([]);
    expect(await mergeRefuses(text)).toBe(false);
  });

  it.each(UNRENDERABLE)("both refuse %s", async text => {
    expect(uncoveredSignatureCodePoints(text).length).toBeGreaterThan(0);
    expect(await mergeRefuses(text)).toBe(true);
  });

  it("agrees on mixed text where only part is uncovered", async () => {
    // The realistic shape of the failure: a Latin name with one pasted
    // character. A check that sampled the first code point would pass this and
    // let the merge fail later.
    const text = "Maria Santos 田";

    expect(uncoveredSignatureCodePoints(text)).toEqual(["田".codePointAt(0)]);
    expect(await mergeRefuses(text)).toBe(true);
  });
});

// ── A divergence this check does NOT close ───────────────────────────────────

describe("KNOWN GAP: coverage is not the same question as renderability", () => {
  /**
   * Devanagari has full glyph coverage and still cannot be merged.
   *
   * Measured, for a single character with nothing to shape:
   *
   *   uncoveredSignatureCodePoints("क")  →  []          (every glyph present)
   *   merge("क")                         →  PdfProcessingError
   *                                          code=pdf_processing_failed
   *                                          retryable=TRUE
   *
   * The throw comes from `widthOfTextAtSize` inside `fitFontSize`, not from
   * the coverage guard — so the pre-flight check cannot see it, because the
   * pre-flight check asks about glyphs and this is a failure to MEASURE them.
   *
   * ── Why this is pinned rather than quietly tolerated ───────────────────
   *
   * `pdf_processing_failed` is absent from `failureCodeForSealingError`'s
   * switch, so it falls to the default and its `retryable: true` makes it
   * `sealer-unavailable` — RETRYABLE. A signer with such a name therefore
   * submits successfully, the completion run retries the full attempt budget
   * while reporting what looks like a transient sealer outage, and the request
   * then dies exhausted. It never completes and no completion notification is
   * ever produced.
   *
   * That is a worse outcome than the CJK case the coverage check closes, and
   * it is PRE-EXISTING — this file did not introduce it, it discovered it.
   * Closing it needs a pre-flight that measures rather than one that counts
   * glyphs, which changes the port's shape and is therefore a separate,
   * approved piece of work.
   *
   * This test asserts the CURRENT behaviour deliberately. It will fail the day
   * someone closes the gap, which is the correct moment to revisit it.
   */
  const COVERED_BUT_UNRENDERABLE = ["क", "नमस्ते"];

  it.each(COVERED_BUT_UNRENDERABLE)(
    "%s has every glyph, and the merge still refuses it", async text => {
      expect(uncoveredSignatureCodePoints(text)).toEqual([]);
      // NOT an UnrenderableTextError — `mergeRefuses` rethrows anything else,
      // so this asserts the failure is the processing one described above.
      await expect(mergeRefuses(text)).rejects.toThrow();
    });
});

describe("what the check reports", () => {
  it("reports each missing code point once, in first-seen order", () => {
    expect(uncoveredSignatureCodePoints("田中田")).toEqual([
      "田".codePointAt(0), "中".codePointAt(0),
    ]);
  });

  it("reads an astral character as ONE code point, not two surrogates", () => {
    // An emoji is exactly what gets pasted into a name field. Reported as a
    // surrogate pair it would be two bogus code points, and neither would mean
    // anything to a signer trying to fix their input.
    const missing = uncoveredSignatureCodePoints("🎉");

    expect(missing).toHaveLength(1);
    expect(missing[0]).toBe(0x1f389);
  });

  it("ignores control characters rather than failing over them", async () => {
    // A stray carriage return has no glyph by definition. Reporting it would
    // refuse a submission over invisible whitespace.
    expect(uncoveredSignatureCodePoints("Maria\r\nSantos")).toEqual([]);
    expect(await mergeRefuses("Maria\r\nSantos")).toBe(false);
  });

  it("returns empty for empty text", () => {
    expect(uncoveredSignatureCodePoints("")).toEqual([]);
  });
});
