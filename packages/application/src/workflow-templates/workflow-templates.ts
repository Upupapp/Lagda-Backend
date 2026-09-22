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
// 3. NO LIVE REFERENCE. Nothing in this module hands a caller a template id to
//    keep. `resolveTemplateForApply` returns the SLOTS, already validated, for
//    the caller to copy. Migration 058 keeps the same rule in the schema:
//    nothing references this table.

import type { WorkspaceId } from "@lagda/contracts";
import {
  WORKFLOW_ROUTING_MODES, WORKFLOW_SLOT_AUTH_METHODS, RECIPIENT_TYPES,
  type WorkflowRoutingMode, type WorkflowRoleSlot,
  type WorkflowCompletionSettings,
} from "@lagda/contracts";
import type { WorkspaceCapability } from "@lagda/core";
import {
  assertCapability, type WorkspaceAccessContext,
} from "../workspaces/workspace-access.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type {
  WorkflowTemplateIdGenerator, WorkflowTemplateRecord, RawWorkflowTemplateRow,
} from "../common/ports/workflow-templates.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import { ApplicationError, ResourceNotFoundError } from "../common/errors/index.js";

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
 * Validates one slot, naming what is wrong rather than returning a boolean.
 *
 * The reason reaches the caller, so an admin editing a template is told which
 * slot and what about it — and an apply that refuses says why it refused.
 * Indexes are 1-based in the message because the admin counts from one.
 */
function validateSlot(value: unknown, index: number): WorkflowRoleSlot {
  const at = `slot ${String(index + 1)}`;
  if (!isRecord(value)) throw new WorkflowTemplateMalformedError(`${at} is not an object`);

  const { label, role, required, routingStep, defaultAuthMethod } = value;

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
    label: label.trim(),
    role: role as WorkflowRoleSlot["role"],
    required,
    routingStep,
    defaultAuthMethod: defaultAuthMethod as WorkflowRoleSlot["defaultAuthMethod"],
  };
}

/**
 * Validates the whole slot list, including the rules BETWEEN slots.
 *
 * The cross-slot rule is that steps must be CONTIGUOUS from 1. A template with
 * steps 1 and 3 and nothing at 2 would, applied, produce recipients at routing
 * orders 1 and 3 — which the workflow engine reads as "step 2 has no
 * participants", and whether it then stalls or skips is not a question a
 * template should be able to ask.
 */
export function validateRoleSlots(value: unknown): readonly WorkflowRoleSlot[] {
  if (!Array.isArray(value)) {
    throw new WorkflowTemplateMalformedError("its role slots are missing");
  }
  if (value.length === 0) {
    throw new WorkflowTemplateMalformedError("it has no role slots");
  }
  if (value.length > MAX_SLOTS) {
    throw new WorkflowTemplateMalformedError("it has too many role slots");
  }

  const slots = value.map((slot, index) => validateSlot(slot, index));

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
  };
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface WorkflowTemplateInput {
  readonly name: string;
  readonly routingMode: unknown;
  readonly roleSlots: unknown;
  readonly completionSettings: unknown;
}

interface ValidatedInput {
  readonly name: string;
  readonly routingMode: WorkflowRoutingMode;
  readonly roleSlots: readonly WorkflowRoleSlot[];
  readonly completionSettings: WorkflowCompletionSettings;
}

function validateInput(input: WorkflowTemplateInput): ValidatedInput {
  return {
    name: validateName(input.name),
    routingMode: validateRoutingMode(input.routingMode),
    roleSlots: validateRoleSlots(input.roleSlots),
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
  const validated = validateInput(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "template.create");

    if (await uow.workflowTemplates.nameExists(validated.name, null)) {
      throw new WorkflowTemplateNameTakenError();
    }

    const now = deps.clock.now();
    const record: WorkflowTemplateRecord = {
      workflowTemplateId: deps.ids.nextWorkflowTemplateId(),
      workspaceId: access.workspaceId,
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots: validated.roleSlots,
      completionSettings: validated.completionSettings,
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
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
  const validated = validateInput(input);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "template.update");

    const existing = await uow.workflowTemplates.find(workflowTemplateId);
    if (existing === null) throw new ResourceNotFoundError("WorkflowTemplate");

    if (await uow.workflowTemplates.nameExists(validated.name, workflowTemplateId)) {
      throw new WorkflowTemplateNameTakenError();
    }

    const now = deps.clock.now();
    const changed = await uow.workflowTemplates.update(workflowTemplateId, {
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots: validated.roleSlots,
      completionSettings: validated.completionSettings,
      updatedAt: now,
    });
    if (!changed) throw new ResourceNotFoundError("WorkflowTemplate");

    return {
      workflowTemplateId,
      workspaceId: existing.workspaceId,
      name: validated.name,
      routingMode: validated.routingMode,
      roleSlots: validated.roleSlots,
      completionSettings: validated.completionSettings,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: now,
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
}

export async function resolveTemplateForApply(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  workflowTemplateId: string,
  deps: WorkflowTemplateDependencies,
): Promise<WorkflowTemplateApplication> {
  const template = await getWorkflowTemplate(actor, workspaceId, workflowTemplateId, deps);
  return {
    routingMode: template.routingMode,
    roleSlots: template.roleSlots,
    completionSettings: template.completionSettings,
  };
}
