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
  /**
   * Where it is filed, or null for the workspace ROOT.
   *
   * Null is a place, not an absence: migration 040 has one root and it is the
   * absence of a parent. That is the opposite of `DocumentListQuery.folderId`,
   * where null means NO FILTER -- the same name in two layers asking two
   * questions, which is worth the sentence it takes to say so.
   */
  readonly folderId: string | null;
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
  /**
   * Free-text over the title, or null for no filter.
   *
   * NULL rather than an empty string: "" is a search that matches everything,
   * and a caller who cleared the box should not be sending one.
   *
   * Bounded by the contract before it reaches here -- an unbounded term is an
   * unbounded LIKE pattern, which is a cheap way to make the database do
   * expensive work.
   */
  readonly search: string | null;
  /**
   * Restrict to one folder, or null for every folder.
   *
   * NULL means NO FILTER, not "documents in no folder". Those are different
   * questions and the second has no caller yet; conflating them would make
   * "show me everything" silently mean "show me the unfiled".
   */
  readonly folderId: string | null;
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
   * Files the document in a folder, or at the workspace root.
   *
   * `file`, not `update(patch)`, for the same reason `rename` is — see below.
   * Two narrow mutations, not one wide one.
   *
   * NULL IS THE ROOT, a real destination. Passing null is how a document is
   * un-filed, so this method cannot use "absent means unchanged": the caller
   * decides whether to call it at all.
   *
   * Does NOT validate the folder. Whether the folder exists, belongs to this
   * workspace and is still live is a rule, and rules live in the use case
   * where they can be stated once and tested without a database. The foreign
   * key is the backstop, not the check.
   *
   * Returns whether it applied. Zero rows means absent or another tenant, and
   * the caller reports neither.
   */
  file(input: {
    readonly documentId: DocumentId;
    readonly folderId: string | null;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Changes the title. The only mutation a document has.
   *
   * `rename`, not `update(patch)`. A generic patch is how `{ workspaceId }`
   * moves a document between tenants and `{ createdAt }` rewrites history —
   * §207 forbids it and INV-306 banned the same shape on accounts. `file` is a
   * second narrow mutation for the same reason, not a first patch.
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
