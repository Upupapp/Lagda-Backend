// The document sealing seam.
//
// BACKEND-00 built the architecture around this boundary: one high-level
// operation, so a future Java or .NET signer replaces the implementation
// without any caller changing. Everything here is LAGDA-owned — no `pdf-lib`
// type, no Node `Buffer`, no storage handle, no database row.
//
// THREE seams now live in `@lagda/sealing`, each with exactly one caller in the
// completion pipeline: `DocumentSealer` (this file), `FieldMerger` (BACKEND-39,
// below) and `CompletionCertificateGenerator` (BACKEND-40, in
// `completion-certificate.ts`). They are separate interfaces rather than methods
// on one, so a remote signing service replacing `DocumentSealer` does not also
// have to implement field rendering and certificate layout — which stay local.
//
// `hashDocument` remains a private collaborator and is not exposed: a caller
// able to hash without sealing, or seal without hashing, is what INV-002 exists
// to prevent.

import type {
  WorkspaceId, DocumentId, TransactionId, Sha256Digest,
} from "@lagda/contracts";

// ── Binary documents ─────────────────────────────────────────────────────────

/**
 * Document bytes.
 *
 * `Uint8Array`, not Node's `Buffer`. `Buffer` is a Node-only type, and putting
 * it in the seam would mean a remote signer implemented in another runtime
 * could not satisfy the same contract. The Node adapter converts internally.
 */
export type DocumentBytes = Uint8Array;

// ── Fields ───────────────────────────────────────────────────────────────────

/**
 * Field types the sealer can render.
 *
 * Only what the product actually has. No radio, attachment, formula, payment or
 * notary seal — inventing rendering for a field type nobody can create produces
 * untested code that looks supported.
 */
export const SEALABLE_FIELD_TYPES = [
  "signature", "initials", "text", "date", "checkbox",
] as const;
export type SealableFieldType = (typeof SEALABLE_FIELD_TYPES)[number];

/**
 * Where a field sits, in the frontend's normalized coordinate space.
 *
 * **Origin is TOP-LEFT**, values are 0–1 of the page. PDF's native origin is
 * BOTTOM-LEFT, so the adapter flips the Y axis. That conversion happens in
 * exactly one place — see `docs/backend/sealing/PDF_COORDINATE_MODEL.md`.
 * Duplicating it across layers is how a signature ends up upside down on one
 * path and correct on another.
 */
export interface NormalizedFieldRect {
  /** 0–1 from the LEFT edge. */
  readonly x: number;
  /** 0–1 from the TOP edge. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `SealableField` is GONE — OD-162, closed by BACKEND-39.
 *
 * `seal()` used to take completed field values and render them. It no longer
 * does: the `field-merge` step renders them and produces a `merged-candidate`
 * artifact, and `seal()` receives that already-rendered document.
 *
 * Leaving the parameter in place would have been worse than removing it. Once
 * `field-merge` renders the fields, a `seal()` that still renders them draws
 * every value a SECOND time, one drawn over the other — and that reads as a
 * font-weight or double-strike bug, not as an architecture bug. Nobody would
 * look here.
 *
 * The renderable-type vocabulary above stays: `renderTypeFor` in
 * `@lagda/core` collapses the product's nine preparation field types onto it,
 * and that mapping is unaffected by which component does the drawing.
 */
export type SealableFieldRemoved = never;

/**
 * `CompletionEvidence` and `CertificateParticipant` are GONE — OD-167.
 *
 * They existed so `seal()` could render the certificate. BACKEND-40 owns the
 * certificate now, and its curated model lives in `completion-certificate.ts`
 * where it can carry authentication, consent and ceremony facts these shapes
 * never had.
 *
 * Removed rather than left unread: a field nobody consumes is an invitation for
 * the next implementer to start consuming it, and this one would have handed
 * the sealer a second, weaker view of the same evidence.
 */
export type CompletionEvidenceRemoved = never;

// ── Request ──────────────────────────────────────────────────────────────────

export interface SealRequest {
  readonly workspaceId: WorkspaceId;
  readonly transactionId: TransactionId;
  readonly documentId: DocumentId;

  /**
   * The `merged-candidate` the `field-merge` step produced — every accepted
   * field value already rendered onto the frozen source document.
   *
   * **Renamed from `preparedDocument` by BACKEND-41.** BACKEND-39 kept the old
   * name on the grounds that `preparedDocumentHash` was a published digest and
   * the pair had to agree. Nothing had actually published it yet:
   * `recordFinalization` had no caller, and BACKEND-41 is the command that
   * publishes it for the first time. So this was the last moment the rename was
   * free, and a field named "prepared" carrying merged bytes is exactly how the
   * certificate came to print a hash under a label naming an artifact LAGDA has
   * never produced.
   *
   * Supplied by the caller — the sealer never fetches from object storage, so a
   * future remote signer needs no knowledge of LAGDA's storage topology.
   */
  readonly mergedDocument: DocumentBytes;

  /**
   * The accepted `completion-certificate` artifact's bytes.
   *
   * A SEMANTIC input, deliberately — not an `appendPages()` call. §21 and §22:
   * page-level composition must not escape the sealing package, and the seam
   * must stay implementable by a future Java or .NET signer that has no pdf-lib.
   * The sealer is told WHAT to compose, never HOW.
   */
  readonly completionCertificate: DocumentBytes;

  /** Provenance, carried so the seal record can name the run that produced it. */
  readonly completionRunId: string;

  /**
   * `verificationId` is GONE from this seam — BACKEND-41.
   *
   * It was here so the certificate could print it, and the certificate no
   * longer does (BACKEND-40 removed that line: verification identity belongs to
   * BACKEND-41/42, and a certificate rendered before finalization has none).
   * That left the sealer destructuring a value it never read and echoing it
   * back — the fourth unread field this pipeline has accumulated, after
   * `SealableField`, `evidence` and the result's certificate.
   *
   * It is created in the FINALIZATION TRANSACTION now, beside the verification
   * record it identifies. That also makes retry-stability free rather than a
   * mechanism: the completion row is unique per request, the verification
   * record is written in the same transaction, so exactly one verification
   * identity can ever exist for a request — §54 and §63 satisfied by a
   * constraint instead of by remembering to reuse a value.
   */

  /** Supplied so output is reproducible and never depends on a hidden clock. */
  readonly sealedAt: string;
}

// ── Seal metadata ────────────────────────────────────────────────────────────

/**
 * How a sealed artifact was produced, recorded from the first record written.
 *
 * A discriminated union rather than an untyped bag: `sealScheme` is the
 * discriminant, so a record produced under one scheme stays interpretable after
 * another is introduced. Only the current variant exists — a speculative
 * certificate variant would be fields nobody writes.
 */
export interface HashEvidenceSealMetadata {
  readonly sealScheme: "hash-evidence";
  /**
   * The version of LAGDA's SEALING PROCEDURE — not an API version, not a
   * package version, not a document version. It increments when a change alters
   * how existing sealed artifacts must be interpreted.
   */
  readonly sealVersion: 1;
  readonly digestAlgorithm: "sha-256";
}

export type SealMetadata = HashEvidenceSealMetadata;

// ── Result ───────────────────────────────────────────────────────────────────

export interface SealResult {
  /** The final distributed document, fields rendered. A NEW artifact. */
  readonly sealedDocument: DocumentBytes;

  /**
   * No `completionCertificate` on the RESULT — OD-167, and note the asymmetry
   * with the request, which now has one.
   *
   * The request takes a certificate as an INPUT to compose. The result returns
   * none, because `seal()` does not PRODUCE certificates: BACKEND-40's
   * CERTIFICATE step does, as its own immutable artifact. A `seal()` that
   * returned one would hand completion two certificates with no way to tell
   * which was authoritative.
   *
   * Consuming one and producing one are different things, and only the second
   * was ever the problem.
   */

  /**
   * Digest of `mergedDocument` exactly as received.
   *
   * **NOT the original document's digest**, and the rename matters because the
   * persistence layer has a field that means exactly that.
   * `SealRecord.originalDocumentHash` is documented as "the original file at
   * upload" and feeds `verification_records`, which BACKEND-42 exposes
   * publicly. Wiring this value into it — the obvious move, by name and by
   * position, before the rename — would have published the merged candidate's
   * digest as the original's, permanently.
   *
   * The original's digest comes from the request's frozen `sourceArtifactId`
   * artifact row, which the finalization step reads directly.
   */
  readonly mergedDocumentHash: Sha256Digest;

  /**
   * Digest of `completionCertificate` exactly as received.
   *
   * Returned so the CALLER can verify both inputs against what the pipeline
   * recorded — §15 — without a general-purpose hash function existing outside
   * this package. `createHash` is confined to `@lagda/sealing` by an
   * architecture guard precisely so two layers cannot disagree about hex versus
   * base64, and exporting `sha256` would let any caller hash a document without
   * sealing it.
   *
   * The consequence is that verification happens immediately AFTER the seal
   * call rather than before it, and that is acceptable: the seal is a pure
   * function producing bytes in memory. Nothing is uploaded, no artifact row is
   * written and no request is completed until both digests have matched.
   */
  readonly completionCertificateHash: Sha256Digest;

  /**
   * Digest of `sealedDocument` — the exact bytes distributed.
   *
   * Computed AFTER every byte-changing step. Hashing before a later
   * modification and publishing that digest as final would make verification
   * fail against the document people actually hold.
   */
  readonly signedDocumentHash: Sha256Digest;

  readonly seal: SealMetadata;
}

/**
 * The one operation.
 *
 * Implemented today by `NodeDocumentSealer`. A `RemoteDocumentSealer` calling a
 * Java or .NET service would implement this same interface, and no caller would
 * change.
 */
export interface DocumentSealer {
  seal(request: SealRequest): Promise<SealResult>;
}

// ── Field merge (BACKEND-39) ─────────────────────────────────────────────────
//
// A SECOND seam, deliberately not a second method on `DocumentSealer`.
//
// The completion pipeline's `field-merge` step must produce a durable
// `merged-candidate` artifact WITHOUT invoking the sealer, and `DocumentSealer`
// is the one-operation boundary a remote signer replaces wholesale. Hanging
// `mergeFields` off it would mean a remote signing service had to implement
// field rendering to satisfy the interface — which is exactly backwards, since
// merging is the part that stays local.
//
// So: one package, two seams, one caller each. An architecture guard asserts
// `DocumentSealer` still declares exactly one method.
//
// **`seal()` still merges fields today (OD-162).** BACKEND-41 must narrow it
// when it wires this step in, or every field renders twice — and it will look
// like a font-weight bug rather than an architecture bug.

/**
 * A typed signature: text the signer entered, in one of FOUR server-known
 * styles.
 *
 * `styleIndex` selects the style. A client cannot name a font, a family or a
 * stylesheet — §60 — because there is nowhere in this shape to put one.
 */
export interface TypedSignatureRepresentation {
  readonly kind: "typed";
  readonly text: string;
  /** 0–3. Any other value is refused by the renderer, not clamped. */
  readonly styleIndex: number;
}

/**
 * A drawn signature: the raster the signer produced on the canvas.
 *
 * **This is the case the pre-BACKEND-39 renderer could not draw at all.** It
 * rendered `signature` fields with `drawText` in an oblique face — a typed
 * rendering — and a raster has no text to draw, so a drawn signature produced
 * nothing.
 *
 * Bytes are DECODED. Never a data URL and never base64: the
 * `data:image/png;base64,` prefix is transport formatting and is not evidence
 * of anything (§199).
 */
export interface RasterSignatureRepresentation {
  readonly kind: "raster";
  readonly bytes: DocumentBytes;
  /** `image/png`. The product's canvas emits nothing else, and §52 verifies it. */
  readonly mediaType: string;
  /** The raster's own pixel dimensions, used to preserve aspect ratio. */
  readonly width: number;
  readonly height: number;
}

export type SignatureRepresentation =
  | TypedSignatureRepresentation
  | RasterSignatureRepresentation;

/**
 * What a field renders.
 *
 * A discriminated union rather than one `value: string`, because a raster
 * signature is not a string and encoding it as one is how a drawn signature
 * silently became a typed one. The checkbox carries a `boolean` for the same
 * reason: `"false"` and `"FALSE"` and `""` are three strings and one intent.
 */
export type MergeableFieldValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "checkbox"; readonly checked: boolean }
  | { readonly kind: "signature"; readonly representation: SignatureRepresentation };

export interface MergeableField {
  /**
   * Identity, carried so rendering order is DETERMINISTIC and so a placement
   * error can name the field without naming its value.
   */
  readonly fieldId: string;
  /** **1-based**, matching the product. The adapter converts to pdf-lib's index. */
  readonly pageNumber: number;
  readonly rect: NormalizedFieldRect;
  readonly value: MergeableFieldValue;
}

export interface MergeFieldsRequest {
  /**
   * The EXACT bytes the signing request froze — its `sourceArtifactId`, not the
   * document's current artifact. Supplied by the caller; the merger never
   * fetches from storage.
   */
  readonly sourceDocument: DocumentBytes;
  readonly fields: readonly MergeableField[];
  /** Supplied so output is reproducible and never depends on a hidden clock. */
  readonly mergedAt: string;
}

export interface MergeFieldsResult {
  /**
   * The merged candidate. Fields rendered, NOT sealed.
   *
   * Named for what it is — §8 and §81 both forbid calling it final. It becomes
   * the input to the certificate and final-seal steps.
   */
  readonly mergedDocument: DocumentBytes;
  /** Digest of `sourceDocument` exactly as received, before anything touched it. */
  readonly sourceDocumentHash: Sha256Digest;
  /** Digest of `mergedDocument` — computed after every byte-changing step. */
  readonly mergedDocumentHash: Sha256Digest;
  /** How many fields were drawn. The caller checks it against what it sent. */
  readonly renderedFieldCount: number;
}

/**
 * Renders accepted values onto the source document.
 *
 * Never calls `DocumentSealer`, never touches storage, never reads a clock.
 */
export interface FieldMerger {
  mergeFields(request: MergeFieldsRequest): Promise<MergeFieldsResult>;
}
