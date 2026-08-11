// @lagda/sealing — the PDF sealing adapter.
//
// The public surface is deliberately narrow: one implementation and the error
// types a caller must handle. `internal/` is not exported — `mergeFields`,
// `renderCertificate` and `sha256` are collaborators of `seal()`, and exporting
// them would give callers a way to hash a document without sealing it, or seal
// a document without hashing it. The single `.` export in package.json is what
// stops a deep import from reaching them anyway.

export { NodeDocumentSealer } from "./node-document-sealer.js";

// The SECOND operation, added by BACKEND-39 for the `field-merge` step.
//
// Two exported operations, one caller each — not a widened surface. The
// completion pipeline is the only caller of either, and they are sequential
// stages of an orchestration that already exists. `internal/` remains private:
// `mergeFields`, `renderCertificate` and `sha256` are still collaborators, and
// exporting them would give callers a way to hash a document without merging
// it, or merge one without hashing it.
export { NodeFieldMerger } from "./node-field-merger.js";

// The THIRD operation, added by BACKEND-40 for the `certificate` step.
//
// Three exported operations, one caller each — all three in the completion
// pipeline. `internal/` remains private: the renderer, the merger internals and
// `sha256` are still collaborators, and exporting them would give callers a way
// to hash without producing an artifact, or render without hashing.
export {
  NodeCompletionCertificateGenerator,
} from "./node-completion-certificate-generator.js";

export {
  SealingError,
  InvalidPdfError,
  UnsupportedPdfError,
  InvalidFieldPlacementError,
  InvalidSealInputError,
  UnsupportedRepresentationError,
  TypefaceUnavailableError,
  UnrenderableTextError,
  PdfProcessingError,
} from "./errors/index.js";
export { createPdfInspector } from "./inspection/pdf-inspector.js";
export {
  buildTestPdf, buildTestPdfWithTrailingBytes, buildTestSignaturePng,
} from "./testing/fixtures.js";
