// Rendering accepted values onto the source document — the field-merge step.
//
// ── What this fixes that `fields.ts` could not ─────────────────────────────
//
//   1. A DRAWN SIGNATURE NOW RENDERS. The legacy renderer drew every
//      `signature` field with `drawText` in an oblique face, which is a TYPED
//      rendering. A raster has no text, so the PNG the signer actually drew on
//      the canvas produced nothing at all. This was the largest gap in the
//      BACKEND-39 inventory.
//
//   2. UNICODE WORKS. `StandardFonts.Helvetica` is WinAnsi and pdf-lib throws
//      on anything outside it, so "Peñaflor" could not be completed. OD-163.
//
//   3. A MISSING GLYPH IS REFUSED RATHER THAN DRAWN BLANK. See `fonts.ts` —
//      this is the failure an embedded font introduces and it is silent.
//
// ── What it deliberately does not do ───────────────────────────────────────
//
// It does not seal, hash-and-store, upload, or touch `DocumentSealer`. It does
// not read a clock: `mergedAt` is supplied so the same request produces the
// same bytes. It does not handle rotated pages — BACKEND-30 refuses them at
// preparation time (OD-124), so only 0° can reach completion, and implementing
// a transform that cannot be exercised would be untested code that looks
// supported.

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type {
  MergeableField, MergeableFieldValue, SignatureRepresentation,
} from "@lagda/application";
import {
  InvalidFieldPlacementError, PdfProcessingError, UnsupportedRepresentationError,
} from "../errors/index.js";
import { assertPlaceable, toPdfRect, type PdfRect } from "./geometry.js";
import { embedFaces, type EmbeddedFaces, type FaceName } from "./fonts.js";

/** Ink colour for rendered values. Near-black, not pure black, matching print. */
const INK = rgb(0.07, 0.09, 0.13);

/** Below this a rendered value stops being legible; it is not shrunk further. */
const MIN_FONT_SIZE = 6;

/** The product's canvas emits this and nothing else, and §52 verifies it. */
const SUPPORTED_RASTER_MEDIA_TYPE = "image/png";

/** Four server-known typed styles, indices 0–3 (§60). */
const TYPED_STYLE_COUNT = 4;

/**
 * Which face a value renders in.
 *
 * Typed signatures and initials render in `italic`, matching the legacy
 * renderer's oblique face so the merge does not silently restyle documents
 * people have already seen in preview.
 */
function faceFor(value: MergeableFieldValue): FaceName {
  return value.kind === "signature" ? "italic" : "regular";
}

/** The text a value draws, or `null` when it draws no text at all. */
function textOf(value: MergeableFieldValue): string | null {
  switch (value.kind) {
    case "text":
      return value.text;
    case "checkbox":
      // Drawn as strokes, never as a glyph — see `drawCheckbox`.
      return null;
    case "signature":
      return value.representation.kind === "typed" ? value.representation.text : null;
  }
}

/**
 * Largest size that fits the box, measured with the REAL font.
 *
 * The legacy renderer approximated Helvetica's advance width as 0.5 em per
 * character, which is wrong for both narrow and wide strings and wrong for
 * every accented glyph. `widthOfTextAtSize` asks the embedded face, so a name
 * that fits is not shrunk and a name that does not is not overflowed.
 */
function fitFontSize(
  text: string,
  font: PDFFont,
  boxWidth: number,
  boxHeight: number,
): number {
  const byHeight = boxHeight * 0.7;
  if (text.length === 0) return Math.max(MIN_FONT_SIZE, byHeight);

  const widthAtOne = font.widthOfTextAtSize(text, 1);
  // A face reporting zero advance would divide to Infinity and produce a size
  // that fails deep inside pdf-lib rather than here.
  const byWidth = widthAtOne > 0 ? boxWidth / widthAtOne : byHeight;

  return Math.max(MIN_FONT_SIZE, Math.min(byHeight, byWidth));
}

function drawText(page: PDFPage, text: string, font: PDFFont, box: PdfRect): void {
  const size = fitFontSize(text, font, box.width, box.height);
  page.drawText(text, {
    x: box.x,
    // Vertically centred within the field box, matching the legacy renderer.
    y: box.y + (box.height - size) / 2,
    size,
    font,
    color: INK,
  });
}

/**
 * A checkbox, drawn as strokes.
 *
 * NOT a glyph. A checkmark character depends on the face having it, and a
 * missing glyph renders as nothing — an unchecked box that should be checked.
 * That reasoning is why `fonts.ts` refuses uncovered glyphs everywhere else;
 * here it is avoided entirely by not using one.
 */
function drawCheckbox(page: PDFPage, checked: boolean, box: PdfRect): void {
  const side = Math.min(box.width, box.height);
  page.drawRectangle({
    x: box.x, y: box.y, width: side, height: side,
    borderColor: INK, borderWidth: 1,
  });
  if (!checked) return;

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

/**
 * The drawn signature, fitted to its box WITHOUT distortion.
 *
 * A signature stretched to fill a box of a different aspect ratio is a
 * different mark from the one the signer made. It is scaled to fit and centred,
 * so the whole raster is visible and its proportions are preserved.
 *
 * The image's OWN dimensions drive the layout, not the recorded
 * `width`/`height`. The bytes are immutable and are the authority; a recorded
 * dimension that disagrees with them describes a row, not a picture.
 */
async function drawRaster(
  pdf: PDFDocument,
  page: PDFPage,
  representation: Extract<SignatureRepresentation, { kind: "raster" }>,
  box: PdfRect,
  label: string,
): Promise<void> {
  let image: { width: number; height: number; scale(f: number): { width: number; height: number } };
  try {
    image = await pdf.embedPng(representation.bytes);
  } catch (cause) {
    // Bytes that are not a decodable PNG. Terminal: the same bytes will fail
    // identically forever, so retrying only burns the attempt budget.
    throw new UnsupportedRepresentationError(
      `Field ${label} carries a drawn signature that could not be decoded as PNG.`,
      cause,
    );
  }

  if (image.width <= 0 || image.height <= 0) {
    throw new UnsupportedRepresentationError(
      `Field ${label} carries a drawn signature with no area.`,
    );
  }

  const factor = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * factor;
  const height = image.height * factor;

  page.drawImage(image as Parameters<PDFPage["drawImage"]>[0], {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  });
}

/**
 * Everything that can be decided before a single byte is drawn.
 *
 * Validating up front is not tidiness. Interleaving it with drawing leaves a
 * document half-rendered when the fourth field is rejected, and it lets an
 * unrelated failure mask a placement error that has a much more specific
 * message. The legacy renderer established this and it is kept.
 */
function assertMergeable(
  field: MergeableField,
  pageCount: number,
  faces: EmbeddedFaces,
): void {
  const label = field.fieldId;
  assertPlaceable(field.rect, field.pageNumber, pageCount, label);

  const value = field.value;
  if (value.kind === "signature") {
    const representation = value.representation;
    if (representation.kind === "typed") {
      if (
        !Number.isInteger(representation.styleIndex) ||
        representation.styleIndex < 0 ||
        representation.styleIndex >= TYPED_STYLE_COUNT
      ) {
        // Refused, not clamped. Clamping would render a signature in a style
        // the signer did not choose and record nothing about having done so.
        throw new UnsupportedRepresentationError(
          `Field ${label} names typed style ${String(representation.styleIndex)}, ` +
            `which is outside 0–${String(TYPED_STYLE_COUNT - 1)}.`,
        );
      }
    } else if (representation.mediaType !== SUPPORTED_RASTER_MEDIA_TYPE) {
      throw new UnsupportedRepresentationError(
        `Field ${label} carries a drawn signature of media type ` +
          `${representation.mediaType}, which this build cannot render.`,
      );
    } else if (representation.bytes.length === 0) {
      throw new UnsupportedRepresentationError(
        `Field ${label} carries an empty drawn signature.`,
      );
    }
  }

  // The coverage guard. Every drawn character must have a glyph, or the value
  // renders blank and the document looks complete.
  const text = textOf(value);
  if (text !== null) faces.assertRenderable(text, faceFor(value));
}

/**
 * Renders every field, in a DETERMINISTIC order.
 *
 * Order matters because two fields may overlap, and the one drawn second is
 * the one that is visible. Iterating the caller's array would make the visible
 * result depend on however the rows happened to come back from the database —
 * which is not a decision anybody made, and it would change under an unrelated
 * query edit. Sorting by `(pageNumber, fieldId)` makes it a property of the
 * data instead.
 */
export async function mergeFields(
  pdf: PDFDocument,
  fields: readonly MergeableField[],
): Promise<number> {
  if (fields.length === 0) return 0;

  const pages = pdf.getPages();
  const faces = embedFaces(pdf);

  const ordered = [...fields].sort(
    (a, b) =>
      a.pageNumber - b.pageNumber ||
      (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0),
  );

  const duplicates = ordered.filter(
    (field, index) => index > 0 && ordered[index - 1]?.fieldId === field.fieldId,
  );
  if (duplicates.length > 0) {
    // Two values for one field is an input inconsistency, and rendering both
    // would stack them illegibly on top of each other.
    throw new InvalidFieldPlacementError(
      `Field ${duplicates[0]?.fieldId ?? ""} appears more than once.`,
    );
  }

  for (const field of ordered) assertMergeable(field, pages.length, faces);

  for (const field of ordered) {
    const page: PDFPage | undefined = pages[field.pageNumber - 1];
    if (page === undefined) {
      throw new InvalidFieldPlacementError(
        `Page ${String(field.pageNumber)} could not be resolved.`,
      );
    }

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const box = toPdfRect(field.rect, pageWidth, pageHeight);
    const value = field.value;

    switch (value.kind) {
      case "checkbox":
        drawCheckbox(page, value.checked, box);
        break;

      case "text":
        drawText(page, value.text, await faces.face("regular"), box);
        break;

      case "signature":
        if (value.representation.kind === "typed") {
          // A rendered representation of a signature, NOT a cryptographic one.
          // Nothing here signs anything — see SEAL_METADATA.md.
          drawText(page, value.representation.text, await faces.face("italic"), box);
        } else {
          await drawRaster(pdf, page, value.representation, box, field.fieldId);
        }
        break;
    }
  }

  return ordered.length;
}

/** Serializes, converting a pdf-lib failure into a LAGDA-owned one. */
export async function serialize(pdf: PDFDocument): Promise<Uint8Array> {
  try {
    return await pdf.save();
  } catch (cause) {
    throw new PdfProcessingError("Failed to serialize the merged document.", cause);
  }
}
