// Field placement, and THE COORDINATE FLIP.
//
// THE FLIP LIVES HERE AND NOWHERE ELSE.
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
//
// BACKEND-39 extracted this from `fields.ts` so the field-merge renderer and
// the legacy `seal()` renderer share ONE implementation. Two copies is how one
// path ends up correct and the other upside down, and the second is only
// discovered by someone reading a finished document.

import { InvalidFieldPlacementError } from "../errors/index.js";

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A field's rectangle in PDF user space.
 *
 * @param rect normalized, origin top-left
 * @param pageWidth  page width in PDF points
 * @param pageHeight page height in PDF points
 */
export function toPdfRect(
  rect: NormalizedRect,
  pageWidth: number,
  pageHeight: number,
): PdfRect {
  const width = rect.width * pageWidth;
  const height = rect.height * pageHeight;
  const x = rect.x * pageWidth;

  // The flip. `rect.y` measures down from the top to the field's TOP edge;
  // pdf-lib wants the distance up from the bottom to its BOTTOM edge, so the
  // field's own height is subtracted as well as the offset inverted.
  const y = pageHeight - rect.y * pageHeight - height;

  return { x, y, width, height };
}

/**
 * Rejects geometry that would produce a corrupt or invisible placement.
 *
 * Revalidated at render time even though BACKEND-30 already enforces `x +
 * width <= 1` as a database CHECK. The CHECK constrains what preparation may
 * write; it says nothing about what reached this function — a restore, a
 * hand-edited row, or a future writer that bypasses preparation. §77's rule
 * that a status is not proof applies to geometry too.
 *
 * @param label identifies the field in the message. NEVER its value — a field
 *              value is signer content and §42 keeps it out of error records.
 */
export function assertPlaceable(
  rect: NormalizedRect,
  pageNumber: number,
  pageCount: number,
  label: string,
): void {
  const { x, y, width, height } = rect;

  for (const [name, value] of Object.entries({ x, y, width, height })) {
    if (!Number.isFinite(value)) {
      throw new InvalidFieldPlacementError(
        `Field ${label} rect.${name} is not a finite number.`,
      );
    }
  }
  if (width <= 0 || height <= 0) {
    throw new InvalidFieldPlacementError(
      `Field ${label} width and height must be positive.`,
    );
  }
  if (x < 0 || y < 0 || x + width > 1 || y + height > 1) {
    // Rejected rather than clipped. A signature silently cropped at the page
    // edge is worse than a failed merge — the document would look complete.
    throw new InvalidFieldPlacementError(
      `Field ${label} extends outside the page. ` +
        "Normalized coordinates must lie within 0–1.",
    );
  }
  // Page numbers are 1-based in the product; pdf-lib indexes from 0.
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new InvalidFieldPlacementError(
      `Field ${label} page number must be a positive integer, got ${String(pageNumber)}.`,
    );
  }
  if (pageNumber > pageCount) {
    throw new InvalidFieldPlacementError(
      `Field ${label} references page ${String(pageNumber)} of a ${String(pageCount)}-page document.`,
    );
  }
}
