// Signature over name: the mark, a rule, and the signer's printed name.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { MergeableField } from "@lagda/application";
import { NodeFieldMerger } from "./node-field-merger.js";
import { buildTestPdf, buildTestSignaturePng } from "./testing/fixtures.js";
import { UnrenderableTextError, UnsupportedRepresentationError } from "./errors/index.js";

const merger = new NodeFieldMerger();
const RECT = { x: 0.1, y: 0.1, width: 0.35, height: 0.1 };

function block(name: string, typed = true): MergeableField {
  return {
    fieldId: "block-1",
    pageNumber: 1,
    rect: RECT,
    value: {
      kind: "signatureBlock",
      name,
      representation: typed
        ? { kind: "typed", text: "Maria Santos", styleIndex: 0 }
        : { kind: "raster", bytes: buildTestSignaturePng(16, 6), mediaType: "image/png", width: 16, height: 6 },
    },
  };
}

async function merge(fields: readonly MergeableField[]) {
  return merger.mergeFields({ sourceDocument: await buildTestPdf(1), fields, mergedAt: "2026-09-26T00:00:00.000Z" });
}

const fontNames = async (bytes: Uint8Array) => {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects()
    .map(([, obj]) => String(obj))
    .filter(s => s.includes("/BaseFont"))
    .join("\n");
};

describe("signature block", () => {
  it("renders a typed mark with the name set in the formal serif (Tinos)", async () => {
    const result = await merge([block("Maria Santos")]);
    expect(result.renderedFieldCount).toBe(1);
    expect(await fontNames(result.mergedDocument)).toMatch(/Tinos/);
  });

  it("renders a drawn mark with the name", async () => {
    const result = await merge([block("Maria Santos", false)]);
    expect(result.renderedFieldCount).toBe(1);
    expect(await fontNames(result.mergedDocument)).toMatch(/Tinos/);
  });

  it("draws more than a plain signature does — the rule and the name", async () => {
    const plain = await merge([{
      ...block("Maria Santos"),
      value: { kind: "signature", representation: { kind: "typed", text: "Maria Santos", styleIndex: 0 } },
    }]);
    const withName = await merge([block("Maria Santos")]);
    expect(withName.mergedDocumentHash).not.toBe(plain.mergedDocumentHash);
  });

  it("prints the name it is given, so two names differ", async () => {
    const a = await merge([block("Maria Santos")]);
    const b = await merge([block("Jose Peñaflor")]);
    expect(a.mergedDocumentHash).not.toBe(b.mergedDocumentHash);
  });

  it("is deterministic", async () => {
    const a = await merge([block("Ángeles Cruz")]);
    const b = await merge([block("Ángeles Cruz")]);
    expect(a.mergedDocumentHash).toBe(b.mergedDocumentHash);
  });

  it("still fits a very long name", async () => {
    const result = await merge([block("Maria Clara Fernanda de los Santos y Villanueva-Reyes III")]);
    expect(result.renderedFieldCount).toBe(1);
  });

  it("refuses a name the serif face cannot draw, rather than printing a blank", async () => {
    await expect(merge([block("田中太郎")])).rejects.toBeInstanceOf(UnrenderableTextError);
  });

  it("refuses a block with no name", async () => {
    await expect(merge([block("   ")])).rejects.toBeInstanceOf(UnsupportedRepresentationError);
  });
});
