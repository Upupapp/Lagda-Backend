// Outcome over name (081): "REVIEWED 2026-09-26 (UTC)" above a rule, the
// recipient's name centred beneath it in the formal serif.

import { describe, it, expect } from "vitest";
import { PDFContentStream, PDFDocument } from "pdf-lib";
import type { MergeableField } from "@lagda/application";
import { NodeFieldMerger } from "./node-field-merger.js";
import { mergeFields } from "./internal/merge.js";
import { toPdfRect } from "./internal/geometry.js";
import { buildTestPdf } from "./testing/fixtures.js";
import { UnrenderableTextError, UnsupportedRepresentationError } from "./errors/index.js";

const merger = new NodeFieldMerger();
const PAGE = { width: 612, height: 792 };
const RECT = { x: 0.1, y: 0.1, width: 0.35, height: 0.1 };

function block(
  name: string,
  label = "REVIEWED 2026-09-26 (UTC)",
  rect = RECT,
): MergeableField {
  return { fieldId: "block-1", pageNumber: 1, rect, value: { kind: "outcomeBlock", label, name } };
}

async function merge(fields: readonly MergeableField[]) {
  return merger.mergeFields({
    sourceDocument: await buildTestPdf(1), fields, mergedAt: "2026-09-26T00:00:00.000Z",
  });
}

const fontNames = async (bytes: Uint8Array) => {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects()
    .map(([, obj]) => String(obj))
    .filter(s => s.includes("/BaseFont"))
    .join("\n");
};

interface Drawn {
  /** Each text run: its origin and size. */
  readonly texts: readonly { x: number; y: number; size: number }[];
  /** Each stroked line: its two ends. */
  readonly lines: readonly { x1: number; y1: number; x2: number; y2: number }[];
}

/**
 * What the merge actually drew, read from the page's content stream BEFORE it
 * is compressed: every text origin and size, and every line.
 */
async function drawnOperators(field: MergeableField): Promise<Drawn> {
  const pdf = await PDFDocument.create();
  pdf.addPage([PAGE.width, PAGE.height]);
  await mergeFields(pdf, [field]);
  const content = pdf.context.enumerateIndirectObjects()
    .map(([, obj]) => obj)
    .filter((obj): obj is PDFContentStream => obj instanceof PDFContentStream)
    .map(stream => new TextDecoder().decode(stream.getUnencodedContents()))
    .join("\n");

  const num = String.raw`(-?[\d.]+)`;
  const sizes = [...content.matchAll(new RegExp(String.raw`/\S+ ${num} Tf`, "g"))]
    .map(match => Number(match[1]));
  const origins = [...content.matchAll(
    new RegExp(String.raw`1 0 0 1 ${num} ${num} Tm`, "g"))]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
  const lines = [...content.matchAll(
    new RegExp(String.raw`${num} ${num} m\s+${num} ${num} l`, "g"))]
    .map(match => ({
      x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]),
    }));
  expect(sizes).toHaveLength(origins.length);
  return { texts: origins.map((origin, index) => ({ ...origin, size: sizes[index] ?? 0 })), lines };
}

function assertInside(drawn: Drawn, rect = RECT): void {
  const box = toPdfRect(rect, PAGE.width, PAGE.height);
  for (const text of drawn.texts) {
    expect(text.x).toBeGreaterThanOrEqual(box.x);
    expect(text.x).toBeLessThan(box.x + box.width);
    expect(text.y).toBeGreaterThanOrEqual(box.y);
    expect(text.y + text.size).toBeLessThanOrEqual(box.y + box.height + 1e-6);
  }
  for (const line of drawn.lines) {
    for (const x of [line.x1, line.x2]) {
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.width);
    }
    for (const y of [line.y1, line.y2]) {
      expect(y).toBeGreaterThan(box.y);
      expect(y).toBeLessThan(box.y + box.height);
    }
  }
}

describe("outcome block", () => {
  it("draws the label above one rule and the name beneath it, inside the box", async () => {
    const drawn = await drawnOperators(block("Maria Santos"));
    expect(drawn.texts).toHaveLength(2);
    expect(drawn.lines).toHaveLength(1);
    assertInside(drawn);

    const [label, name] = drawn.texts;
    const rule = drawn.lines[0]!;
    expect(rule.y1).toBe(rule.y2);
    expect(label!.y).toBeGreaterThan(rule.y1);
    expect(name!.y + name!.size).toBeLessThan(rule.y1);
    // The name at the size a signature block prints it; the label capped.
    expect(name!.size).toBe(11);
    expect(label!.size).toBeLessThanOrEqual(11);
  });

  it("shrinks a long name and label to a narrow box rather than overflowing it", async () => {
    const narrow = { x: 0.1, y: 0.1, width: 0.18, height: 0.06 };
    const drawn = await drawnOperators(block(
      "Maria Clara Fernanda de los Santos y Villanueva-Reyes III",
      "APPROVED 2026-09-26 (UTC)", narrow));
    expect(drawn.texts).toHaveLength(2);
    assertInside(drawn, narrow);
    expect(drawn.texts[1]!.size).toBeLessThan(11);
  });

  it("sets the name in the formal serif (Tinos)", async () => {
    const result = await merge([block("Maria Santos")]);
    expect(result.renderedFieldCount).toBe(1);
    expect(await fontNames(result.mergedDocument)).toMatch(/Tinos/);
  });

  it("prints the outcome it is given, so APPROVED and SKIPPED differ", async () => {
    const a = await merge([block("Maria Santos", "APPROVED 2026-09-26 (UTC)")]);
    const b = await merge([block("Maria Santos", "SKIPPED 2026-09-26 (UTC)")]);
    expect(a.mergedDocumentHash).not.toBe(b.mergedDocumentHash);
  });

  it("is deterministic", async () => {
    const a = await merge([block("Ángeles Cruz")]);
    const b = await merge([block("Ángeles Cruz")]);
    expect(a.mergedDocumentHash).toBe(b.mergedDocumentHash);
  });

  it("refuses a name the serif face cannot draw, rather than printing a blank", async () => {
    await expect(merge([block("田中太郎")])).rejects.toBeInstanceOf(UnrenderableTextError);
  });

  it("refuses a block with no name, or no outcome", async () => {
    await expect(merge([block("   ")])).rejects.toBeInstanceOf(UnsupportedRepresentationError);
    await expect(merge([block("Maria Santos", " ")]))
      .rejects.toBeInstanceOf(UnsupportedRepresentationError);
  });
});
