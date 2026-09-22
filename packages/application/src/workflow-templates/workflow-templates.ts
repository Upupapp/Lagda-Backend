// Reusable workflow templates (migration 058).
//
// ── What this module is careful about ─────────────────────────────────────
//
// 1. AUTHORIZATION. Every entry point resolves the actor's CURRENT membership
//    inside the transaction and asserts a capability, the same frame contacts
//    and member administration use. Reading is `template.view`; authoring is
//    `template.create` / `.update` / `.delete`, which a `sender` does not
//    hold.
//
// 2. THE JSONB. `role_slots` is a JSON column, so PostgreSQL guarantees only
//    that it is a non-empty array. Every slot is validated HERE — on write, so
//    a malformed one is never stored, and again on read, so a row that
//    somehow holds one fails loudly instead of producing a half-built routing
//    configuration for a document somebody is about to send.
//
// 3. NO LIVE REFERENCE INTO this table. Nothing in this module hands a caller
//    a template id to keep. `resolveTemplateForApply` returns the SLOTS,
//    already validated, for the caller to copy. Migration 058 keeps the same
//    rule in the schema: nothing references this table.
//
//    059 adds a reference the OTHER way — this table may point AT a document
//    — which does not weaken the rule above. `resolveTemplateForApply` copies
//    the (documentId, artifactId) pair the same way it copies slots: what a
//    draft receives is a snapshot of where the document stood at apply time,
//    not a live pointer to "this template's current document". Re-attaching
//    a different document to the template afterwards cannot reach a draft
//    already built from it, for the same reason editing a slot cannot.

import type { WorkspaceId, DocumentId, PreparationFieldType, PreparationRect } from "@lagda/contracts";
import {
  WORKFLOW_ROUTING_MODES, WORKFLOW_SLOT_AUTH_METHODS, RECIPIENT_TYPES,
  type WorkflowRoutingMode, type WorkflowRoleSlot,
  type WorkflowCompletionSettings,
} from "@lagda/contracts";
import {
  validateRect, roundRect, isValidPageNumber, canPlaceFields, validateFieldLabel,
  effectiveRequired, type WorkspaceCapability,
} from "@lagda/core";
import {
  assertCapability, type WorkspaceAccessContext,
} from "../workspaces/workspace-access.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type {
  WorkflowTemplateIdGenerator, WorkflowTemplateRecord, RawWorkflowTemplateRow,
} from "../common/ports/workflow-templates.js";
import type { WorkflowTemplateFieldRecord } from "../common/ports/workflow-template-fields.js";
import type { ArtifactId } from "../common/ports/evidence.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The template's stored shape is not usable.
 *
 * Raised when a slot is missing, malformed, or names a value outside the
 * product's vocabulary — on write, and again when a template is applied.
 *
 * It is deliberately LOUD on the apply path. The alternative, skipping the bad
 * slot and building the rest, produces a document that routes to fewer people
 * than the admin designed, which nobody would notice until it had been signed
 * by the wrong set.
 */
export class WorkflowTemplateMalformedError extends ApplicationError {
  // `validation`, not `internal`, even when it is a STORED row that is bad:
  // the caller's remedy is to fix the template, and a 500 would say the
  // server broke when the data did.
  readonly category = "validation" as const;
  readonly code = "workflow_template_malformed";

  constructor(readonly reason: string) {
    super(`This workflow template cannot be used: ${reason}.`);
    this.name = "WorkflowTemplateMalformedError";
  }
}

/** Another template in this workspace already has this name. */
export class WorkflowTemplateNameTakenError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "workflow_template_name_taken";

  constructor() {
    super("A workflow template with this name already exists in this workspace.");
    this.name = "WorkflowTemplateNameTakenError";
  }
}

/**
 * The (documentId, artifactId) pair given to `attachWorkflowTemplateDocument`
 * does not describe one real thing.
 *
 * Two distinct ways this fires, both refused the same way rather than
 * trusting the caller: the artifact does not belong to the document named
 * (a stale or mismatched pair), or it is not the ORIGINAL upload — attaching
 * a sealed output or a completion certificate would give a template a
 * document nobody can place fields on.
 */
export class WorkflowTemplateDocumentMismatchError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "workflow_template_document_mismatch";

  constructor(readonly reason: string) {
    super(`This document cannot be attached: ${reason}.`);
    this.name = "WorkflowTemplateDocumentMismatchError";
  }
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface WorkflowTemplateDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: WorkflowTemplateIdGenerator;
}

/**
 * Resolves the actor's CURRENT authority inside an open transaction.
 *
 * Same shape as the contacts module's, and kept separate for the same reason
 * stated there: the two have different dependency sets, and a shared helper
 * taking a unit of work would be importable by code with no business reading
 * memberships.
 */
async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member, or no longer one. The same hidden 404 as everywhere else, so
  // "this workspace is not yours" and "you may not do that here" are one
  // answer — a caller cannot probe for which workspaces exist.
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

// ── Validation ───────────────────────────────────────────────────────────────

const MAX_SLOTS = 50;
const MAX_LABEL = 120;
const MAX_STEP = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a slot's id: kept if it already belongs to THIS template, minted
 * otherwise.
 *
 * `existingSlotIds === null` means "no template exists yet" (create) — every
 * slot is new, so any client-supplied id is ignored rather than adopted, the
 * same "server decides identity" rule `WorkflowTemplateWriteSchema`'s header
 * states for the template's own id. On update, a client id is honoured only
 * if it names a slot THIS template already has — an id from another
 * template, or one that was never real, is silently treated as a new slot
 * rather than rejected, mirroring `FieldInput.fieldId`'s exact rule in
 * preparation.ts.
 *
 * `seen` guards against the same id appearing twice in one write — kept only
 * once, and every later occurrence is minted fresh instead of being refused
 * outright, since a duplicated id is far more likely a copy-paste in the
 * client's local state than a deliberate attempt to collide two slots.
 */
function resolveSlotId(
  candidate: string | undefined,
  existingSlotIds: ReadonlySet<string>,
  seen: Set<string>,
  mint: () => string,
): string {
  if (candidate !== undefined && !seen.has(candidate) && existingSlotIds.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  const minted = mint();
  seen.add(minted);
  return minted;
}

/** The fields every slot shares, checked once and reused by both the read
 *  path (which requires a stored `slotId`) and the write path (which
 *  resolves one — see `resolveSlotId`). */
interface ValidatedSlotShape {
  readonly rawSlotId: string | undefined;
  readonly label: string;
  readonly role: WorkflowRoleSlot["role"];
  readonly required: boolean;
  readonly routingStep: number;
  readonly defaultAuthMethod: WorkflowRoleSlot["defaultAuthMethod"];
}

/**
 * Validates everything about one slot EXCEPT its id, naming what is wrong
 * rather than returning a boolean.
 *
 * The reason reaches the caller, so an admin editing a template is told which
 * slot and what about it — and an apply that refuses says why it refused.
 * Indexes are 1-based in the message because the admin counts from one.
 */
function validateSlotShape(value: unknown, index: number): ValidatedSlotShape {
  const at = `slot ${String(index + 1)}`;
  if (!isRecord(value)) throw new WorkflowTemplateMalformedError(`${at} is not an object`);

  const { slotId, label, role, required, routingStep, defaultAuthMethod } = value;

  if (slotId !== undefined && typeof slotId !== "string") {
    throw new WorkflowTemplateMalformedError(`${at} has an invalid id`);
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new WorkflowTemplateMalformedError(`${at} has no label`);
  }
  if (label.length > MAX_LABEL) {
    throw new WorkflowTemplateMalformedError(`${at}'s label is too long`);
  }
  if (typeof role !== "string" || !RECIPIENT_TYPES.includes(role as never)) {
    throw new WorkflowTemplateMalformedError(`${at} has an unknown role`);
  }
  if (typeof required !== "boolean") {
    throw new WorkflowTemplateMalformedError(`${at} does not say whether it is required`);
  }
  if (typeof routingStep !== "number" || !Number.isInteger(routingStep)
    || routingStep < 1 || routingStep > MAX_STEP) {
    throw new WorkflowTemplateMalformedError(`${at} has an invalid routing step`);
  }
  if (typeof defaultAuthMethod !== "string"
    || !WORKFLOW_SLOT_AUTH_METHODS.includes(defaultAuthMethod as never)) {
    throw new WorkflowTemplateMalformedError(`${at} has an unknown authentication method`);
  }

  return {
    rawSlotId: slotId,
    label: label.trim(),
    role: role as WorkflowRoleSlot["role"],
    required,
    routingStep,
    defaultAuthMethod: defaultAuthMethod as WorkflowRoleSlot["defaultAuthMethod"],
  };
}

/**
 * The rules BETWEEN slots, shared by the read and write paths.
 *
 * The cross-slot rule is that steps must be CONTIGUOUS from 1. A template with
 * steps 1 and 3 and nothing at 2 would, applied, produce recipients at routing
 * orders 1 and 3 — which the workflow engine reads as "step 2 has no
 * participants", and whether it then stalls or skips is not a question a
 * template should be able to ask.
 */
function validateCrossSlotRules(slots: readonly WorkflowRoleSlot[]): void {
  const steps = [...new Set(slots.map(slot => slot.routingStep))].sort((a, b) => a - b);
  for (const [index, step] of steps.entries()) {
    if (step !== index + 1) {
      throw new WorkflowTemplateMalformedError(
        `its routing steps skip from ${String(steps[index - 1] ?? 0)} to ${String(step)}`);
    }
  }

  // At least one participant who actually blocks. A template made entirely of
  // viewers and carbon-copies routes to nobody and can never complete — and
  // `needsSigningAccess` gives neither of those a credential, so the request
  // would be sent to an empty audience.
  const blocking = slots.filter(
    slot => slot.role !== "viewer" && slot.role !== "carbon-copy");
  if (blocking.length === 0) {
    throw new WorkflowTemplateMalformedError(
      "it has nobody who can act — every slot is a viewer or a copy recipient");
  }
}

function validateSlotCount(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkflowTemplateMalformedError("its role slots are missing");
  }
  if (value.length === 0) {
    throw new WorkflowTemplateMalformedError("it has no role slots");
  }
  if (value.length > MAX_SLOTS) {
    throw new WorkflowTemplateMalformedError("it has too many role slots");
  }
  return value;
}

/**
 * The READ path: every slot's `slotId` must already be there.
 *
 * By the time application code runs, migration 060 has backfilled every
 * stored row — a slot with no id here is not "a slot that predates ids", it
 * is a malformed row, and this fails loudly rather than minting a fresh id
 * that would be different on every read (§ this module's own header, point 2).
 */
export function validateRoleSlots(value: unknown): readonly WorkflowRoleSlot[] {
  const slots = validateSlotCount(value).map((slot, index) => {
    const at = `slot ${String(index + 1)}`;
    const shape = validateSlotShape(slot, index);
    if (shape.rawSlotId === undefined) {
      throw new WorkflowTemplateMalformedError(`${at} has no id`);
    }
    return {
      slotId: shape.rawSlotId,
      label: shape.label,
      role: shape.role,
      required: shape.required,
      routingStep: shape.routingStep,
      defaultAuthMethod: shape.defaultAuthMethod,
    };
  });
  validateCrossSlotRules(slots);
  return slots;
}

/**
 * The WRITE path: a slot's id is RESOLVED (kept-if-known, minted otherwise)
 * rather than required — see `resolveSlotId`.
 *
 * `existingSlotIds` is the template's CURRENT slots, read inside the same
 * transaction as the write (empty on create — nothing exists yet).
 */
function validateRoleSlotsForWrite(
  value: unknown,
  existingSlotIds: ReadonlySet<string>,
  mintSlotId: () => string,
): readonly WorkflowRoleSlot[] {
  const seen = new Set<string>();
  const slots = validateSlotCount(value).map((slot, index) => {
    const shape = validateSlotShape(slot, index);
    return {
      slotId: resolveSlotId(shape.rawSlotId, existingSlotIds, seen, mintSlotId),
      label: shape.label,
      role: shape.role,
      required: shape.required,
      routingStep: shape.routingStep,
      defaultAuthMethod: shape.defaultAuthMethod,
    };
  });
  validateCrossSlotRules(slots);
  return slots;
}

function validateCompletionSettings(value: unknown): WorkflowCompletionSettings {
  if (!isRecord(value)) {
    throw new WorkflowTemplateMalformedError("its completion settings are missing");
  }
  if (typeof value["notifySenderOnComplete"] !== "boolean") {
    throw new WorkflowTemplateMalformedError("its completion settings are invalid");
  }
  return { notifySenderOnComplete: value["notifySenderOnComplete"] };
}

function validateRoutingMode(value: unknown): WorkflowRoutingMode {
  if (typeof value !== "string" || !WORKFLOW_ROUTING_MODES.includes(value as never)) {
    throw new WorkflowTemplateMalformedError("its routing mode is not one this product has");
  }
  return value as WorkflowRoutingMode;
}

function validateName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new WorkflowTemplateMalformedError("it has no name");
  if (name.length > 200) throw new WorkflowTemplateMalformedError("its name is too long");
  return name;
}

/**
 * A stored row, validated into a record.
 *
 * Every read goes through this, so no caller ever holds a template whose slots
 * were not checked — including the apply path, which is the one place a
 * malformed slot would do real damage.
 */
export function parseStoredTemplate(row: RawWorkflowTemplateRow): WorkflowTemplateRecord {
  return {
    workflowTemplateId: row.workflowTemplateId,
    workspaceId: row.workspaceId,
    name: row.name,
    routingMode: validateRoutingMode(row.routingMode),
    roleSlots: validateRoleSlots(row.roleSlots),
    completionSettings: validateCompletionSettings(row.completionSettings),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    documentId: row.documentId,
    sourceArtifactId: row.sourceArtifactId,
  };
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface WorkflowTemplateInput {
  readonly name: string;
  readonly routingMode: unknown;
  readonly roleSlots: unknown;
  readonly completionSettings: unknown;
}

/**
 * Name, routing mode and completion settings — everything that does NOT
 * depend on knowing the template's CURRENT slots, and so can be checked
 * before a transaction is even open.
 *
 * Role slots are deliberately absent here: resolving a slot's id needs
 * `existingSlotIds` (empty on create, the template's own on update — see
 * `validateRoleSlotsForWrite`), which only exists once the transaction has
 * either decided this is a create or loaded the row being updated.
 */
interface ValidatedInputBase {
  readonly name: string;
  readonly routingMode: WorkflowRoutingMode;
  readonly completionSettings: WorkflowCompletionSettings;
}

function validateInputBase(input: WorkflowTemplateInput): ValidatedInputBase {
  return {
    name: validateName(input.name),
    routingMode: validateRoutingMode(input.routingMode),
    completionSettings: validateCompletionSettings(input.completionSettings),
  };
}

// ── Use cases ────────────────────────────────────────────────────────────────

export async function createWorkflowTemplate(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: WorkflowTemplateInput,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateRecord> {
  const validated = validateInputBase(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "template.create");

    if (await uow.workflowTemplates.nameExists(validated.name, null)) {
      throw new WorkflowTemplateNameTakenError();
    }

    // Nothing exists yet — every slot is new (§ `validateRoleSlotsForWrite`).
    const roleSlots = validateRoleSlotsForWrite(
      input.roleSlots, new Set(), deps.ids.nextWorkflowRoleSlotId);

    const now = deps.clock.now();
    const record: WorkflowTemplateRecord = {
      workflowTemplateId: deps.ids.nextWorkflowTemplateId(),
      workspaceId: access.workspaceId,
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots,
      completionSettings: validated.completionSettings,
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
      // No document on creation. Attaching one is a separate act
      // (`attachWorkflowTemplateDocument`) with its own capability check and
      // its own verification that the artifact actually belongs to the
      // document named — creation never receives either value to begin with.
      documentId: null,
      sourceArtifactId: null,
    };

    await uow.workflowTemplates.insert(record);
    return record;
  });
}

export async function listWorkflowTemplates(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  deps: WorkflowTemplateDependencies,
): Promise<readonly WorkflowTemplateRecord[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.view");
    const rows = await uow.workflowTemplates.list();
    return rows.map(parseStoredTemplate);
  });
}

export async function getWorkflowTemplate(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateRecord> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.view");
    const row = await uow.workflowTemplates.find(workflowTemplateId);
    // Another tenant's template is indistinguishable from an absent one — the
    // row-level security already makes it invisible, and this says the same.
    if (row === null) throw new ResourceNotFoundError("WorkflowTemplate");
    return parseStoredTemplate(row);
  });
}

export async function updateWorkflowTemplate(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  input: WorkflowTemplateInput,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateRecord> {
  const validated = validateInputBase(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.update");

    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");

    if (await uow.workflowTemplates.nameExists(validated.name, workflowTemplateId)) {
      throw new WorkflowTemplateNameTakenError();
    }

    // The template's CURRENT slots, so a client-supplied slotId can be told
    // apart from one that merely looks plausible — see `resolveSlotId`.
    const existingSlotIds = new Set(
      parseStoredTemplate(existing).roleSlots.map(slot => slot.slotId));
    const roleSlots = validateRoleSlotsForWrite(
      input.roleSlots, existingSlotIds, deps.ids.nextWorkflowRoleSlotId);

    const now = deps.clock.now();
    const changed = await uow.workflowTemplates.update(workflowTemplateId, {
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots,
      completionSettings: validated.completionSettings,
      updatedAt: now,
    });
    if (!changed) throw new ResourceNotFoundError("WorkflowTemplate");

    // A slot this edit REMOVED can no longer own a field — an orphaned
    // field would point at a role that no longer exists on this template,
    // which `saveWorkflowTemplateFields` refuses on write but nothing would
    // catch on an edit that removes the slot a field already used. Dropped
    // here rather than left to be a corrupt-looking read.
    const survivingSlotIds = new Set(roleSlots.map(slot => slot.slotId));
    const currentFields = await uow.workflowTemplateFields.list(workflowTemplateId);
    const orphaned = currentFields.some(field => !survivingSlotIds.has(field.slotId));
    if (orphaned) {
      await uow.workflowTemplateFields.replaceAll(
        workflowTemplateId,
        currentFields.filter(field => survivingSlotIds.has(field.slotId)),
        now);
    }

    return {
      workflowTemplateId,
      workspaceId: existing.workspaceId,
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots,
      completionSettings: validated.completionSettings,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: now,
      // Carried over, not touched. `update` (name/routing/slots) never writes
      // these columns — a PUT to the template's shape must not silently
      // detach its document as a side effect.
      documentId: existing.documentId,
      sourceArtifactId: existing.sourceArtifactId,
    };
  });
}

export async function deleteWorkflowTemplate(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<void> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.delete");
    const removed = await uow.workflowTemplates.remove(workflowTemplateId);
    if (!removed) throw new ResourceNotFoundError("WorkflowTemplate");
  });
}

// ── The template's document (059) ───────────────────────────────────────────

export interface AttachWorkflowTemplateDocumentInput {
  readonly documentId: DocumentId;
  readonly artifactId: ArtifactId;
}

/**
 * Points a template at an already-uploaded document.
 *
 * Takes an existing document and artifact — an id pair the caller obtained
 * through the ordinary document-create-then-upload path — rather than a file.
 * This use case does no uploading, no storage write and no virus scan; all of
 * that already happened to produce the artifact being named here. Reusing
 * that path rather than inventing a second one is the point: a template's
 * document is stored exactly like any other document, and everything that
 * already keeps an upload honest (validation, quarantine, the immutable
 * artifact row) applies to it unchanged.
 *
 * `template.update` gates this, the same capability that gates the
 * name/slots/routing write — attaching a document is editing the template,
 * not a separate authority.
 */
export async function attachWorkflowTemplateDocument(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  input: AttachWorkflowTemplateDocumentInput,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateRecord> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.update");

    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");

    // Both looked up in THIS workspace's transaction, so a cross-workspace id
    // is indistinguishable from one that does not exist — RLS refuses the
    // read before this function ever sees a row to compare.
    const document = await uow.documents.findById(input.documentId);
    if (document === null) throw new ResourceNotFoundError("Document");

    const artifact = await uow.artifacts.find(input.artifactId);
    if (artifact === null) throw new ResourceNotFoundError("Artifact");

    // The pair must actually describe one real thing, and it must be the
    // pristine upload — never trust a client-supplied pair by construction.
    if (artifact.documentId !== input.documentId) {
      throw new WorkflowTemplateDocumentMismatchError(
        "the artifact does not belong to the document named");
    }
    if (artifact.artifactType !== "original") {
      throw new WorkflowTemplateDocumentMismatchError(
        "only the original upload can be attached to a template");
    }

    const updatedAt = deps.clock.now();
    const changed = await uow.workflowTemplates.attachDocument(workflowTemplateId, {
      documentId: input.documentId, artifactId: input.artifactId, updatedAt,
    });
    if (!changed) throw new ResourceNotFoundError("WorkflowTemplate");

    return {
      ...parseStoredTemplate(existing),
      documentId: input.documentId,
      sourceArtifactId: input.artifactId,
      updatedAt,
    };
  });
}

/**
 * Removes a template's document reference. The document and its artifact are
 * untouched and continue to exist — this only stops the template pointing at
 * them, exactly as deleting the template does (see 059's header).
 */
export async function detachWorkflowTemplateDocument(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateRecord> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.update");

    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");

    const updatedAt = deps.clock.now();
    const changed = await uow.workflowTemplates.detachDocument(workflowTemplateId, updatedAt);
    if (!changed) throw new ResourceNotFoundError("WorkflowTemplate");

    // A field's page bounds were validated against THIS document (060) —
    // detaching it (or a later re-attach of a DIFFERENT one, with its own
    // page count and layout) makes every placed field's page number and
    // rectangle unverifiable at best and meaningless at worst. Cleared
    // rather than left to silently misplace a signature on whatever gets
    // attached next.
    await uow.workflowTemplateFields.replaceAll(workflowTemplateId, [], updatedAt);

    return {
      ...parseStoredTemplate(existing),
      documentId: null,
      sourceArtifactId: null,
      updatedAt,
    };
  });
}

/**
 * The APPLY read: a template's slots, validated, for a caller to COPY.
 *
 * Separate from `getWorkflowTemplate` so the apply path states its own intent
 * and its own capability. It needs `template.view` — applying is a sender's
 * act, and a sender holds read and nothing else.
 *
 * It returns the slots and the settings, NOT the template id. A caller cannot
 * accidentally store a pointer it was never given, which is the schema's rule
 * (migration 058) expressed in the type.
 */
export interface WorkflowTemplateApplication {
  readonly routingMode: WorkflowRoutingMode;
  readonly roleSlots: readonly WorkflowRoleSlot[];
  readonly completionSettings: WorkflowCompletionSettings;
  /**
   * 059. `null` when the template has no document attached — the caller
   * falls back to an empty Upload step, exactly as before this migration.
   *
   * This is a COPY of where the document stood at apply time, not a live
   * pointer to the template (see the module header's note on 059). A draft
   * built from it keeps this pair even if the template is later re-attached
   * to a different document or deleted outright.
   */
  readonly documentId: DocumentId | null;
  readonly sourceArtifactId: ArtifactId | null;
  /** 060. Per-role-slot geometry, snapshotted the same way the document
   *  pair is — see this field's own assignment below. Empty when the
   *  template has no fields. */
  readonly fields: readonly WorkflowTemplateFieldRecord[];
}

export async function resolveTemplateForApply(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateApplication> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.view");
    const row = await uow.workflowTemplates.find(workflowTemplateId);
    if (row === null) throw new ResourceNotFoundError("WorkflowTemplate");
    const template = parseStoredTemplate(row);

    return {
      routingMode: template.routingMode,
      roleSlots: template.roleSlots,
      completionSettings: template.completionSettings,
      documentId: template.documentId,
      sourceArtifactId: template.sourceArtifactId,
      // A snapshot copy, the same rule as everything else this interface
      // returns — the caller gets THIS moment's field layout, and a later
      // edit to the template's fields cannot reach a draft already built
      // from it. Empty when the template has no fields (the ordinary case
      // today) or no document (fields cannot exist without one). Read in
      // the SAME transaction as the template itself, so the two cannot
      // observe two different moments.
      fields: await uow.workflowTemplateFields.list(workflowTemplateId),
    };
  });
}

// ── The template's field placements (060) ───────────────────────────────────
//
// See this file's header and 060's migration comment for the design: a field
// belongs to a ROLE SLOT, resolved to geometry checked against the
// template's OWN attached document, the same `@lagda/core` rules
// `preparation.ts` applies to a real document.

/** A field's page number and rectangle are validated against a real page
 *  count — nothing to validate them against when no document is attached. */
export class WorkflowTemplateFieldsNeedDocumentError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "workflow_template_fields_need_document";

  constructor() {
    super("Attach a document to this template before placing fields on it.");
    this.name = "WorkflowTemplateFieldsNeedDocumentError";
  }
}

export interface WorkflowTemplateFieldWriteInput {
  /** Omitted for a new field; the server generates one. Supplied only to
   *  preserve identity across a save — honoured only if it already belongs
   *  to THIS template, mirroring `FieldInput.fieldId` in preparation. */
  readonly fieldId?: string;
  /** One of the template's own `role_slots[].slotId` values. */
  readonly slotId: string;
  readonly type: PreparationFieldType;
  readonly pageNumber: number;
  readonly rect: PreparationRect;
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
}

/** The document's page count and rotation-placeability, resolved the same
 *  way `preparation.ts`'s `resolveSource` does for a real document. */
async function resolvePageCount(
  uow: WorkspaceUnitOfWork,
  sourceArtifactId: ArtifactId,
): Promise<number> {
  const artifact = await uow.artifacts.find(sourceArtifactId);
  // The template's own attach path already verified this artifact exists
  // and belongs to the attached document; absent here would mean it was
  // deleted since, which nothing in this schema currently does (059's
  // header traces the same fact for the FK's RESTRICT posture).
  if (artifact === null || artifact.pageCount === undefined) {
    throw new WorkflowTemplateFieldsNeedDocumentError();
  }
  if (!canPlaceFields(artifact.rotatedPageCount ?? null)) {
    throw new WorkflowTemplateFieldsNeedDocumentError();
  }
  return artifact.pageCount;
}

/** Validates every field and returns the records to persist. Reports ALL
 *  problems at once — see `WorkflowTemplateFieldValidationError`. */
function validateTemplateFields(
  inputs: readonly WorkflowTemplateFieldWriteInput[],
  roleSlotIds: ReadonlySet<string>,
  pageCount: number,
  existingFieldIds: ReadonlySet<string>,
  mintFieldId: () => string,
): readonly WorkflowTemplateFieldRecord[] {
  const issues: string[] = [];
  const records: WorkflowTemplateFieldRecord[] = [];
  const seenFieldIds = new Set<string>();

  inputs.forEach((input, index) => {
    const at = `fields[${String(index)}]`;

    if (!roleSlotIds.has(input.slotId)) {
      issues.push(`${at}.slotId: does not name a role on this template`);
    }
    if (!isValidPageNumber(input.pageNumber, pageCount)) {
      issues.push(`${at}.pageNumber: must be between 1 and ${String(pageCount)}`);
    }

    const geometry = validateRect(input.rect);
    if (!geometry.ok) issues.push(`${at}.rect: ${geometry.reason}`);

    const label = validateFieldLabel(input.label);
    if (!label.ok) issues.push(`${at}.label: ${label.reason}`);

    // A client id is honoured only if it already belongs to THIS template —
    // exactly `FieldInput.fieldId`'s rule in preparation.ts.
    let fieldId = input.fieldId;
    if (fieldId !== undefined && !existingFieldIds.has(fieldId)) {
      issues.push(`${at}.fieldId: unknown`);
      fieldId = undefined;
    }
    if (fieldId !== undefined && seenFieldIds.has(fieldId)) {
      issues.push(`${at}.fieldId: duplicated in this layout`);
    }
    if (fieldId !== undefined) seenFieldIds.add(fieldId);

    if (!roleSlotIds.has(input.slotId) || !geometry.ok || !label.ok) return;

    records.push({
      fieldId: (fieldId ?? mintFieldId()) as WorkflowTemplateFieldRecord["fieldId"],
      slotId: input.slotId,
      type: input.type,
      pageNumber: input.pageNumber,
      // Rounded once, here — the same reason preparation.ts rounds once,
      // so the frontend and backend cannot round differently.
      ...roundRect(input.rect),
      // A signature is required whatever the request said — the domain
      // resolves the contradiction rather than persisting it.
      required: effectiveRequired(input.type, input.required),
      label: label.value,
      layer: input.layer,
    });
  });

  // Reuses `ApplicationValidationError` rather than a template-specific
  // class — the same "report every problem at once, by field index" shape
  // `preparation.ts`'s own `validateFields` already established, and the
  // shared error mapper already knows how to turn it into a 422.
  if (issues.length > 0) {
    throw new ApplicationValidationError("This field layout could not be saved.", issues);
  }
  return records;
}

/**
 * The template's field layout, in deterministic order. `template.view` —
 * the same capability `getWorkflowTemplate` needs, since seeing where a
 * role's fields land is part of reading the template.
 */
export async function listWorkflowTemplateFields(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<readonly WorkflowTemplateFieldRecord[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.view");
    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");
    return uow.workflowTemplateFields.list(workflowTemplateId);
  });
}

/**
 * Replaces the WHOLE field layout — the same one-atomic-write model
 * `preparation.ts`'s `saveDocumentPreparation` uses, and for the same
 * reason (§ `ScopedWorkflowTemplateFieldRepository`'s header).
 *
 * Requires a document: a field's page number and rectangle are checked
 * against a real page count, and a template with none attached has no page
 * count to check against (`WorkflowTemplateFieldsNeedDocumentError`) — with
 * one exception, clearing the layout (`fields: []`), which needs no
 * document to be a well-formed request.
 */
export async function saveWorkflowTemplateFields(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  inputs: readonly WorkflowTemplateFieldWriteInput[],
  deps: WorkflowTemplateDependencies,
): Promise<readonly WorkflowTemplateFieldRecord[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.update");

    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");
    const template = parseStoredTemplate(existing);

    const now = deps.clock.now();

    if (inputs.length === 0) {
      await uow.workflowTemplateFields.replaceAll(workflowTemplateId, [], now);
      return [];
    }

    if (template.sourceArtifactId === null) {
      throw new WorkflowTemplateFieldsNeedDocumentError();
    }
    const pageCount = await resolvePageCount(uow, template.sourceArtifactId);

    const roleSlotIds = new Set(template.roleSlots.map(slot => slot.slotId));
    const existingFieldIds = new Set(
      (await uow.workflowTemplateFields.list(workflowTemplateId)).map(f => f.fieldId));

    const fields = validateTemplateFields(
      inputs, roleSlotIds, pageCount, existingFieldIds,
      deps.ids.nextWorkflowTemplateFieldId);

    await uow.workflowTemplateFields.replaceAll(workflowTemplateId, fields, now);
    return fields;
  });
}
