// Drawing authored template content onto blank pages (066).
//
// ── Why this is not `merge.ts` ──────────────────────────────────────────────
//
// `merge.ts` draws ONE value into ONE field box — a signature, a typed name —
// and fits it by SHRINKING the font, because a recipient's value has no
// authoring step to fix an overflow at. Authored body text is the opposite:
// the admin controls the box AND the words in it, on a canvas, so an overflow
// is something they can actually fix. Shrinking it silently would let a block
// LOOK fine in the editor and lose text only in the rendered PDF, which is a
// worse failure than refusing to generate at all.
//
// So this module WRAPS to a fixed size and REFUSES what does not fit, rather
// than shrinking. `fitFontSize` in `merge.ts` is deliberately not reused here.
//
// ── What it never logs ──────────────────────────────────────────────────────
//
// An error names the page and block index, never the block's TEXT. Authored
// template content is not a signer's value, but treating every string that
// reaches a renderer as reportable is the simpler rule to keep, and the
// cheaper one to audit.

import { rgb, type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import { UnrenderableTextError } from "../errors/index.js";
import { assertPlaceable, toPdfRect, type NormalizedRect } from "./geometry.js";
import type { EmbeddedFaces } from "./fonts.js";

const INK = rgb(0.07, 0.09, 0.13);

/** Body copy default when a block names no size — matches the completion
 *  certificate's own body size, so a generated document and its certificate
 *  read as one family of document. */
const DEFAULT_FONT_SIZE = 11;

/** Roughly single-spaced for a serif-adjacent body face at this size range. */
const LINE_HEIGHT_FACTOR = 1.35;

export interface TemplateContentBlockInput {
  readonly pageNumber: number;
  readonly rect: NormalizedRect;
  readonly text: string;
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly align?: "left" | "center" | "right";
}

/**
 * Greedy word-wrap, measured with the REAL embedded font — the same reason
 * `fitFontSize` measures rather than estimates in `merge.ts`.
 *
 * A single word wider than the box is NOT split; it is left to overflow that
 * one line's width check, which surfaces as the same refusal an unfittable
 * paragraph gets. Splitting a word silently would produce a hyphen nobody
 * asked for in the wrong place.
 */
function wrapLines(text: string, font: PDFFont, size: number, boxWidthPts: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= boxWidthPts || current.length === 0) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function xFor(
  line: string, font: PDFFont, size: number, box: { x: number; width: number },
  align: "left" | "center" | "right",
): number {
  if (align === "left") return box.x;
  const lineWidth = font.widthOfTextAtSize(line, size);
  return align === "center"
    ? box.x + (box.width - lineWidth) / 2
    : box.x + box.width - lineWidth;
}

/**
 * Draws every block onto its page. Pages must already exist (the caller adds
 * `pageCount` blank A4 pages before calling this); blocks are validated
 * against that page count and the 0-1 rect bound the same way a field
 * placement is, via `assertPlaceable`.
 *
 * @throws UnrenderableTextError when a block's wrapped text is taller than
 *   its own box — refused, not shrunk. See this module's header.
 */
export function drawTemplateContent(
  pdf: PDFDocument,
  pages: readonly PDFPage[],
  faces: EmbeddedFaces,
  regular: PDFFont,
  bold: PDFFont,
  blocks: readonly TemplateContentBlockInput[],
): void {
  blocks.forEach((block, index) => {
    const label = `content block ${String(index + 1)}`;
    assertPlaceable(block.rect, block.pageNumber, pages.length, label);

    const font = block.bold === true ? bold : regular;
    faces.assertRenderable(block.text, block.bold === true ? "bold" : "regular");

    const page = pages[block.pageNumber - 1];
    if (page === undefined) {
      // Unreachable given the assertPlaceable check above; guarded rather than
      // asserted with `!`, matching this codebase's stance that an impossible
      // branch still fails loudly instead of reading as a silent `any`.
      throw new UnrenderableTextError(`${label} names a page that does not exist.`);
    }

    const box = toPdfRect(block.rect, page.getWidth(), page.getHeight());
    const size = block.fontSize ?? DEFAULT_FONT_SIZE;
    const lineHeight = size * LINE_HEIGHT_FACTOR;
    const align = block.align ?? "left";

    const lines = wrapLines(block.text, font, size, box.width);
    const neededHeight = lines.length * lineHeight;
    if (neededHeight > box.height + 0.5) {
      throw new UnrenderableTextError(
        `${label} does not fit its box at ${String(size)}pt: `
        + `${String(lines.length)} line(s) need ${neededHeight.toFixed(1)}pt, `
        + `the box holds ${box.height.toFixed(1)}pt. Shrink the text, grow the `
        + "box, or lower the font size.",
      );
    }

    // Top-down, matching how the box reads in the editor (rect.y is the TOP
    // edge). box.y/box.height are already flipped to PDF's bottom-left origin
    // by toPdfRect, so the first line starts one line-height below the box's
    // own top.
    let y = box.y + box.height - lineHeight;
    for (const line of lines) {
      if (line.length > 0) {
        page.drawText(line, {
          x: xFor(line, font, size, box, align),
          y: y + (lineHeight - size) * 0.2,
          size,
          font,
          color: INK,
        });
      }
      y -= lineHeight;
    }
  });
}
