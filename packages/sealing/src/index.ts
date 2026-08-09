// @lagda/sealing — the PDF sealing adapter.
//
// The public surface is deliberately narrow: one implementation and the error
// types a caller must handle. `internal/` is not exported — `mergeFields`,
// `renderCertificate` and `sha256` are collaborators of `seal()`, and exporting
// them would give callers a way to hash a document without sealing it, or seal
// a document without hashing it. The single `.` export in package.json is what
// stops a deep import from reaching them anyway.

export { NodeDocumentSealer } from "./node-document-sealer.js";

export {
  SealingError,
  InvalidPdfError,
  UnsupportedPdfError,
  InvalidFieldPlacementError,
  InvalidSealInputError,
  PdfProcessingError,
} from "./errors/index.js";
export { createPdfInspector } from "./inspection/pdf-inspector.js";
export {
  buildTestPdf, buildTestPdfWithTrailingBytes,
} from "./testing/fixtures.js";
