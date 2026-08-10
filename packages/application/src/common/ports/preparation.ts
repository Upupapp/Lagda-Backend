// Document preparation ports (BACKEND-30).
//
// ── One mutation, and why ──────────────────────────────────────────────────
//
// `replaceLayout` writes the whole field set at once. The product's editor is a
// drag-and-drop canvas that autosaves: per-field endpoints would mean a request
// per drag frame, partial save states, and a layout that can be observed
// half-applied.
//
// The cost is that a stale tab could erase another's work, which is what
// `expectedRevision` exists to prevent. §102 says choose one model deliberately
// rather than shipping both; this is the choice and PREPARATION_ARCHITECTURE.md
// records the trade.
//
// ── Methods that are deliberately absent ───────────────────────────────────
//
//   addField / updateField / deleteField   the other mutation model
//   lock() / freeze()                       BACKEND-32's, when it has the state
//                                           that triggers it
//   findByPreparationId(id)                 no unscoped lookup (§138)
//   delete()                                the product has no "clear
//                                           preparation"; an empty field array
//                                           through `replaceLayout` is how a
//                                           sender clears one

import type { DocumentId, WorkspaceId, PreparationFieldType } from "@lagda/contracts";

/** Opaque, server-generated. Never an array index (§28). */
export type PreparationId = string & { readonly __brand: "PreparationId" };
export type PreparationFieldId = string & { readonly __brand: "PreparationFieldId" };

/**
 * A placed field, as persisted.
 *
 * No `value`, no `signedAt`, no signer data of any kind. Preparation records
 * the requirement; what a signer supplies belongs to the ceremony.
 */
export interface PreparationFieldRecord {
  readonly fieldId: PreparationFieldId;
  readonly type: PreparationFieldType;
  /** 1-based, matching `SealableField.pageNumber` and the product. */
  readonly pageNumber: number;
  /** Normalized 0–1, top-left origin. `y` is to the field's TOP edge. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  readonly label: string;
  /** z-order; higher draws on top. */
  readonly layer: number;
  /**
   * The editor's participant slot. **Not an identity** — see the contract.
   *
   * No foreign key, because there is nothing to point at until BACKEND-31.
   */
  readonly participantSlot: string | null;
}

export interface PreparationRecord {
  readonly preparationId: PreparationId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  /** The EXACT artifact the coordinates were authored against. */
  readonly sourceArtifactId: string;
  readonly revision: number;
  /** NULL means editable. Nothing in BACKEND-30 sets it. */
  readonly lockedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewPreparation {
  readonly preparationId: PreparationId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly sourceArtifactId: string;
  readonly createdAt: number;
}

/**
 * Preparation persistence, bound to ONE workspace and ONE transaction.
 *
 * No method takes a workspace argument.
 */
export interface ScopedPreparationRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(preparation: NewPreparation): Promise<void>;

  /**
   * The document's preparation, or null.
   *
   * Keyed on the DOCUMENT rather than the preparation id, because there is at
   * most one per document and every caller arrives holding a document.
   */
  findByDocument(documentId: DocumentId): Promise<PreparationRecord | null>;

  /**
   * The fields, in deterministic order: page, then layer, then id.
   *
   * Ordered in SQL. PostgreSQL guarantees nothing otherwise, and a layout whose
   * z-order depends on physical row order would render differently after a
   * vacuum (§76).
   */
  listFields(preparationId: PreparationId): Promise<readonly PreparationFieldRecord[]>;

  /**
   * Replaces the entire field set, conditionally on revision AND editability.
   *
   * ── Both conditions, inside the transaction ────────────────────────────────
   *
   * `expectedRevision` is the concurrency check: the client sends the revision
   * it read, and a stale tab matches zero rows instead of erasing newer work.
   *
   * Editability is checked in the SAME statement rather than beforehand,
   * because a freeze committing between a check and a write is exactly the race
   * §158 and §159 describe.
   *
   * Returns the new revision, or null if it did not apply. Null is deliberately
   * ambiguous — stale revision, locked, absent, or another tenant — and the
   * caller distinguishes only what it needs to.
   */
  replaceLayout(input: {
    readonly preparationId: PreparationId;
    readonly expectedRevision: number;
    readonly fields: readonly PreparationFieldRecord[];
    readonly now: number;
  }): Promise<number | null>;
}

export interface PreparationIdGenerator {
  nextPreparationId(): PreparationId;
  nextPreparationFieldId(): PreparationFieldId;
}
