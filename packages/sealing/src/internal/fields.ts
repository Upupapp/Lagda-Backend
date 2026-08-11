// Rendering completed fields onto a PDF — the LEGACY path, inside `seal()`.
//
// ── Status: superseded, and deliberately still here ────────────────────────
//
// BACKEND-39 built `internal/merge.ts`, which renders the same fields with an
// embedded Unicode face, real raster signatures and a glyph-coverage guard.
// This file is what `DocumentSealer.seal()` still calls.
//
// **OD-162.** BACKEND-41 must narrow `seal()` to sealing alone when it wires
// the `field-merge` step into the pipeline. Until it does, this renderer and
// `mergeFields` would both draw the same values, and every field would appear
// twice — which reads as a font-weight bug, not an architecture bug.
//
// It is not deleted yet because `seal()` is the only path that renders today
// and deleting it would leave the sealer producing blank documents. It gains no
// new capability: the Unicode fix, the raster fix and the coverage guard all
// live in `merge.ts`, so nothing is tempted to keep this one alive.
//
// The coordinate flip it used to own now lives in `geometry.ts`, shared with
// the new renderer. Two copies is how one path ends up correct and the other
// upside down.

import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import type { SealableField } from "@lagda/application";
import { InvalidFieldPlacementError } from "../errors/index.js";
import { assertPlaceable, toPdfRect } from "./geometry.js";
import { embedFaces } from "./fonts.js";

export { toPdfRect };

/** Ink colour for rendered values. Near-black, not pure black, matching print. */
const INK = rgb(0.07, 0.09, 0.13);

/** Largest size that fits the box, down to a floor where text stops being legible. */
function fitFontSize(text: string, boxWidth: number, boxHeight: number): number {
  const MIN = 6;
  const byHeight = boxHeight * 0.7;
  // A 0.5 em average advance, approximated rather than measured. It is wrong
  // for both narrow and wide strings and wrong for every accented glyph; the
  // replacement renderer asks the face through `widthOfTextAtSize` instead.
  // Left as it was because changing the fit here would restyle documents on a
  // path BACKEND-41 deletes.
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
  for (const [index, field] of fields.entries()) {
    assertPlaceable(field.rect, field.pageNumber, pages.length, `#${String(index)}`);
  }

  // The embedded Unicode faces, NOT `StandardFonts.Helvetica`.
  //
  // This renderer is superseded and will be deleted by BACKEND-41, but it is
  // the only path that renders TODAY — `seal()` calls it. Leaving it on WinAnsi
  // would mean OD-163 was only half closed: the new renderer would accept
  // "Peñaflor" while the live one still threw on it, and which of the two was
  // fixed would depend on which command someone happened to read.
  //
  // The coverage guard comes with them, so a name this face cannot draw is
  // refused here too rather than rendered blank.
  const faces = embedFaces(pdf);
  const body = await faces.face("regular");
  const script = await faces.face("italic");

  for (const field of fields) {
    if (field.value.length > 0) {
      faces.assertRenderable(
        field.value,
        field.type === "signature" || field.type === "initials" ? "italic" : "regular",
      );
    }
  }

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
