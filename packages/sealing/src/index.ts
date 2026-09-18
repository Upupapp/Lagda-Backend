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

/**
 * `sha256`, exported for the UPLOAD pipeline — and against the grain of every
 * note above, so the reasoning belongs here.
 *
 * Those notes withhold it because exporting it "would give callers a way to
 * hash a document without sealing it". Upload must do exactly that: it accepts
 * bytes that nobody has signed, and the digest it stores is the content
 * identity a later seal and a later verification are compared against.
 *
 * The alternative is a second implementation in the upload adapter, and that
 * is the failure INV-080 exists to prevent: "one implementation, so hex vs
 * base64 cannot disagree across layers". Two hashers agreeing today and
 * diverging in a refactor produces a verification comparison that silently
 * never matches -- a worse outcome than a wider export surface.
 *
 * So the narrow-surface rule yields to the one-implementation rule, which is
 * the stronger of the two. `mergeFields` and `renderCertificate` stay private:
 * neither has a caller outside the sealer.
 */
export { sha256 } from "./internal/digest.js";

/**
 * `signatureTextProblem`, exported for SUBMISSION — and, like `sha256` above,
 * against the narrow-surface rule, so the reasoning belongs here too.
 *
 * The merge refuses text the signature face cannot draw, and refuses it
 * TERMINALLY: `unrenderable_text` maps to `unrenderable-value`, which
 * `COMPLETION_FAILURE_CLASSIFICATION` classes as terminal. That is the right
 * call at merge time — retrying identical text fails identically — but the
 * merge runs in the completion pipeline, long after the signer has closed the
 * tab. So a name the face cannot draw was accepted at signing, failed the
 * completion run permanently, and left the signer believing they had signed a
 * document that would never complete.
 *
 * Closing that means asking the same question earlier, while the signer is
 * still present. The alternative — a charset check written independently in
 * the application layer — is the failure INV-080 describes for digests: two
 * definitions that agree today and diverge the first time a face is changed,
 * restoring the gap without anything failing a test.
 *
 * So the narrow-surface rule yields to the one-implementation rule, exactly as
 * it does for `sha256`. The BOUND form is exported and the face name is not:
 * a caller cannot probe the wrong face, because there is no parameter to get
 * wrong. `mergeFields` and `renderCertificate` stay private.
 *
 * It answers RENDERABILITY, not glyph coverage, and the distinction is the
 * reason this export exists in its current shape. Coverage alone accepts
 * Devanagari that the merge refuses — every glyph is present, and fontkit's
 * Indic shaper then throws inside `widthOfTextAtSize`. Layout alone accepts
 * CJK that renders as blank boxes. Only the conjunction matches what the
 * merger actually does.
 */
export {
  signatureTextProblem, type SignatureTextProblem,
} from "./internal/fonts.js";

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
