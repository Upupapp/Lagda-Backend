// The template-document generator (066), against the REAL renderer.
//
// This is the half `workflow-template-generate-document.test.ts` in
// `@lagda/application` deliberately does NOT cover — that file fakes this
// port so it can test the USE CASE's orchestration without pulling
// `@lagda/sealing` into application (an architecture guard forbids it). Here
// the renderer is real: real font embedding, real word-wrap, real geometry.
//
// ── What a byte search on the PDF cannot prove ──────────────────────────────
//
// `node-completion-certificate-generator.test.ts` measured this and left the
// warning: embedded-font text is glyph indices in a compressed stream, so
// `expect(bytes).toContain("some text")` passes or fails for reasons that have
// nothing to do with whether the text is really there. This file does not
// attempt it. What IS asserted is structural: page count, magic bytes,
// determinism, and — the load-bearing case — that overflow and geometry
// refusals actually throw rather than silently drawing something wrong.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { NodeTemplateDocumentGenerator } from "./node-template-document-generator.js";
import {
  InvalidSealInputError, InvalidFieldPlacementError, UnrenderableTextError,
} from "./errors/index.js";

const generator = new NodeTemplateDocumentGenerator();
const AT = Date.parse("2026-09-23T14:00:00.000Z");

describe("generating a document from authored content", () => {
  it("renders a real, loadable PDF with the requested page count", async () => {
    const result = await generator.generate({
      pageCount: 2,
      generatedAt: AT,
      blocks: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          text: "This offer letter confirms your position as Software Engineer.",
        },
        {
          pageNumber: 2,
          rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          text: "Signed below.",
          bold: true,
          align: "center",
        },
      ],
    });

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(result.pageCount).toBe(2);

    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(2);
  });

  it("is DETERMINISTIC: identical input produces identical bytes", async () => {
    const request = {
      pageCount: 1,
      generatedAt: AT,
      blocks: [{
        pageNumber: 1,
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        text: "Same input, same output.",
      }],
    };

    const first = await generator.generate(request);
    const second = await generator.generate(request);

    expect(second.digest).toBe(first.digest);
    expect(second.bytes).toEqual(first.bytes);
  });

  it("REFUSES rather than shrinks text that does not fit its box", async () => {
    // A long paragraph in a tiny box at a large font — cannot possibly wrap to
    // fit, which is the point of this test. See template-content.ts's own
    // header for why this is a refusal, not a silent shrink.
    await expect(generator.generate({
      pageCount: 1,
      generatedAt: AT,
      blocks: [{
        pageNumber: 1,
        rect: { x: 0.1, y: 0.1, width: 0.05, height: 0.02 },
        text: "This paragraph is far too long to fit inside a box this small, "
          + "no matter how it is wrapped, because the box itself is tiny.",
        fontSize: 24,
      }],
    })).rejects.toBeInstanceOf(UnrenderableTextError);
  });

  it("REFUSES a rectangle that runs off the page", async () => {
    await expect(generator.generate({
      pageCount: 1,
      generatedAt: AT,
      blocks: [{
        pageNumber: 1,
        rect: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 },
        text: "Runs off the page.",
      }],
    })).rejects.toBeInstanceOf(InvalidFieldPlacementError);
  });

  it("REFUSES a block naming a page beyond pageCount", async () => {
    await expect(generator.generate({
      pageCount: 1,
      generatedAt: AT,
      blocks: [{
        pageNumber: 2,
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        text: "Off the end.",
      }],
    })).rejects.toBeInstanceOf(InvalidFieldPlacementError);
  });

  it("REFUSES fewer than one page", async () => {
    await expect(generator.generate({
      pageCount: 0,
      generatedAt: AT,
      blocks: [],
    })).rejects.toBeInstanceOf(InvalidSealInputError);
  });

  it("renders blank pages with no blocks at all", async () => {
    // A template mid-authoring — pages exist, nothing is placed on them yet.
    // Must not throw, and must not be mistaken for the "at least one page"
    // rule above, which is about page COUNT, not block count.
    const result = await generator.generate({ pageCount: 3, generatedAt: AT, blocks: [] });
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(3);
  });

  it("wraps a long paragraph across multiple lines rather than refusing when the box is TALL enough", async () => {
    // The companion case to the overflow test above: a box that is narrow but
    // TALL should accept a paragraph by wrapping it onto several lines. If
    // this throws, wrapping itself is broken, not just the overflow check.
    await expect(generator.generate({
      pageCount: 1,
      generatedAt: AT,
      blocks: [{
        pageNumber: 1,
        rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.6 },
        text: "This paragraph is long enough to need several lines, and this "
          + "box is tall enough to hold every one of them without any "
          + "trouble at all, because wrapping is what boxes like this are for.",
        fontSize: 10,
      }],
    })).resolves.toBeDefined();
  });
});
