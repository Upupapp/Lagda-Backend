// Document use cases (BACKEND-29).
//
// ── What a document is here ────────────────────────────────────────────────
//
// A stable workspace-owned identity that outlives every set of bytes attached
// to it. It acquires an ORIGINAL artifact from the secure upload pipeline, and
// will later acquire a SEALED one and a CERTIFICATE — three artifacts, three
// digests, one `DocumentId`.
//
// ── Document-first, and why the order is forced ────────────────────────────
//
// `CreateDocument` writes metadata and NO bytes. The upload comes afterwards,
// because BACKEND-18 takes a `documentId` as input and the storage key is
// `{workspaceId}/{documentId}/{artifactId}` — the identity has to exist before
// the object can be filed. See DOCUMENT_ARTIFACT_MODEL.md.
//
// The consequence is visible in this file: `source` is nullable everywhere. A
// document between creation and a successful upload genuinely has no bytes, and
// that is a state rather than an error.
//
// ── What this module cannot do ─────────────────────────────────────────────
//
// It imports no PDF library, no storage provider and no sealer. It reads
// artifact METADATA through the artifact repository and never a byte. An
// architecture guard asserts all of that.

import type { DocumentId, WorkspaceId, DocumentSortField } from "@lagda/contracts";
import { DEFAULT_PER_PAGE } from "@lagda/contracts";
import {
  validateDocumentTitle, titleFromFilename, type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  DocumentIdGenerator, DocumentRecord, ArtifactRecord,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";

// ── Projections ──────────────────────────────────────────────────────────────

/**
 * The safe metadata of a document's original artifact.
 *
 * Deliberately NOT the artifact record. That carries `storageReference` — an
 * internal capability-bearing key (INV-205) — and `artifactId`, and returning
 * the row because it happened to be loaded is exactly how a storage key reaches
 * a response body. This type has no field that could.
 *
 * No digest either: nothing in the product displays one, and publishing a
 * SHA-256 because a column holds one is the accident §194 warns about.
 */
export interface DocumentSourceView {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly pageCount: number | null;
  readonly uploadedAt: number;
}

export interface DocumentSummary {
  readonly documentId: DocumentId;
  readonly title: string;
  readonly originalFilename: string | null;
  readonly createdByUserId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Null until the secure upload pipeline has accepted this document's bytes. */
  readonly source: DocumentSourceView | null;
}

/**
 * Projects an artifact to the safe subset, or null.
 *
 * The ONE place an artifact becomes client-visible, so there is one place to
 * audit rather than a spread at every call site.
 */
function toSource(artifact: ArtifactRecord | undefined): DocumentSourceView | null {
  if (artifact === undefined) return null;
  return {
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    pageCount: artifact.pageCount ?? null,
    uploadedAt: artifact.createdAt,
  };
}

const summarize = (
  record: DocumentRecord,
  original: ArtifactRecord | undefined,
): DocumentSummary => ({
  documentId: record.documentId,
  title: record.title,
  originalFilename: record.originalFilename,
  createdByUserId: record.createdByUserId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  source: toSource(original),
});

export interface DocumentDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: DocumentIdGenerator;
}

// ── The transactional authorization frame ────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member, or no longer one. The same hidden 404 as everywhere else, so
  // "this workspace is not yours" and "you may not do that here" are one answer.
  if (membership === null) throw new ResourceNotFoundError("Workspace");

  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
  assertCapability(access, capability);
  return access;
}

/**
 * The ORIGINAL artifact of a document, if its bytes have landed.
 *
 * Reads through the artifact repository, which is workspace-scoped by the same
 * unit of work — so a document can never be paired with another tenant's bytes,
 * and migration 016's compound foreign key means the pairing could not have been
 * written in the first place.
 */
async function originalArtifact(
  uow: WorkspaceUnitOfWork,
  documentId: DocumentId,
): Promise<ArtifactRecord | undefined> {
  const artifacts = await uow.artifacts.listForDocument(documentId);
  return artifacts.find(artifact => artifact.artifactType === "original");
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateDocumentInput {
  /**
   * Optional. When absent the document is titled from its filename later, or
   * by the caller — see `titleFromFilename` for why the PDF's own `/Title` is
   * never used.
   */
  readonly title?: string;
}

/**
 * Adds a document to the workspace, ahead of its bytes.
 *
 * ── What the caller may NOT supply ─────────────────────────────────────────
 *
 * A title. That is the whole input. No `artifactId`, no `storageKey`, no
 * `bucket`, no `sha256`, no `sizeBytes`, no `mediaType`, no `pageCount`, no
 * `malwareScanStatus`, no `createdAt`, no `workspaceId`, no status. Every one of
 * those is either server-observed by the upload pipeline or derived from the
 * request path, and the request schema cannot express any of them.
 *
 * ── Not idempotency-keyed, and why ─────────────────────────────────────────
 *
 * §68 asks for idempotency on document creation, and the reasoning there
 * assumes the artifact-first model: a retry that re-consumes an accepted upload
 * could produce two documents from one set of bytes.
 *
 * Document-first inverts the risk. A retry here creates a second EMPTY document
 * — no bytes, no artifact, no storage cost, nothing claimed — and the upload
 * that follows names exactly one `documentId`, so the bytes land on exactly one
 * document. The duplicate is a metadata row a user can ignore, and the one that
 * matters is protected by migration 016's `document_artifacts_one_original_idx`:
 * two uploads cannot both become the original of one document.
 *
 * So the claim that needs protecting is the ARTIFACT claim, and it is protected
 * by a database constraint rather than by a client-supplied key. Recorded here
 * rather than silently skipped.
 */
export async function createDocument(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: CreateDocumentInput,
  deps: DocumentDependencies,
): Promise<DocumentSummary> {
  // Validated BEFORE the transaction. A malformed title should not hold a
  // database connection while it is rejected.
  const title = resolveTitle(input.title ?? null);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.create");

    const now = deps.clock.now();
    const documentId = deps.ids.nextDocumentId();

    await uow.documents.insert({
      documentId,
      workspaceId,
      title,
      // Unknown until the upload lands. Written once, by the pipeline.
      originalFilename: null,
      createdByUserId: actor.userId,
      createdAt: now,
    });

    const created = await uow.documents.findById(documentId);
    // Written and immediately unreadable would mean RLS refused the read-back,
    // i.e. tenant context and the insert disagree. Not a user-facing condition.
    if (created === null) throw new ResourceNotFoundError("Document");

    // No artifact yet, by construction. Passing `undefined` rather than reading
    // is deliberate: a lookup here would always return nothing and would read
    // like a bug the first time someone tried to make it return something.
    return summarize(created, undefined);
  });
}

function resolveTitle(raw: string | null): string {
  if (raw === null) {
    throw new ApplicationValidationError(
      "A document needs a title.", ["title: required"]);
  }
  const validated = validateDocumentTitle(raw);
  if (!validated.ok) {
    throw new ApplicationValidationError(
      "The document could not be saved.", [`title: ${validated.reason}`]);
  }
  return validated.value;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getDocument(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  deps: DocumentDependencies,
): Promise<DocumentSummary> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.view");
    const document = await uow.documents.findById(documentId);
    // A document in another workspace produces the same null as one that does
    // not exist. The repository is scoped and RLS refuses it independently.
    if (document === null) throw new ResourceNotFoundError("Document");
    return summarize(document, await originalArtifact(uow, documentId));
  });
}

export interface ListDocumentsInput {
  readonly sort?: DocumentSortField;
  readonly direction?: "asc" | "desc";
  readonly page?: number;
  readonly perPage?: number;
}

export interface DocumentListResult {
  readonly items: readonly DocumentSummary[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly hasNextPage: boolean;
}

/**
 * Lists the workspace's documents.
 *
 * ── No filters, and that is the product's answer ───────────────────────────
 *
 * The page that looks like a document list is a TRANSACTION list, and every
 * filter it offers — `drafts`, `in-progress`, `completed`, `expiring` — selects
 * on `TransactionStatus`. A document has no status to filter on, and adding one
 * so the list could offer filters is precisely the inversion §33 forbids.
 *
 * ── Newest first ───────────────────────────────────────────────────────────
 *
 * `createdAt desc`, matching the product's `DEFAULT_QUERY` ordering intent, with
 * `documentId` as the tie-breaker so pagination is stable when a batch upload
 * writes several documents in one transaction.
 */
export async function listDocuments(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: ListDocumentsInput,
  deps: DocumentDependencies,
): Promise<DocumentListResult> {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? DEFAULT_PER_PAGE;

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.view");

    const result = await uow.documents.list({
      sort: input.sort ?? "createdAt",
      direction: input.direction ?? "desc",
      offset: (page - 1) * perPage,
      limit: perPage,
    });

    // Artifact metadata IS included, because the product's list shows page
    // count and file size (`TransactionFile`). One query per page rather than
    // per row would be better and needs a repository method that does not exist
    // yet; with `perPage` bounded at 100 this is bounded work, and the
    // alternative — omitting the fields — would make the list unable to render.
    const items: DocumentSummary[] = [];
    for (const record of result.items) {
      items.push(summarize(record, await originalArtifact(uow, record.documentId)));
    }

    return {
      items,
      total: result.total,
      page,
      perPage,
      hasNextPage: page * perPage < result.total,
    };
  });
}

// ── Rename ───────────────────────────────────────────────────────────────────

/**
 * Changes a document's title. The only mutation a document has.
 *
 * ── Renaming never touches bytes ───────────────────────────────────────────
 *
 * This function writes one `varchar` column. It does not open the PDF, does not
 * re-hash anything, and cannot: the module imports no storage client and no PDF
 * library. The artifact's digest, size, media type and storage reference are
 * untouched by construction, and an integration test asserts the digest before
 * and after a rename.
 *
 * That matters beyond tidiness. A document renamed after signing must leave the
 * completed artifact and its hash exactly as they were, or the completion
 * certificate stops matching the thing it certifies. BACKEND-32's evidence will
 * snapshot whatever display text it needs at the time; it will not read this
 * column later. DOCUMENT_ARTIFACT_MODEL.md.
 *
 * ── Renaming is allowed at any time ────────────────────────────────────────
 *
 * The product's action is `rename-draft`, which suggests drafts only — but
 * "draft" there is a TRANSACTION status, and this command deliberately does not
 * know about transaction status (§33). Once BACKEND-32 exists, whether a
 * document attached to a sent transaction may be renamed is a decision it can
 * make with the state to make it. Inventing the restriction now would mean
 * inventing the state it depends on.
 */
export async function renameDocument(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  title: string,
  deps: DocumentDependencies,
): Promise<DocumentSummary> {
  const validated = resolveTitle(title);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.update");

    const applied = await uow.documents.rename({
      documentId, title: validated, now: deps.clock.now(),
    });
    // Absent or another tenant. Deliberately one answer.
    if (!applied) throw new ResourceNotFoundError("Document");

    const renamed = await uow.documents.findById(documentId);
    if (renamed === null) throw new ResourceNotFoundError("Document");
    return summarize(renamed, await originalArtifact(uow, documentId));
  });
}

/**
 * Records the filename a document's bytes arrived as.
 *
 * Called by the upload composition AFTER the pipeline accepts an artifact, not
 * by a client — there is no route for it. Write-once at the repository, so a
 * second upload cannot rewrite the provenance of the first.
 *
 * Best-effort by design: a document with an accepted artifact and no recorded
 * filename is cosmetically incomplete, and failing the upload over it would
 * discard validated bytes for a display string.
 */
export async function recordDocumentFilename(
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  originalFilename: string,
  deps: DocumentDependencies,
): Promise<void> {
  await deps.transactions.runForWorkspace(workspaceId, uow =>
    uow.documents.recordOriginalFilename({
      documentId, originalFilename, now: deps.clock.now(),
    }));
}

/** Exported for the upload composition, which needs it before a title exists. */
export { titleFromFilename };

/**
 * Deliberately absent from this module.
 *
 * **archiveDocument / restoreDocument** — the product archives TRANSACTIONS.
 * `TransactionFile` has no `archivedAt` and no status. BACKEND-32 owns it.
 *
 * **deleteDocument** — no delete exists at either level, the runtime role has
 * no DELETE grant on `documents`, and a document is referenced by immutable
 * artifacts and soon by signing evidence. DOCUMENT_DELETION_POLICY.md, OD-113.
 *
 * **downloadDocument** — not in the product. `TransactionDetailPage.tsx`
 * imports a `Download` icon and never uses it. Building it would mean deciding
 * between streaming and presigned URLs, and a presigned URL is a bearer
 * credential that needs its own security review (OD-114).
 *
 * **replaceOriginal / duplicateDocument / searchDocuments** — none exists in
 * the product at document level (OD-115, OD-116).
 *
 * **setStatus** — a document has no status. §206.
 */
export type DocumentOperationsDeferred = never;
