// Document preparation domain rules.
//
// Pure: no clock, no persistence, no HTTP, and — the one that matters most
// here — **no PDF library**. Preparation reasons about normalized rectangles
// and a page count. It never opens a document.
//
// Everything in this file is a function of its arguments, which is what lets
// the geometry rules be tested exhaustively at the boundaries without a
// database or a PDF.

import {
  PREPARATION_FIELD_TYPES, PREPARATION_MAX_FIELDS,
  PREPARATION_FIELD_LABEL_MAX_LENGTH,
  type PreparationFieldType, type PreparationRect, type PreparationState,
} from "@lagda/contracts";

export {
  PREPARATION_FIELD_TYPES, PREPARATION_MAX_FIELDS,
  PREPARATION_FIELD_LABEL_MAX_LENGTH,
};
export type { PreparationFieldType, PreparationRect, PreparationState };

// ── Render mapping ───────────────────────────────────────────────────────────

/**
 * How each preparation field type will be RENDERED onto the final PDF.
 *
 * Nine preparation types, five render types. The mapping exists in exactly one
 * place so the sealer and the editor cannot disagree about what a `full-name`
 * field becomes.
 *
 * The values are `SealableFieldType` from the sealing port — deliberately, so
 * this is a total map onto a vocabulary that already exists rather than a
 * parallel one. If a preparation type is ever added without a renderer, this
 * `Record` is where it fails to compile.
 *
 * `date-signed` maps to `date`: the sealer renders the value the ceremony
 * supplies, not today's server date. Preparation records only that a date is
 * requested at that spot.
 */
const RENDER_TYPES = {
  signature: "signature",
  initials: "initials",
  "date-signed": "date",
  checkbox: "checkbox",
  text: "text",
  // The four semantic text fields. Distinct in what they ask for, identical in
  // how they draw.
  "full-name": "text",
  email: "text",
  title: "text",
  company: "text",
} as const satisfies Record<PreparationFieldType, string>;

export type PreparationRenderType = (typeof RENDER_TYPES)[PreparationFieldType];

/** The render type for a preparation field type. Total, so it cannot miss. */
export function renderTypeFor(type: PreparationFieldType): PreparationRenderType {
  return RENDER_TYPES[type];
}

/**
 * Whether a field type is inherently required regardless of the `required` flag.
 *
 * A signature is the point of the document. The product's editor exposes a
 * `required` checkbox on every field, so the flag is stored for every type —
 * but a signature field with `required: false` is a contradiction the domain
 * resolves rather than persisting a lie.
 *
 * Kept as a predicate rather than special-casing at each call site, so
 * "is this field mandatory" has one answer.
 */
export function isInherentlyRequired(type: PreparationFieldType): boolean {
  return type === "signature" || type === "initials";
}

/** The effective requiredness, after the inherent rule. */
export function effectiveRequired(
  type: PreparationFieldType,
  requestedRequired: boolean,
): boolean {
  return isInherentlyRequired(type) ? true : requestedRequired;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export type GeometryRejection =
  | "not-finite"
  | "non-positive-size"
  | "out-of-bounds"
  | "below-minimum-size";

/**
 * The smallest usable field, as a fraction of the page.
 *
 * 0.005 is roughly 3 points on A4 — smaller than any glyph, and small enough
 * that nothing legitimate is refused. The purpose is to reject PATHOLOGICAL
 * values (§70), not to impose design taste: the editor has its own
 * `FIELD_SIZE_CONSTRAINTS` with sensible per-type defaults, and duplicating
 * those here would be a second design authority that drifts.
 *
 * A near-zero field is worth refusing because it is invisible and unclickable —
 * a signer would be blocked by a required field they cannot find.
 */
export const MINIMUM_FIELD_EXTENT = 0.005;

/**
 * Validates a rectangle against the page.
 *
 * ── Why no page dimensions are needed ──────────────────────────────────────
 *
 * Coordinates are normalized, so the page is 1 wide and 1 tall by definition.
 * Bounds checking is arithmetic on the rectangle alone, and is therefore
 * identical for A4, Letter and legal source PDFs.
 *
 * ── Out of bounds is REJECTED, not clipped ─────────────────────────────────
 *
 * The same rule PDF_COORDINATE_MODEL.md states for rendering. Clipping produces
 * a document that looks complete with a signature cropped at the margin; a
 * refusal is recoverable, a silently truncated signature on a distributed
 * document is not.
 *
 * The `NaN` check comes first and is explicit: every comparison against `NaN`
 * is false, so a bounds test alone would PASS a `NaN` rectangle.
 */
export function validateRect(rect: PreparationRect): {
  readonly ok: true;
} | { readonly ok: false; readonly reason: GeometryRejection } {
  const { x, y, width, height } = rect;

  // First, and deliberately. `NaN > 0` is false and `NaN <= 1` is false, so a
  // NaN would slip through a purely comparative check as "not out of bounds".
  if (![x, y, width, height].every(Number.isFinite)) {
    return { ok: false, reason: "not-finite" };
  }
  if (width <= 0 || height <= 0) return { ok: false, reason: "non-positive-size" };
  if (width < MINIMUM_FIELD_EXTENT || height < MINIMUM_FIELD_EXTENT) {
    return { ok: false, reason: "below-minimum-size" };
  }
  // Partial overflow is refused along with total overflow: a field half off the
  // page is a signature half off the page.
  if (x < 0 || y < 0 || x + width > 1 || y + height > 1) {
    return { ok: false, reason: "out-of-bounds" };
  }
  return { ok: true };
}

/**
 * Rounds a coordinate to the persisted precision.
 *
 * ── Why round at all ───────────────────────────────────────────────────────
 *
 * A browser drag produces values like `0.31415926535897931`. Fifteen decimals
 * of a page is sub-atomic; the noise is meaningless and it makes two layouts
 * that are visually identical compare as different — which matters the moment
 * BACKEND-32 wants to hash a preparation snapshot.
 *
 * ── Six decimals ───────────────────────────────────────────────────────────
 *
 * On a 595-point A4 page, 1e-6 of the width is 0.0006 points — about 1/1000 of
 * a pixel at 96 DPI. Far below anything renderable, so nothing is lost, and it
 * leaves values that survive a `double precision` round trip exactly.
 *
 * Centralized here (§164) so the frontend and backend cannot round differently.
 */
export const COORDINATE_PRECISION = 6;

export function roundCoordinate(value: number): number {
  // `Number.parseFloat(toFixed())` rather than `Math.round(v * 1e6) / 1e6`:
  // the latter reintroduces representation error for values like 0.145.
  return Number.parseFloat(value.toFixed(COORDINATE_PRECISION));
}

export function roundRect(rect: PreparationRect): PreparationRect {
  return {
    x: roundCoordinate(rect.x),
    y: roundCoordinate(rect.y),
    width: roundCoordinate(rect.width),
    height: roundCoordinate(rect.height),
  };
}

// ── Pages ────────────────────────────────────────────────────────────────────

/**
 * Whether a 1-based page number exists in a document of `pageCount` pages.
 *
 * 1-based, matching `SealableField.pageNumber` and the product. Page 0 is
 * refused rather than read as page 1 — a zero means the caller is using a
 * different convention, and accepting it would place the field on the wrong
 * page for every subsequent call.
 *
 * `pageCount` must come from the artifact's inspection metadata, never from a
 * client (§57).
 */
export function isValidPageNumber(pageNumber: number, pageCount: number): boolean {
  return Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount;
}

// ── Rotation ─────────────────────────────────────────────────────────────────

/**
 * Whether fields may be placed on this artifact at all.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * pdf-lib's `page.getSize()` returns the UNROTATED mediabox. A viewer renders
 * the rotated page. So on a 90° page the editor's normalized coordinates are
 * taken against a landscape view while the renderer places them into portrait
 * space — every field on that page lands wrong, with no error anywhere.
 *
 * ── The decision ───────────────────────────────────────────────────────────
 *
 * Refuse the document rather than misplace fields on it. A refusal is visible
 * and recoverable; a silently rotated signature block on a distributed contract
 * is not, and it is exactly the failure PDF_COORDINATE_MODEL.md warns is
 * invisible to every byte-level assertion.
 *
 * This is a REAL LIMITATION, not a safety margin: a scanned document rotated by
 * its scanner cannot currently be prepared. It is recorded as OD-124, and it is
 * lifted by teaching the renderer about rotation, not by relaxing this check.
 *
 * `null` means an artifact predating the rotation inspection. Treated as
 * unknown-and-refused rather than assumed unrotated: assuming would mean
 * silently accepting exactly the case this exists to catch.
 */
export function canPlaceFields(rotatedPageCount: number | null): boolean {
  return rotatedPageCount === 0;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export type LabelRejection = "too-long" | "control-characters";

/**
 * The same control/format rule as every other human-entered text in LAGDA.
 *
 * A field label is shown to the SIGNER, which makes the `Cf` half matter: a
 * bidirectional override in "Landlord signature" can render as something else
 * entirely on the one screen where a person is deciding what they are signing.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Validates and trims a field label.
 *
 * An EMPTY label is permitted, unlike a document title: the editor defaults
 * labels from the field type and a sender may legitimately clear one. Requiring
 * text would force a placeholder nobody chose.
 */
export function validateFieldLabel(raw: string): {
  readonly ok: true; readonly value: string;
} | { readonly ok: false; readonly reason: LabelRejection } {
  const trimmed = raw.trim();
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > PREPARATION_FIELD_LABEL_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Derived from `lockedAt`, never stored as a column.
 *
 * The same rule invitations, contacts and documents follow: two representations
 * of one fact drift, and the denormalised one is the one that drifts.
 */
export function derivePreparationState(lockedAt: number | null): PreparationState {
  return lockedAt === null ? "editable" : "locked";
}

/**
 * Whether the layout may be changed.
 *
 * **The single authoritative rule** (§21). Every mutation asks this rather than
 * testing `lockedAt` itself, so there is one place to change when BACKEND-32
 * introduces the freeze — and no possibility of two operations disagreeing
 * about what "editable" means.
 */
export function isPreparationEditable(lockedAt: number | null): boolean {
  return lockedAt === null;
}
