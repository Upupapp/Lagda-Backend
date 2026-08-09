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
 * Valid input, but processing failed unexpectedly.
 *
 * Separate from the above because this one MIGHT succeed on retry — it usually
 * means something went wrong rather than something was wrong.
 */
export class PdfProcessingError extends SealingError {
  readonly code = "pdf_processing_failed" as const;
  readonly retryable = true;
}
