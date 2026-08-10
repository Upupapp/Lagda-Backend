// Document persistence ports (BACKEND-29).
//
// ── The shape of this file is the point ────────────────────────────────────
//
// A document has one mutable field and no lifecycle, so the repository has one
// mutation and no state transitions. Everything else a document "has" — its
// bytes, size, media type, page count, digest — belongs to an ARTIFACT, and is
// reached through the existing artifact repository rather than copied here.
//
// ── Methods that are deliberately absent ───────────────────────────────────
//
//   archive() / restore()   The product archives TRANSACTIONS, not documents.
//                           `TransactionFile` has no `archivedAt`.
//   delete()                No delete exists at either level, and the runtime
//                           role has no DELETE grant on `documents`.
//   setStatus()             §206. A document has no status; the one the UI
//                           shows belongs to the signing request.
//   findById(documentId)    without a workspace. §202 — there is no global
//                           document lookup, and BACKEND-42's public
//                           verification path reads verification records, not
//                           documents.
//   linkArtifact()          The upload pipeline writes the artifact with its
//                           `document_id`. A second way to attach bytes would
//                           be a second way to get it wrong.

import type { DocumentId, WorkspaceId, UserId, DocumentSortField } from "@lagda/contracts";

/**
 * A document row.
 *
 * No `originalArtifactId` column and no artifact metadata. The link lives on
 * the ARTIFACT (`document_artifacts.document_id`), where migration 003 put it
 * and where migration 016 made it a tenant-safe foreign key — so a document
 * row is metadata only and the artifact table stays the single authority on
 * which bytes exist. See DOCUMENT_ARTIFACT_MODEL.md for why the relation is not
 * duplicated as a column here.
 */
export interface DocumentRecord {
  readonly documentId: DocumentId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly originalFilename: string | null;
  /** Audit metadata. Documents are owned by the workspace, not by this user. */
  readonly createdByUserId: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewDocument {
  readonly documentId: DocumentId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly originalFilename: string | null;
  readonly createdByUserId: UserId;
  readonly createdAt: number;
}

export interface DocumentListQuery {
  readonly sort: DocumentSortField;
  readonly direction: "asc" | "desc";
  readonly offset: number;
  readonly limit: number;
}

export interface DocumentPage {
  readonly items: readonly DocumentRecord[];
  /** Counted in the same transaction as the page, so the two cannot disagree. */
  readonly total: number;
}

/**
 * Document persistence, bound to ONE workspace and ONE transaction.
 *
 * No method takes a workspace argument, so "read another tenant's documents" is
 * not a call that can be written — and RLS refuses it independently.
 */
export interface ScopedDocumentRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(document: NewDocument): Promise<void>;

  /**
   * One document, or null.
   *
   * A document in another workspace is indistinguishable from one that does not
   * exist. Any difference would confirm it exists elsewhere (§117).
   */
  findById(documentId: DocumentId): Promise<DocumentRecord | null>;

  list(query: DocumentListQuery): Promise<DocumentPage>;

  /**
   * Changes the title. The only mutation a document has.
   *
   * `rename`, not `update(patch)`. A generic patch is how `{ workspaceId }`
   * moves a document between tenants and `{ createdAt }` rewrites history —
   * §207 forbids it and INV-306 banned the same shape on accounts.
   *
   * Returns whether it applied. Zero rows means absent or another tenant, and
   * the caller reports neither.
   */
  rename(input: {
    readonly documentId: DocumentId;
    readonly title: string;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Records the filename the document's bytes arrived as.
   *
   * Separate from `rename` because it is a DIFFERENT fact set by a DIFFERENT
   * actor: the upload pipeline observed it, a user did not choose it, and it is
   * written once when the original artifact lands. Folding it into `rename`
   * would let a client set the filename LAGDA claims to have received.
   *
   * Conditional on the filename being unset, so a second upload cannot rewrite
   * the provenance of the first.
   */
  recordOriginalFilename(input: {
    readonly documentId: DocumentId;
    readonly originalFilename: string;
    readonly now: number;
  }): Promise<boolean>;
}

export interface DocumentIdGenerator {
  nextDocumentId(): DocumentId;
}
