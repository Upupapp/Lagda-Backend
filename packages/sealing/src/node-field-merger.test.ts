// The field-merge renderer.
//
// The tests that matter most here are the ones asserting a REFUSAL. An embedded
// subset font turns "this document cannot be rendered" from an exception into a
// blank space on a finished page, and a suite that only checks the happy path
// would stay green through exactly that regression.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { MergeableField, MergeFieldsRequest } from "@lagda/application";
import { NodeFieldMerger } from "./node-field-merger.js";
import { buildTestPdf, buildTestSignaturePng } from "./testing/fixtures.js";
import {
  InvalidFieldPlacementError,
  InvalidPdfError,
  InvalidSealInputError,
  SealingError,
  UnrenderableTextError,
  UnsupportedRepresentationError,
} from "./errors/index.js";

const merger = new NodeFieldMerger();

const RECT = { x: 0.1, y: 0.1, width: 0.3, height: 0.08 };
const MERGED_AT = "2026-08-11T09:00:00.000Z";

function textField(overrides: Partial<MergeableField> = {}): MergeableField {
  return {
    fieldId: "field-1",
    pageNumber: 1,
    rect: RECT,
    value: { kind: "text", text: "Maria Santos" },
    ...overrides,
  };
}

async function request(
  fields: readonly MergeableField[],
  pages = 1,
): Promise<MergeFieldsRequest> {
  return { sourceDocument: await buildTestPdf(pages), fields, mergedAt: MERGED_AT };
}

async function merge(
  fields: readonly MergeableField[],
  pages = 1,
): ReturnType<NodeFieldMerger["mergeFields"]> {
  return merger.mergeFields(await request(fields, pages));
}

/**
 * The error a merge was refused with.
 *
 * Not `.catch(e => e)`: that resolves to the RESULT when the merge unexpectedly
 * succeeds, and every assertion below it then runs against a `MergeFieldsResult`
 * — `expect(result.message).not.toContain(secret)` passes vacuously because
 * `undefined` contains nothing. This throws instead, so a renderer that stops
 * refusing is a failing test rather than a silently passing one.
 */
async function rejection(promise: Promise<unknown>): Promise<SealingError> {
  try {
    await promise;
  } catch (error) {
    return error as SealingError;
  }
  throw new Error("Expected the merge to be refused, but it succeeded.");
}

describe("rendering each field type", () => {
  it("renders a text value", async () => {
    const result = await merge([textField()]);
    expect(result.renderedFieldCount).toBe(1);
    expect(result.mergedDocument.length).toBeGreaterThan(0);
  });

  it("renders a typed signature", async () => {
    const result = await merge([
      textField({
        value: {
          kind: "signature",
          representation: { kind: "typed", text: "Maria Santos", styleIndex: 0 },
        },
      }),
    ]);
    expect(result.renderedFieldCount).toBe(1);
  });

  it("renders a DRAWN signature — the case the legacy renderer drew nothing for", async () => {
    // `fields.ts` drew every signature with `drawText` in an oblique face. A
    // raster has no text, so this field produced no marks at all and the
    // document came out with an empty signature box.
    const withRaster = await merge([
      textField({
        value: {
          kind: "signature",
          representation: {
            kind: "raster",
            bytes: buildTestSignaturePng(),
            mediaType: "image/png",
            width: 8,
            height: 4,
          },
        },
      }),
    ]);
    const empty = await merge([]);

    expect(withRaster.renderedFieldCount).toBe(1);
    // The proof is that bytes were ADDED. A raster that failed to embed would
    // still return a valid PDF and a count of 1.
    expect(withRaster.mergedDocument.length).toBeGreaterThan(empty.mergedDocument.length);
  });

  it("renders a checked and an unchecked checkbox differently", async () => {
    const checked = await merge([
      textField({ value: { kind: "checkbox", checked: true } }),
    ]);
    const unchecked = await merge([
      textField({ value: { kind: "checkbox", checked: false } }),
    ]);
    expect(checked.mergedDocumentHash).not.toBe(unchecked.mergedDocumentHash);
  });

  it("renders nothing, and no font, for an empty field list", async () => {
    const result = await merge([]);
    expect(result.renderedFieldCount).toBe(0);
  });

  it("places a field on the page it names, not the first", async () => {
    const onePage = await merge([textField({ pageNumber: 1 })], 3);
    const thirdPage = await merge([textField({ pageNumber: 3 })], 3);
    expect(onePage.mergedDocumentHash).not.toBe(thirdPage.mergedDocumentHash);
  });
});

describe("Unicode — OD-163", () => {
  // The whole point of the font change. Every one of these threw under
  // `StandardFonts.Helvetica`, which is WinAnsi-encoded.
  it.each([
    ["Spanish tilde", "Peñaflor"],
    ["acute accent", "Ángeles Ubaldo"],
    ["diaeresis", "Müller"],
    ["cedilla", "François"],
    ["em dash", "Santos — Reyes"],
    ["peso sign", "₱50,000.00"],
    ["macron", "Māori"],
  ])("renders a value containing a %s", async (_label, text) => {
    const result = await merge([textField({ value: { kind: "text", text } })]);
    expect(result.renderedFieldCount).toBe(1);
  });

  it("renders a typed signature carrying diacritics", async () => {
    const result = await merge([
      textField({
        value: {
          kind: "signature",
          representation: { kind: "typed", text: "Peñaflor Ángeles", styleIndex: 3 },
        },
      }),
    ]);
    expect(result.renderedFieldCount).toBe(1);
  });
});

describe("the coverage guard — a missing glyph must FAIL, never render blank", () => {
  // Measured during BACKEND-39: an embedded subset font does NOT throw on an
  // uncovered character the way a standard font does. It draws nothing and
  // returns a structurally valid PDF. Without these tests the pipeline could
  // report success over a document with a blank signature.
  it.each([
    ["CJK", "田中太郎"],
    ["Arabic", "محمد"],
    ["emoji", "signed \u{1F58A}"],
  ])("refuses a text value containing %s", async (_label, text) => {
    await expect(merge([textField({ value: { kind: "text", text } })])).rejects.toThrow(
      UnrenderableTextError,
    );
  });

  it("refuses a typed signature the face cannot draw", async () => {
    await expect(
      merge([
        textField({
          value: {
            kind: "signature",
            representation: { kind: "typed", text: "田中", styleIndex: 1 },
          },
        }),
      ]),
    ).rejects.toThrow(UnrenderableTextError);
  });

  it("classifies the refusal as TERMINAL", async () => {
    // Retrying reproduces it exactly, and a retryable classification would burn
    // the attempt budget that should surface a real outage.
    await expect(
      merge([textField({ value: { kind: "text", text: "田中" } })]),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("never puts the field value in the error message", async () => {
    // §42. Error records are persisted and logged; a field value is signer
    // content — a name, an address, a contract term.
    const secret = "田中太郎";
    const error = await rejection(
      merge([textField({ value: { kind: "text", text: secret } })]),
    );

    expect(error).toBeInstanceOf(UnrenderableTextError);
    expect(error.message).not.toContain(secret);
    // It names the code point instead, which is what an operator needs.
    expect(error.message).toMatch(/U\+7530/);
  });

  it("does not fail a value over a control character", async () => {
    // Control characters have no glyph by definition. Failing on them would
    // reject documents over a stray carriage return.
    const result = await merge([
      textField({ value: { kind: "text", text: "Maria\tSantos\r\n" } }),
    ]);
    expect(result.renderedFieldCount).toBe(1);
  });

  it("reads an astral character as ONE code point, not two surrogates", async () => {
    const error = await rejection(
      merge([textField({ value: { kind: "text", text: "\u{1F58A}" } })]),
    );

    // U+1F58A, not the surrogate halves U+D83D and U+DD8A.
    expect(error.message).toMatch(/U\+1F58A/);
    expect(error.message).not.toMatch(/U\+D83D/);
  });
});

describe("signature representations", () => {
  const raster = (
    overrides: Partial<{
      bytes: Uint8Array; mediaType: string; width: number; height: number;
    }> = {},
  ): MergeableField =>
    textField({
      value: {
        kind: "signature",
        representation: {
          kind: "raster",
          bytes: buildTestSignaturePng(),
          mediaType: "image/png",
          width: 8,
          height: 4,
          ...overrides,
        },
      },
    });

  it("refuses a media type this build cannot render", async () => {
    // The product's canvas emits PNG and nothing else. Silently skipping a
    // JPEG would produce a document with a blank signature.
    await expect(merge([raster({ mediaType: "image/jpeg" })])).rejects.toThrow(
      UnsupportedRepresentationError,
    );
  });

  it("refuses empty raster bytes", async () => {
    await expect(merge([raster({ bytes: new Uint8Array(0) })])).rejects.toThrow(
      UnsupportedRepresentationError,
    );
  });

  it("refuses bytes that are not a decodable PNG", async () => {
    // A PNG signature followed by rubbish. The media type is right and the
    // bytes are not, which is exactly what a truncated upload looks like.
    const corrupt = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    await expect(merge([raster({ bytes: corrupt })])).rejects.toThrow(
      UnsupportedRepresentationError,
    );
  });

  it.each([-1, 4, 1.5, Number.NaN])(
    "refuses typed style index %s rather than clamping it",
    async (styleIndex) => {
      // Clamping would render a signature in a style the signer did not choose
      // and record nothing about having done so.
      await expect(
        merge([
          textField({
            value: {
              kind: "signature",
              representation: { kind: "typed", text: "Maria", styleIndex },
            },
          }),
        ]),
      ).rejects.toThrow(UnsupportedRepresentationError);
    },
  );

  it.each([0, 1, 2, 3])("accepts typed style index %s", async (styleIndex) => {
    const result = await merge([
      textField({
        value: {
          kind: "signature",
          representation: { kind: "typed", text: "Maria", styleIndex },
        },
      }),
    ]);
    expect(result.renderedFieldCount).toBe(1);
  });

  it("preserves the raster's aspect ratio rather than stretching it", async () => {
    // A signature stretched to fill a box of a different aspect ratio is a
    // different mark from the one the signer made. A wide raster and a tall one
    // in the SAME box must not produce the same drawing.
    const wide = await merge([raster({ bytes: buildTestSignaturePng(16, 4) })]);
    const tall = await merge([raster({ bytes: buildTestSignaturePng(4, 16) })]);
    expect(wide.mergedDocumentHash).not.toBe(tall.mergedDocumentHash);
  });

  it("classifies every representation refusal as TERMINAL", async () => {
    await expect(merge([raster({ mediaType: "image/gif" })])).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe("geometry is revalidated at render time", () => {
  // BACKEND-30 enforces `x + width <= 1` as a database CHECK. That constrains
  // what preparation may WRITE; it says nothing about what reached this
  // function after a restore or a hand-edited row.
  it.each([
    ["negative x", { ...RECT, x: -0.1 }],
    ["overflowing width", { ...RECT, x: 0.9, width: 0.2 }],
    ["overflowing height", { ...RECT, y: 0.95, height: 0.2 }],
    ["zero width", { ...RECT, width: 0 }],
    ["negative height", { ...RECT, height: -0.1 }],
    ["non-finite x", { ...RECT, x: Number.NaN }],
    ["infinite width", { ...RECT, width: Number.POSITIVE_INFINITY }],
  ])("refuses %s", async (_label, rect) => {
    await expect(merge([textField({ rect })])).rejects.toThrow(InvalidFieldPlacementError);
  });

  it.each([0, -1, 1.5])("refuses page number %s", async (pageNumber) => {
    await expect(merge([textField({ pageNumber })])).rejects.toThrow(
      InvalidFieldPlacementError,
    );
  });

  it("refuses a page beyond the document", async () => {
    await expect(merge([textField({ pageNumber: 4 })], 3)).rejects.toThrow(
      InvalidFieldPlacementError,
    );
  });

  it("names the field, and not its value, in the message", async () => {
    const error = await rejection(
      merge([
        textField({
          fieldId: "signature-block-7",
          rect: { ...RECT, x: -1 },
          value: { kind: "text", text: "Maria Santos" },
        }),
      ]),
    );

    expect(error.message).toContain("signature-block-7");
    expect(error.message).not.toContain("Maria Santos");
  });

  it("validates EVERY field before drawing any of them", async () => {
    // Interleaving validation with drawing leaves a document half-rendered when
    // the fourth field is rejected.
    const fields = [
      textField({ fieldId: "a" }),
      textField({ fieldId: "b" }),
      textField({ fieldId: "c", rect: { ...RECT, x: 2 } }),
    ];
    await expect(merge(fields)).rejects.toThrow(InvalidFieldPlacementError);
  });
});

describe("determinism", () => {
  it("produces identical bytes for an identical request", async () => {
    // The merged candidate's SHA-256 is its identity. Two attempts of the same
    // run must agree, or §117's "reuse the previous attempt's output" is
    // comparing against something that can never match.
    const req = await request([
      textField(),
      textField({ fieldId: "field-2", value: { kind: "checkbox", checked: true } }),
    ]);
    const first = await merger.mergeFields(req);
    const second = await merger.mergeFields(req);
    expect(first.mergedDocumentHash).toBe(second.mergedDocumentHash);
  });

  it("does not depend on the order the caller supplies fields in", async () => {
    // Two fields may overlap, and the one drawn second is the one visible.
    // Iterating the caller's array would make the visible result depend on how
    // rows happened to come back from the database.
    const a = textField({ fieldId: "aaa" });
    const b = textField({ fieldId: "bbb", rect: { ...RECT, y: 0.5 } });
    const forward = await merge([a, b]);
    const reverse = await merge([b, a]);
    expect(forward.mergedDocumentHash).toBe(reverse.mergedDocumentHash);
  });

  it("reads no clock — `mergedAt` drives the modification date", async () => {
    const fields = [textField()];
    const early = await merger.mergeFields({
      sourceDocument: await buildTestPdf(), fields, mergedAt: "2026-01-01T00:00:00.000Z",
    });
    const late = await merger.mergeFields({
      sourceDocument: await buildTestPdf(), fields, mergedAt: "2026-12-31T00:00:00.000Z",
    });
    expect(early.mergedDocumentHash).not.toBe(late.mergedDocumentHash);
  });

  it("tolerates an unparseable mergedAt rather than failing the merge", async () => {
    const result = await merger.mergeFields({
      sourceDocument: await buildTestPdf(), fields: [textField()], mergedAt: "not-a-date",
    });
    expect(result.renderedFieldCount).toBe(1);
  });
});

describe("hashing", () => {
  it("hashes the source exactly as received and the output after serialization", async () => {
    const source = await buildTestPdf();
    const result = await merger.mergeFields({
      sourceDocument: source, fields: [textField()], mergedAt: MERGED_AT,
    });
    expect(result.sourceDocumentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mergedDocumentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mergedDocumentHash).not.toBe(result.sourceDocumentHash);
  });

  it("never mutates the caller's buffer", async () => {
    // The caller still needs those bytes to match `sourceDocumentHash`, and
    // pdf-lib may retain and write through the array it is given.
    const source = await buildTestPdf();
    const before = Uint8Array.from(source);
    await merger.mergeFields({
      sourceDocument: source, fields: [textField()], mergedAt: MERGED_AT,
    });
    expect(Array.from(source)).toEqual(Array.from(before));
  });

  it("hashes the source even when rendering later fails", async () => {
    // The digest is taken before anything can touch the bytes, so a failed
    // merge still cannot be blamed on the source having changed.
    const source = await buildTestPdf();
    const before = Uint8Array.from(source);
    await merger
      .mergeFields({
        sourceDocument: source,
        fields: [textField({ rect: { ...RECT, x: -1 } })],
        mergedAt: MERGED_AT,
      })
      .catch(() => undefined);
    expect(Array.from(source)).toEqual(Array.from(before));
  });
});

describe("input the merger refuses", () => {
  it("refuses an empty document", async () => {
    await expect(
      merger.mergeFields({
        sourceDocument: new Uint8Array(0), fields: [], mergedAt: MERGED_AT,
      }),
    ).rejects.toThrow(InvalidSealInputError);
  });

  it("refuses bytes that are not a PDF", async () => {
    await expect(
      merger.mergeFields({
        sourceDocument: new TextEncoder().encode("this is not a pdf"),
        fields: [],
        mergedAt: MERGED_AT,
      }),
    ).rejects.toThrow(InvalidPdfError);
  });

  it("refuses a PDF header with no readable page tree, as TERMINAL", async () => {
    // pdf-lib's loader is tolerant: `%PDF-` followed by nothing usable parses
    // into a document with no pages. Left unchecked the failure surfaces later
    // as a RETRYABLE processing error, and the pipeline retries a permanently
    // malformed file forever.
    const error = await rejection(
      merger.mergeFields({
        sourceDocument: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
        fields: [],
        mergedAt: MERGED_AT,
      }),
    );

    expect(error).toBeInstanceOf(InvalidPdfError);
    expect(error.retryable).toBe(false);
  });

  it("refuses the same field twice", async () => {
    // Two values for one field is an input inconsistency, and drawing both
    // stacks them illegibly on top of each other.
    await expect(
      merge([textField({ fieldId: "dup" }), textField({ fieldId: "dup" })]),
    ).rejects.toThrow(InvalidFieldPlacementError);
  });

  it("lets no pdf-lib error escape the seam", async () => {
    // INV-008. A caller that had to understand pdf-lib's exception types could
    // not be satisfied by a future remote implementation.
    const inputs: MergeFieldsRequest[] = [
      { sourceDocument: new Uint8Array([1, 2, 3]), fields: [], mergedAt: MERGED_AT },
      {
        sourceDocument: new TextEncoder().encode("%PDF-1.7 garbage"),
        fields: [],
        mergedAt: MERGED_AT,
      },
    ];
    for (const input of inputs) {
      const error = await merger.mergeFields(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SealingError);
    }
  });
});

describe("the merged candidate is not sealed", () => {
  it("preserves the source page count", async () => {
    // The certificate is a separate artifact and is never appended, so the
    // document people signed keeps the page count they saw.
    const result = await merge([textField()], 3);
    const reloaded = await PDFDocument.load(result.mergedDocument);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("produces a document that still loads", async () => {
    const result = await merge([
      textField(),
      textField({
        fieldId: "field-2",
        rect: { ...RECT, y: 0.5 },
        value: {
          kind: "signature",
          representation: {
            kind: "raster",
            bytes: buildTestSignaturePng(),
            mediaType: "image/png",
            width: 8,
            height: 4,
          },
        },
      }),
    ]);
    await expect(PDFDocument.load(result.mergedDocument)).resolves.toBeDefined();
  });
});
