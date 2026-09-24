// The flowing-document layout engine, tested with a FAKE measurer.
//
// No font file, no pdf-lib — `measure` is a trivial character-count function
// here, which is enough to prove the actual decisions this module makes:
// where a line breaks, where a page breaks, how a numbered clause labels
// itself, and where a field anchor ends up. Real font metrics and real PDF
// bytes are proven in `node-flow-document-generator.test.ts`, one layer up
// — the same split `field-merge.test.ts` makes for `FieldMerger`.

import { describe, it, expect } from "vitest";
import { layoutFlowDocument, collectFlowDocumentStyles, PAGE_HEIGHT, type MeasureFn } from "./flow-layout.js";
import { LayoutOverflowError } from "../errors/index.js";
import type { FlowDocument } from "@lagda/contracts";

/** 6pt per character at size 11, scaled linearly with size — deterministic,
 *  and wide enough that a handful of words overflows a page's content
 *  width, without needing real glyph metrics. */
const fakeMeasure: MeasureFn = (text, style) => text.length * (style.size / 11) * 6;

const doc = (content: FlowDocument["content"]): FlowDocument => ({ kind: "flowDocument", content });
const para = (text: string, marks?: readonly { kind: string }[]): FlowDocument["content"][number] =>
  ({ kind: "paragraph", content: [{ kind: "text", text, marks: marks as never }] });

describe("pagination", () => {
  it("a short document is exactly one page", () => {
    const result = layoutFlowDocument(doc([para("Hello.")]), fakeMeasure);
    expect(result.pageCount).toBe(1);
    expect(result.drawOps.every(op => op.page === 0)).toBe(true);
  });

  it("an explicit page break starts a new page even with room left on the current one", () => {
    const result = layoutFlowDocument(
      doc([para("First page."), { kind: "pageBreak" }, para("Second page.")]),
      fakeMeasure,
    );
    expect(result.pageCount).toBe(2);
    expect(result.drawOps.find(op => op.text === "page.")).toBeDefined();
    const firstWord = result.drawOps.find(op => op.text === "First");
    const secondWord = result.drawOps.find(op => op.text === "Second");
    expect(firstWord?.page).toBe(0);
    expect(secondWord?.page).toBe(1);
  });

  it("enough content overflows onto a second page without an explicit break", () => {
    // 60 short paragraphs, each with its own line height and spacing, is
    // comfortably more than one A4 page holds at any reasonable font size.
    const paragraphs = Array.from({ length: 60 }, (_, i) => para(`Paragraph number ${String(i)}.`));
    const result = layoutFlowDocument(doc(paragraphs), fakeMeasure);
    expect(result.pageCount).toBeGreaterThan(1);
  });

  it("a document with a trailing page break does not lose the pages before it", () => {
    const result = layoutFlowDocument(
      doc([para("Only content."), { kind: "pageBreak" }]),
      fakeMeasure,
    );
    // The break opens a second, otherwise-empty page — the same "press
    // Enter past the last line" behaviour any editor allows.
    expect(result.pageCount).toBe(2);
  });

  it("refuses a document laid out beyond the page cap", () => {
    const manyBreaks = Array.from({ length: 250 }, () => ({ kind: "pageBreak" as const }));
    expect(() => layoutFlowDocument(doc(manyBreaks), fakeMeasure)).toThrow(LayoutOverflowError);
  });
});

describe("line-wrapping", () => {
  it("wraps a long paragraph onto multiple lines within the content width", () => {
    const longText = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(" ");
    const result = layoutFlowDocument(doc([para(longText)]), fakeMeasure);
    // Every op landed on page 0 (short enough not to paginate), but at
    // strictly increasing y is what proves more than one LINE was used —
    // pdf-lib's y is bottom-up, so an earlier line has a LARGER y.
    const ys = [...new Set(result.drawOps.map(op => op.y))];
    expect(ys.length).toBeGreaterThan(1);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
  });

  it("never breaks a field anchor's bracketed label across a line", () => {
    const longLabel = "A Very Long Signature Label That Would Otherwise Need To Wrap";
    const result = layoutFlowDocument(
      doc([{
        kind: "paragraph",
        content: [{ kind: "fieldAnchor", fieldType: "signature", slotId: "s1", required: true, label: longLabel }],
      }]),
      fakeMeasure,
    );
    const anchorOp = result.drawOps.find(op => op.placeholder);
    expect(anchorOp?.text).toBe(`[${longLabel}]`);
  });
});

describe("numbered clauses", () => {
  // Untyped on purpose: a real `listItem` node's content type differs by
  // nesting depth (three unrolled levels — see the contract's own comment on
  // why it is not `Type.Recursive`), which makes a single small test helper
  // impossible to type precisely without reproducing that unrolling here.
  // `layoutFlowDocument` validates nothing itself (the route's schema check
  // already ran by the time content reaches it) — only shape at runtime
  // matters for this test.
  const listItem = (text: string, nested?: unknown): unknown =>
    ({ kind: "listItem", content: nested ? [para(text), { kind: "orderedList", content: nested }] : [para(text)] });

  it("labels top-level items 1., 2., 3.", () => {
    const result = layoutFlowDocument(
      doc([{
        kind: "orderedList",
        content: [listItem("First"), listItem("Second"), listItem("Third")],
      } as never]),
      fakeMeasure,
    );
    const labels = result.drawOps.filter(op => /^\d+\.\s*$/.test(op.text)).map(op => op.text.trim());
    expect(labels).toEqual(["1.", "2.", "3."]);
  });

  it("labels a nested clause 1.1., not a fresh 1.", () => {
    const result = layoutFlowDocument(
      doc([{
        kind: "orderedList",
        content: [
          listItem("Top", [{ kind: "listItem", content: [para("Nested")] }]),
        ],
      } as never]),
      fakeMeasure,
    );
    const labels = result.drawOps.filter(op => /^[\d.]+\.\s*$/.test(op.text)).map(op => op.text.trim());
    expect(labels).toContain("1.");
    expect(labels).toContain("1.1.");
  });

  it("a second top-level item after a nested one resumes at 2., not 1.1.1", () => {
    const result = layoutFlowDocument(
      doc([{
        kind: "orderedList",
        content: [
          listItem("Top with a child", [{ kind: "listItem", content: [para("Child")] }]),
          listItem("Second top-level item"),
        ],
      } as never]),
      fakeMeasure,
    );
    const labels = result.drawOps.filter(op => /^[\d.]+\.\s*$/.test(op.text)).map(op => op.text.trim());
    expect(labels).toEqual(["1.", "1.1.", "2."]);
  });
});

describe("field anchors", () => {
  it("resolves a signature anchor to a normalized, on-page rectangle", () => {
    const result = layoutFlowDocument(
      doc([{
        kind: "paragraph",
        content: [
          { kind: "text", text: "Signed: " },
          { kind: "fieldAnchor", fieldType: "signature", slotId: "slot_employer", required: true, label: "Employer" },
        ],
      }]),
      fakeMeasure,
    );
    expect(result.resolvedAnchors).toHaveLength(1);
    const anchor = result.resolvedAnchors[0]!;
    expect(anchor.pageNumber).toBe(1);
    expect(anchor.anchor.slotId).toBe("slot_employer");
    expect(anchor.rect.x).toBeGreaterThanOrEqual(0);
    expect(anchor.rect.x + anchor.rect.width).toBeLessThanOrEqual(1.01);
    expect(anchor.rect.y).toBeGreaterThanOrEqual(0);
    expect(anchor.rect.y + anchor.rect.height).toBeLessThanOrEqual(1.01);
  });

  it("resolved anchors are returned in document order, regardless of nesting", () => {
    const result = layoutFlowDocument(
      doc([
        { kind: "paragraph", content: [{ kind: "fieldAnchor", fieldType: "initials", slotId: "s1", required: true, label: "First" }] },
        {
          kind: "orderedList",
          content: [{
            kind: "listItem",
            content: [{ kind: "paragraph", content: [{ kind: "fieldAnchor", fieldType: "initials", slotId: "s2", required: true, label: "Second" }] }],
          }],
        },
        { kind: "paragraph", content: [{ kind: "fieldAnchor", fieldType: "initials", slotId: "s3", required: true, label: "Third" }] },
      ]),
      fakeMeasure,
    );
    expect(result.resolvedAnchors.map(a => a.anchor.slotId)).toEqual(["s1", "s2", "s3"]);
  });

  it("an anchor after a page break resolves to the new page", () => {
    const result = layoutFlowDocument(
      doc([
        para("Page one."),
        { kind: "pageBreak" },
        { kind: "paragraph", content: [{ kind: "fieldAnchor", fieldType: "signature", slotId: "s1", required: true, label: "Sig" }] },
      ]),
      fakeMeasure,
    );
    expect(result.resolvedAnchors[0]?.pageNumber).toBe(2);
  });

  it("a variable reference produces no resolved anchor — it is not a field", () => {
    const result = layoutFlowDocument(
      doc([{ kind: "paragraph", content: [{ kind: "variable", key: "employee_name", label: "Employee Name" }] }]),
      fakeMeasure,
    );
    expect(result.resolvedAnchors).toEqual([]);
  });
});

describe("collectFlowDocumentStyles", () => {
  it("always includes the default body style, even for an empty document", () => {
    const styles = collectFlowDocumentStyles(doc([]));
    expect(styles.some(s => s.family === "times" && !s.bold && !s.italic)).toBe(true);
  });

  it("always includes the italic default — the variable-placeholder style", () => {
    const styles = collectFlowDocumentStyles(doc([]));
    expect(styles.some(s => s.family === "times" && !s.bold && s.italic)).toBe(true);
  });

  it("finds a bold mark on an inline run inside a nested list item", () => {
    const styles = collectFlowDocumentStyles(doc([{
      kind: "orderedList",
      content: [{
        kind: "listItem",
        content: [{
          kind: "paragraph",
          content: [{ kind: "text", text: "x", marks: [{ kind: "bold" }, { kind: "fontFamily", family: "calibri" }] }],
        }],
      }],
    }]));
    expect(styles.some(s => s.family === "calibri" && s.bold)).toBe(true);
  });

  it("a heading is always bold, even with no explicit bold mark", () => {
    const styles = collectFlowDocumentStyles(doc([
      { kind: "heading", level: 1, content: [{ kind: "text", text: "Title" }] },
    ]));
    expect(styles.some(s => s.bold)).toBe(true);
  });
});

describe("alignment", () => {
  it("right-aligns a short line near the page's right margin", () => {
    const result = layoutFlowDocument(doc([{ kind: "paragraph", align: "right", content: [{ kind: "text", text: "Right." }] }]), fakeMeasure);
    const op = result.drawOps[0]!;
    // Well past the horizontal midpoint of the page — a loose but meaningful
    // bound that does not depend on exact font metrics.
    expect(op.x).toBeGreaterThan(300);
  });

  it("centers a short line", () => {
    const result = layoutFlowDocument(doc([{ kind: "paragraph", align: "center", content: [{ kind: "text", text: "Mid." }] }]), fakeMeasure);
    const op = result.drawOps[0]!;
    expect(op.x).toBeGreaterThan(72);
    expect(op.x).toBeLessThan(500);
  });

  it("left-aligns by default, starting at the margin", () => {
    const result = layoutFlowDocument(doc([para("Left.")]), fakeMeasure);
    expect(result.drawOps[0]?.x).toBe(72);
  });
});

describe("coordinate convention", () => {
  it("the first line of the first page sits near the TOP of the page, in pdf-lib's bottom-up y", () => {
    const result = layoutFlowDocument(doc([para("Top of page.")]), fakeMeasure);
    const y = result.drawOps[0]!.y;
    // Close to PAGE_HEIGHT (bottom-up y is large near the top), not close to 0.
    expect(y).toBeGreaterThan(PAGE_HEIGHT - 100);
  });
});
