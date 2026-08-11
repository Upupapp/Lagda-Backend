// Sealing failures, LAGDA-owned.
//
// No pdf-lib error, no HTTP status, no database error crosses this boundary. A
// caller that had to understand `pdf-lib`'s exception types could not be
// satisfied by a future Java or .NET signer.

export abstract class SealingError extends Error {
  abstract readonly code: string;
  /**
   * Whether a retry could plausibly succeed.
   *
   * The distinction matters for the completion pipeline: a malformed PDF will
   * be malformed forever, while a future remote signer timing out will not.
   * Retrying the first wastes work and hides the real failure.
   */
  abstract readonly retryable: boolean;

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** The bytes are not a PDF, or are damaged beyond parsing. Never retryable. */
export class InvalidPdfError extends SealingError {
  readonly code = "invalid_pdf" as const;
  readonly retryable = false;
}

/** A valid PDF this implementation cannot process — encrypted, for example. */
export class UnsupportedPdfError extends SealingError {
  readonly code = "unsupported_pdf" as const;
  readonly retryable = false;
}

/** A field references a page that does not exist, or has impossible geometry. */
export class InvalidFieldPlacementError extends SealingError {
  readonly code = "invalid_field_placement" as const;
  readonly retryable = false;
}

/** The request itself is not sealable — no fields, missing evidence. */
export class InvalidSealInputError extends SealingError {
  readonly code = "invalid_seal_input" as const;
  readonly retryable = false;
}

/**
 * A value contains a character the embedded typeface cannot draw.
 *
 * Never retryable: the same value will be missing the same glyph forever.
 *
 * This exists because the alternative is SILENCE. pdf-lib's standard fonts
 * throw on an out-of-range character, but an embedded subset font does not — it
 * draws nothing and returns a structurally valid PDF. Measured during
 * BACKEND-39: rendering "田中太郎" through a Latin face produced an empty page
 * and no error. Without this the pipeline would report success over a document
 * whose signature field is blank.
 */
export class UnrenderableTextError extends SealingError {
  readonly code = "unrenderable_text" as const;
  readonly retryable = false;
}

/**
 * A signature representation this build cannot render.
 *
 * Never retryable — undecodable bytes stay undecodable, and a typed style
 * outside 0–3 is outside it forever.
 *
 * Distinct from `InvalidFieldPlacementError` because it says something
 * different to an operator: the field is in a sensible place and the SIGNATURE
 * is the problem. Mapping both onto one code would merge "the geometry is
 * corrupt" with "someone submitted a JPEG".
 */
export class UnsupportedRepresentationError extends SealingError {
  readonly code = "unsupported_representation" as const;
  readonly retryable = false;
}

/**
 * The embedded typeface could not be loaded at all.
 *
 * RETRYABLE, and the distinction from `UnrenderableTextError` is the whole
 * point: a missing font file is a broken installation, not a broken document.
 * It fails identically for every document, so classifying it terminally would
 * permanently fail every request in flight for a fault that a redeploy fixes —
 * the same reasoning that makes `step-not-implemented` retryable.
 */
export class TypefaceUnavailableError extends SealingError {
  readonly code = "typeface_unavailable" as const;
  readonly retryable = true;
}

/**
 * Valid input, but processing failed unexpectedly.
 *
 * Separate from the above because this one MIGHT succeed on retry — it usually
 * means something went wrong rather than something was wrong.
 */
export class PdfProcessingError extends SealingError {
  readonly code = "pdf_processing_failed" as const;
  readonly retryable = true;
}
