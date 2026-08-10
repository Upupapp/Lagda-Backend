// Document preparation use cases (BACKEND-30).
//
// ── What preparation is ────────────────────────────────────────────────────
//
// Authoring state: where a sender says WHAT will be asked for and WHERE. It is
// attached to a document, targets one exact immutable artifact, and produces no
// bytes at all.
//
// ── What this module cannot do ─────────────────────────────────────────────
//
// It imports no PDF library, no storage client and no sealer. It reads a page
// count and a rotation count from artifact METADATA and never opens a document.
// Placing a field writes rows; it does not touch the original by any path,
// because no path exists. Architecture guards assert each of those.
//
// ── Not a signing request ──────────────────────────────────────────────────
//
// No `sentAt`, no expiry, no recipient authentication, no signing status, and
// no submitted value. BACKEND-32 owns all of them, and it must SNAPSHOT this
// state rather than reading it live — see PREPARATION_EDITABILITY.md.

import type {
  DocumentId, WorkspaceId, PreparationFieldType, RecipientType,
} from "@lagda/contracts";
import {
  validateRect, roundRect, isValidPageNumber, canPlaceFields,
  validateFieldLabel, effectiveRequired, derivePreparationState,
  canHoldFields, PREPARATION_MAX_FIELDS,
  type PreparationState, type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  PreparationIdGenerator, PreparationRecord, PreparationFieldRecord,
  ArtifactRecord,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceConflictError,
  ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The layout was written against a revision that is no longer current.
 *
 * A distinct error because the caller CAN fix it: reload and re-apply. Folding
 * it into a generic conflict would leave a client retrying the same stale
 * payload forever.
 */
export class PreparationRevisionConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "preparation_revision_conflict";
  constructor() {
    super("This layout changed elsewhere. Reload and try again.");
  }
}

/**
 * The source PDF has rotated pages, so fields cannot be placed on it.
 *
 * A real product limitation, surfaced rather than hidden. See `canPlaceFields`
 * for why placing them anyway would silently misposition every field.
 */
export class RotatedDocumentError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_pages_rotated";
  constructor() {
    super("This document has rotated pages and cannot be prepared yet.");
  }
}

/** The document has no accepted bytes, so there is no page geometry to place against. */
export class DocumentNotReadyError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_has_no_source";
  constructor() {
    super("Upload the document's file before preparing it.");
  }
}

// ── Projections ──────────────────────────────────────────────────────────────

export interface PreparationFieldView {
  readonly fieldId: string;
  readonly type: PreparationFieldType;
  readonly pageNumber: number;
  readonly rect: {
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
  };
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
  readonly recipientId: string | null;
}

export interface PreparationView {
  readonly preparationId: string;
  readonly documentId: DocumentId;
  /** From the source artifact's inspection. Server-observed, never client input. */
  readonly pageCount: number;
  readonly state: PreparationState;
  readonly revision: number;
  readonly fields: readonly PreparationFieldView[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The one place a field record becomes client-visible.
 *
 * Note what is not here: `workspaceId`, `preparationId` per field, and the
 * source artifact id. The first is the URL, the second is the parent, and the
 * third is internal — a client that knew the artifact id would be one step from
 * asking for its storage key.
 */
const toFieldView = (field: PreparationFieldRecord): PreparationFieldView => ({
  fieldId: field.fieldId,
  type: field.type,
  pageNumber: field.pageNumber,
  rect: { x: field.x, y: field.y, width: field.width, height: field.height },
  required: field.required,
  label: field.label,
  layer: field.layer,
  recipientId: field.recipientId,
});

const toView = (
  preparation: PreparationRecord,
  pageCount: number,
  fields: readonly PreparationFieldRecord[],
): PreparationView => ({
  preparationId: preparation.preparationId,
  documentId: preparation.documentId,
  pageCount,
  state: derivePreparationState(preparation.lockedAt),
  revision: preparation.revision,
  fields: fields.map(toFieldView),
  createdAt: preparation.createdAt,
  updatedAt: preparation.updatedAt,
});

export interface PreparationDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: PreparationIdGenerator;
}

// ── Shared resolution ────────────────────────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
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
 * The document's ORIGINAL artifact — the geometry preparation targets.
 *
 * Resolved through the workspace-scoped artifact repository, so a document can
 * never be paired with another tenant's bytes; migration 016's compound foreign
 * key means the pairing could not have been written either.
 */
async function resolveSource(
  uow: WorkspaceUnitOfWork,
  documentId: DocumentId,
): Promise<ArtifactRecord> {
  const document = await uow.documents.findById(documentId);
  // Another tenant's document is indistinguishable from an absent one.
  if (document === null) throw new ResourceNotFoundError("Document");

  const artifacts = await uow.artifacts.listForDocument(documentId);
  const original = artifacts.find(artifact => artifact.artifactType === "original");
  // A document with no bytes is a normal BACKEND-29 state, and it is not a
  // document you can place fields on: there is no page count to validate
  // against and nothing to display behind them.
  if (original === undefined) throw new DocumentNotReadyError();

  if (original.pageCount === undefined) {
    // Inspected before BACKEND-29 persisted page counts. Refused rather than
    // guessed: the page bound must come from the server (§57).
    throw new DocumentNotReadyError();
  }
  // `?? null` so an artifact predating the rotation inspection is UNKNOWN, not
  // assumed unrotated. `canPlaceFields` refuses both.
  if (!canPlaceFields(original.rotatedPageCount ?? null)) {
    throw new RotatedDocumentError();
  }
  return original;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * The document's preparation, or an empty one.
 *
 * Returns a view with no `preparationId` persisted yet when nothing has been
 * saved — the editor opens on a document that has never been prepared, and
 * creating a row just because someone looked would leave empty preparations
 * behind every uploaded document (§92).
 *
 * Gated on `document.view`, not `document.prepare`: the layout is part of
 * looking at the document, and a reviewer who may read it may see where its
 * signatures go.
 */
export async function getDocumentPreparation(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  deps: PreparationDependencies,
): Promise<PreparationView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.view");
    const source = await resolveSource(uow, documentId);
    const pageCount = source.pageCount ?? 1;

    const preparation = await uow.preparations.findByDocument(documentId);
    if (preparation === null) {
      // Nothing saved yet. An empty layout at revision 0 — the client sends
      // that revision back on its first save, and `ensure` treats 0 as "create".
      return {
        preparationId: "",
        documentId,
        pageCount,
        state: "editable" as const,
        revision: 0,
        fields: [],
        createdAt: 0,
        updatedAt: 0,
      };
    }
    const fields = await uow.preparations.listFields(preparation.preparationId);
    return toView(preparation, pageCount, fields);
  });
}

// ── Save ─────────────────────────────────────────────────────────────────────

export interface FieldInput {
  /**
   * Omitted for a new field; the server generates one.
   *
   * Supplied to PRESERVE identity across a save — moving or resizing a field
   * keeps its id (§29). A client-supplied id is accepted only if it already
   * belongs to this preparation, so it can never reference another tenant's row
   * (§124).
   */
  readonly fieldId?: string;
  readonly type: PreparationFieldType;
  readonly pageNumber: number;
  readonly rect: {
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
  };
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
  /**
   * The recipient expected to complete this field (BACKEND-31).
   *
   * Replaced BACKEND-30's opaque slot. Validated against the preparation's OWN
   * recipients, so a well-formed id from another preparation is refused — and
   * a three-column foreign key refuses it independently.
   *
   * `null` while a layout is being built. Readiness is what requires it.
   */
  readonly recipientId?: string | null;
}

export interface SaveLayoutInput {
  readonly expectedRevision: number;
  readonly fields: readonly FieldInput[];
}

/**
 * Replaces the whole field layout.
 *
 * ── Why whole-layout rather than per-field ─────────────────────────────────
 *
 * The editor is a drag-and-drop canvas that autosaves. Per-field endpoints mean
 * a request per drag, partial save states, and a layout observable half-applied.
 * One atomic replace is simpler and matches how the editor thinks. §102 requires
 * choosing one model; this is it.
 *
 * ── Validation happens before ANY write ────────────────────────────────────
 *
 * Every field is validated first, so a bad rectangle in field 40 leaves the
 * previous layout completely untouched (§247). That is also why the geometry
 * rules live in `@lagda/core` — they can run before a transaction is open.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * `expectedRevision` is checked in the same UPDATE that claims the new one, and
 * editability is checked in that statement too. A second tab holding a stale
 * revision matches zero rows and is told to reload, rather than silently
 * erasing work it never saw.
 */
export async function saveDocumentPreparation(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  input: SaveLayoutInput,
  deps: PreparationDependencies,
): Promise<PreparationView> {
  if (input.fields.length > PREPARATION_MAX_FIELDS) {
    throw new ApplicationValidationError(
      "That layout has too many fields.",
      [`fields: at most ${String(PREPARATION_MAX_FIELDS)}`]);
  }

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");
    const source = await resolveSource(uow, documentId);
    const pageCount = source.pageCount ?? 1;

    const now = deps.clock.now();

    // Ensure the preparation exists, converging if a concurrent request won.
    const { preparation, created } = await ensurePreparation(
      uow, documentId, source, deps, now);

    // ── Reconciling "no preparation yet" with a row that starts at revision 1 ──
    //
    // A client that loaded a document with no preparation sends
    // `expectedRevision: 0` — correctly, because that is what it read. Lazy
    // creation then inserts at revision 1, so the client's 0 would never match.
    //
    // When THIS call created the row, the client's 0 was accurate and is
    // translated to the revision it now holds. When the row already existed,
    // the client's value stands — including the case where a racing first save
    // created it a moment ago, which SHOULD conflict: that other tab's fields
    // are already saved and this one would erase them.
    const expectedRevision = created ? preparation.revision : input.expectedRevision;

    // Identity: a client may only reuse an id that already belongs HERE.
    const existing = new Set(
      (await uow.preparations.listFields(preparation.preparationId))
        .map(field => field.fieldId));

    // The recipients a field may be assigned to: THIS preparation's, and only
    // those that may hold fields at all. Read inside the transaction, so a
    // recipient deleted a moment ago cannot be assigned; the three-column
    // foreign key refuses it independently if one is deleted after this read.
    const assignable = new Map(
      (await uow.recipients.list(preparation.preparationId))
        .map(recipient => [String(recipient.recipientId), recipient.type]));

    const fields = validateFields(input.fields, pageCount, existing, assignable, deps);

    const revision = await uow.preparations.replaceLayout({
      preparationId: preparation.preparationId,
      expectedRevision,
      fields,
      now,
    });

    if (revision === null) {
      // Stale revision, or locked. The preparation was resolved a moment ago,
      // so absence is not a realistic cause — and distinguishing further would
      // mean a second read that could itself be stale.
      throw new PreparationRevisionConflictError();
    }

    const saved = await uow.preparations.findByDocument(documentId);
    if (saved === null) throw new ResourceNotFoundError("Preparation");
    return toView(saved, pageCount, await uow.preparations.listFields(saved.preparationId));
  });
}

/**
 * Finds or creates the document's preparation.
 *
 * ── The creation race ──────────────────────────────────────────────────────
 *
 * Two autosaves can arrive together on a document that has never been prepared.
 * `UNIQUE (workspace_id, document_id)` means one insert wins; the loser catches
 * the violation and re-reads rather than failing (§156). Converging is right
 * because both callers wanted the same thing.
 */
async function ensurePreparation(
  uow: WorkspaceUnitOfWork,
  documentId: DocumentId,
  source: ArtifactRecord,
  deps: PreparationDependencies,
  now: number,
): Promise<{ readonly preparation: PreparationRecord; readonly created: boolean }> {
  const found = await uow.preparations.findByDocument(documentId);
  if (found !== null) return { preparation: found, created: false };

  const preparationId = deps.ids.nextPreparationId();
  try {
    await uow.preparations.insert({
      preparationId,
      workspaceId: uow.workspaceId,
      documentId,
      // The EXACT artifact these coordinates target. Not "the current PDF".
      sourceArtifactId: source.artifactId,
      createdAt: now,
    });
  } catch {
    // Lost the race. Re-read rather than propagate: the other request created
    // exactly the preparation this one was about to.
    const raced = await uow.preparations.findByDocument(documentId);
    if (raced === null) throw new ResourceConflictError("Could not open the preparation.");
    // NOT `created` — this request did not create it, so the caller's stale
    // expectation must still be checked against the winner's revision.
    return { preparation: raced, created: false };
  }
  const inserted = await uow.preparations.findByDocument(documentId);
  if (inserted === null) throw new ResourceNotFoundError("Preparation");
  return { preparation: inserted, created: true };
}

/**
 * Finds or creates a document's preparation, for callers outside this module.
 *
 * Exported for BACKEND-31: a recipient cannot exist without a preparation to
 * hold it, and the first recipient added to a never-prepared document must
 * create one. Sharing this rather than reimplementing it means the recipient
 * path inherits the source-artifact resolution, the rotation refusal and the
 * creation race unchanged — three behaviours a second implementation would get
 * subtly wrong.
 *
 * Note what it does NOT do: it does not touch the revision, and it does not
 * check editability. The caller decides what a frozen preparation means for the
 * operation it is performing.
 */
export async function ensurePreparationForDocument(
  uow: WorkspaceUnitOfWork,
  documentId: DocumentId,
  deps: PreparationDependencies,
  now: number,
): Promise<PreparationRecord> {
  const source = await resolveSource(uow, documentId);
  const { preparation } = await ensurePreparation(uow, documentId, source, deps, now);
  return preparation;
}

/**
 * Validates every field and returns the records to persist.
 *
 * Reports ALL problems at once, each naming the field's INDEX rather than its
 * label — an error message is a poor place for "Landlord signature", which
 * names a party to the agreement.
 */
function validateFields(
  inputs: readonly FieldInput[],
  pageCount: number,
  existingIds: ReadonlySet<string>,
  assignableRecipients: ReadonlyMap<string, RecipientType>,
  deps: PreparationDependencies,
): readonly PreparationFieldRecord[] {
  const issues: string[] = [];
  const records: PreparationFieldRecord[] = [];
  const seen = new Set<string>();

  inputs.forEach((input, index) => {
    const at = `fields[${String(index)}]`;

    if (!isValidPageNumber(input.pageNumber, pageCount)) {
      // 1-based. The message says so, because an off-by-one here is the most
      // likely client mistake and the least obvious from a generic rejection.
      issues.push(`${at}.pageNumber: must be between 1 and ${String(pageCount)}`);
    }

    const geometry = validateRect(input.rect);
    if (!geometry.ok) issues.push(`${at}.rect: ${geometry.reason}`);

    const label = validateFieldLabel(input.label);
    if (!label.ok) issues.push(`${at}.label: ${label.reason}`);

    // A client id is honoured only if it is already ours. An unknown id is
    // rejected rather than adopted: adopting would let a caller choose row
    // identifiers, and a well-chosen one could collide with another tenant's.
    let fieldId = input.fieldId;
    if (fieldId !== undefined && !existingIds.has(fieldId)) {
      issues.push(`${at}.fieldId: unknown`);
      fieldId = undefined;
    }
    if (fieldId !== undefined && seen.has(fieldId)) {
      issues.push(`${at}.fieldId: duplicated in this layout`);
    }
    if (fieldId !== undefined) seen.add(fieldId);

    // ── Assignment ────────────────────────────────────────────────────────
    //
    // An id that is not a recipient of THIS preparation is refused, whether it
    // belongs to another document, another tenant, or nothing at all — one
    // answer, so the endpoint cannot be used to probe which ids exist (§124).
    let assignmentInvalid = false;
    const assignedTo = input.recipientId;
    if (assignedTo !== undefined && assignedTo !== null) {
      const type = assignableRecipients.get(assignedTo);
      if (type === undefined) {
        issues.push(`${at}.recipientId: unknown`);
        assignmentInvalid = true;
      } else if (!canHoldFields(type)) {
        // A viewer or carbon-copy recipient. Refused rather than silently
        // dropped: a sender who placed a signature on the wrong party must be
        // told, not quietly given an unassigned field.
        issues.push(`${at}.recipientId: this recipient cannot be assigned fields`);
        assignmentInvalid = true;
      }
    }

    if (!geometry.ok || !label.ok || assignmentInvalid) return;

    records.push({
      fieldId: (fieldId ?? deps.ids.nextPreparationFieldId()) as PreparationFieldRecord["fieldId"],
      type: input.type,
      pageNumber: input.pageNumber,
      // Rounded once, here, so the frontend and backend cannot round
      // differently and so two visually identical layouts compare equal.
      ...roundRect(input.rect),
      // A signature is required whatever the request said — the domain resolves
      // the contradiction rather than persisting it.
      required: effectiveRequired(input.type, input.required),
      label: label.value,
      layer: input.layer,
      recipientId: (input.recipientId ?? null) as PreparationFieldRecord["recipientId"],
    });
  });

  if (issues.length > 0) {
    throw new ApplicationValidationError("The layout could not be saved.", issues);
  }
  return records;
}

/**
 * Deliberately absent from this module.
 *
 * **lockPreparation / freezeForSigning** — the freeze belongs to signing-request
 * creation, which is BACKEND-32. `locked_at` exists and every mutation
 * conditions on it, so the transition is one statement when the state that
 * triggers it exists. Inventing it now would mean inventing that state.
 *
 * **markReady** — the product has no "ready" control. Its prepare flow has a
 * Review step, not a lock (OD-125).
 *
 * **deletePreparation** — no "clear preparation" control exists. Saving an
 * empty field array is how a sender clears a layout.
 *
 * **Per-field add/update/delete** — the other mutation model. §102 says choose
 * one; PREPARATION_ARCHITECTURE.md records why this one.
 */
export type PreparationOperationsDeferred = never;
