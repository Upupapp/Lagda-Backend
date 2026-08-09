// Rendering completed fields onto a PDF.
//
// THE COORDINATE FLIP LIVES HERE AND NOWHERE ELSE.
//
// The product's fields are normalized 0–1 with the origin at the TOP-LEFT
// (`src/app/models/field-editor.ts`: "x=0, y=0 is the top-left of the page").
// PDF's native coordinate space has its origin at the BOTTOM-LEFT. So every
// field needs its Y axis inverted, and `y` denotes the field's *top* edge while
// pdf-lib draws from the *bottom* edge.
//
// Getting this wrong does not crash — it silently places signatures in the
// wrong half of the page. Doing the conversion in one function is what makes it
// reviewable.

import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import type { SealableField } from "@lagda/application";
import { InvalidFieldPlacementError } from "../errors/index.js";

/** Ink colour for rendered values. Near-black, not pure black, matching print. */
const INK = rgb(0.07, 0.09, 0.13);

/**
 * A field's rectangle in PDF user space.
 *
 * @param rect normalized, origin top-left
 * @param pageWidth  page width in PDF points
 * @param pageHeight page height in PDF points
 */
export function toPdfRect(
  rect: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const width = rect.width * pageWidth;
  const height = rect.height * pageHeight;
  const x = rect.x * pageWidth;

  // The flip. `rect.y` measures down from the top to the field's TOP edge;
  // pdf-lib wants the distance up from the bottom to its BOTTOM edge, so the
  // field's own height is subtracted as well as the offset inverted.
  const y = pageHeight - (rect.y * pageHeight) - height;

  return { x, y, width, height };
}

/** Rejects geometry that would produce a corrupt or invisible placement. */
function assertRenderable(field: SealableField, pageCount: number): void {
  const { x, y, width, height } = field.rect;

  for (const [name, value] of Object.entries({ x, y, width, height })) {
    if (!Number.isFinite(value)) {
      throw new InvalidFieldPlacementError(
        `Field rect.${name} is not a finite number.`,
      );
    }
  }
  if (width <= 0 || height <= 0) {
    throw new InvalidFieldPlacementError("Field width and height must be positive.");
  }
  if (x < 0 || y < 0 || x + width > 1 || y + height > 1) {
    // Rejected rather than clipped. A signature silently cropped at the page
    // edge is worse than a failed seal — the document would look complete.
    throw new InvalidFieldPlacementError(
      "Field extends outside the page. Normalized coordinates must lie within 0–1.",
    );
  }
  // Page numbers are 1-based in the product; pdf-lib indexes from 0.
  if (!Number.isInteger(field.pageNumber) || field.pageNumber < 1) {
    throw new InvalidFieldPlacementError(
      `Field page number must be a positive integer, got ${String(field.pageNumber)}.`,
    );
  }
  if (field.pageNumber > pageCount) {
    throw new InvalidFieldPlacementError(
      `Field references page ${String(field.pageNumber)} of a ${String(pageCount)}-page document.`,
    );
  }
}

/** Largest size that fits the box, down to a floor where text stops being legible. */
function fitFontSize(text: string, boxWidth: number, boxHeight: number): number {
  const MIN = 6;
  const byHeight = boxHeight * 0.7;
  // 0.5 em average advance is a reasonable approximation for Helvetica.
  const byWidth = text.length > 0 ? (boxWidth / text.length) / 0.5 : byHeight;
  return Math.max(MIN, Math.min(byHeight, byWidth));
}

export async function renderFields(
  pdf: PDFDocument,
  fields: readonly SealableField[],
): Promise<void> {
  if (fields.length === 0) return;

  const pages = pdf.getPages();

  // Validate EVERY field before touching the document. Interleaving validation
  // with drawing would leave a document half-rendered when the fourth field is
  // rejected, and it lets an unrelated failure (font embedding) mask a
  // placement error that has a much more specific message.
  for (const field of fields) {
    assertRenderable(field, pages.length);
  }

  // Standard PDF fonts, embedded by the library. No font files, no reliance on
  // fonts installed on whatever machine happens to run this.
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);

  for (const field of fields) {
    const page: PDFPage | undefined = pages[field.pageNumber - 1];
    if (page === undefined) {
      throw new InvalidFieldPlacementError(
        `Page ${String(field.pageNumber)} could not be resolved.`,
      );
    }

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const box = toPdfRect(field.rect, pageWidth, pageHeight);

    switch (field.type) {
      case "signature":
      case "initials": {
        // A rendered representation of a signature, NOT a cryptographic one.
        // Nothing here signs anything — see SEAL_METADATA.md.
        const size = fitFontSize(field.value, box.width, box.height);
        page.drawText(field.value, {
          x: box.x, y: box.y + (box.height - size) / 2,
          size, font: script, color: INK,
        });
        break;
      }
      case "text":
      case "date": {
        // The submitted value, always. A date field shows what the signer
        // entered — never today's server date.
        const size = fitFontSize(field.value, box.width, box.height);
        page.drawText(field.value, {
          x: box.x, y: box.y + (box.height - size) / 2,
          size, font: body, color: INK,
        });
        break;
      }
      case "checkbox": {
        // Drawn, not a glyph. A checkmark character depends on the font having
        // it, and a missing glyph renders as nothing — an unchecked box that
        // should be checked.
        const side = Math.min(box.width, box.height);
        page.drawRectangle({
          x: box.x, y: box.y, width: side, height: side,
          borderColor: INK, borderWidth: 1,
        });
        if (field.value === "true") {
          page.drawLine({
            start: { x: box.x + side * 0.2, y: box.y + side * 0.5 },
            end: { x: box.x + side * 0.45, y: box.y + side * 0.25 },
            thickness: 1.5, color: INK,
          });
          page.drawLine({
            start: { x: box.x + side * 0.45, y: box.y + side * 0.25 },
            end: { x: box.x + side * 0.8, y: box.y + side * 0.75 },
            thickness: 1.5, color: INK,
          });
        }
        break;
      }
    }
  }
}
