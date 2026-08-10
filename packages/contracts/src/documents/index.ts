// The document contract.
//
// ── A Document is not its bytes ────────────────────────────────────────────
//
// `DocumentId` is a stable business identity. `ArtifactId` names one exact
// sequence of bytes. A document keeps its id while acquiring an original, then
// a sealed version, then a completion certificate — three artifacts, three
// digests, one document.
//
// So there is no `storageKey`, no `bucket`, no `sha256` and no `artifactId`
// masquerading as a document identifier anywhere in this file. See ADR-022.
//
// ── No lifecycle state, and that is a finding rather than an omission ──────
//
// The product has none at the document level. Every status LAGDA displays is a
// `TransactionStatus` — draft, sent, completed, declined — and those belong to
// the signing transaction, which is BACKEND-32. `TransactionFile`, the
// product's real per-document shape, carries no status and no `archivedAt`.
//
// Publishing a document status now would mean either inventing one or copying
// the signing vocabulary onto a resource that does not have it, and a client
// that branched on it would be reading a second, staler answer to a question
// the signing-request API already answers.

import { Type, type Static } from "@sinclair/typebox";
import { DocumentIdSchema } from "../ids/index.js";

// ── Field limits ─────────────────────────────────────────────────────────────

/**
 * Stated in Unicode CODE POINTS, matching the column.
 *
 * 300 rather than the 200 used for workspace and contact names: a document
 * title is routinely a sentence — "Retainer Agreement — Mabini Business
 * Services" is already 48 — and the product's own fixtures run long.
 */
export const DOCUMENT_TITLE_MAX_LENGTH = 300;
export const DOCUMENT_TITLE_MIN_LENGTH = 1;

/** Matches `document_uploads.original_filename`. Display metadata only. */
export const DOCUMENT_FILENAME_MAX_LENGTH = 255;

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * A CLOSED list, each with a supporting index.
 *
 * Two, not the product's five. `DocumentSortField` in the frontend offers
 * `updated | created | title | status | expiry` — but that sorts TRANSACTIONS,
 * and `status` and `expiry` are transaction fields a document does not have.
 * Offering them here would be publishing a sort key with nothing behind it.
 */
export const DOCUMENT_SORT_FIELDS = ["createdAt", "title"] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export const DocumentSortFieldSchema = Type.Union(
  DOCUMENT_SORT_FIELDS.map(field => Type.Literal(field)),
  { title: "DocumentSortField" },
);

export const DEFAULT_DOCUMENT_SORT: DocumentSortField = "createdAt";

// ── The wire shape ───────────────────────────────────────────────────────────

/**
 * The safe metadata of a document's original artifact.
 *
 * ── Read the absences ──────────────────────────────────────────────────────
 *
 * No `storageReference`, no bucket, no presigned URL, no artifact id, no
 * quarantine state, no scanner outcome, no provider ETag. A storage key is an
 * internal capability-bearing string (INV-205) and the scan outcome is
 * operational security history — neither is a client's business, and both would
 * arrive here by accident if a repository row were serialized directly.
 *
 * No `digest` either. The product does not display one: `TransactionFile`
 * carries an `integrityState` enum whose values are `"…-demo"`, and exposing a
 * real SHA-256 because a column happens to hold one is exactly the accident
 * §194 warns about. When verification needs it (BACKEND-42), it is published
 * deliberately, from the seal.
 *
 * Every field here is SERVER-OBSERVED: the size LAGDA counted, the media type
 * LAGDA detected, the pages LAGDA's inspector found. None was supplied by a
 * client, and none can be.
 */
export const DocumentSourceSchema = Type.Object(
  {
    /** What LAGDA detected from the content. Never what the browser claimed. */
    mediaType: Type.String(),
    /** Bytes LAGDA counted while streaming. Never a client-declared length. */
    sizeBytes: Type.Integer({ minimum: 0 }),
    /** From the upload inspection. Null for a document with no original yet. */
    pageCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    uploadedAt: Type.String({ format: "date-time" }),
  },
  { title: "DocumentSource", additionalProperties: false },
);
export type DocumentSource = Static<typeof DocumentSourceSchema>;

/**
 * A document.
 *
 * `source` is nullable, and that is the one part of this contract that needs
 * explaining. A document is created before its bytes are uploaded — the storage
 * key embeds the `documentId`, so the identity has to exist first — and between
 * those two moments the document genuinely has no original artifact.
 *
 * Modelled as `null` rather than hidden behind a lifecycle flag, because it is
 * the honest shape: a client rendering a document with no source should show it
 * as awaiting its file, not as broken. DOCUMENT_LIFECYCLE.md.
 */
export const DocumentSchema = Type.Object(
  {
    documentId: DocumentIdSchema,
    /** Mutable display metadata. Never a storage key, never an identity. */
    title: Type.String({ minLength: DOCUMENT_TITLE_MIN_LENGTH }),
    /**
     * The name the file arrived as. SEPARATE from the title, because the
     * product's own `TransactionFile` carries both: renaming to "Office Lease"
     * leaves "lease-v4-final.pdf" intact.
     */
    originalFilename: Type.Union([Type.String(), Type.Null()]),
    /** Audit metadata. NOT authorization — documents are owned by the workspace. */
    createdByUserId: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    /** Null until the secure upload pipeline has accepted this document's bytes. */
    source: Type.Union([DocumentSourceSchema, Type.Null()]),
  },
  {
    title: "Document",
    additionalProperties: false,
    description:
      "A workspace-owned document. Its identity is stable across every "
      + "artifact its lifecycle produces.",
  },
);
export type Document = Static<typeof DocumentSchema>;

// Note the absent fields: `workspaceId` (it is the URL path), `artifactId`,
// `storageKey`, `digest`, and any signing status. The first is INV-003; the
// rest are ADR-022 and §33.
