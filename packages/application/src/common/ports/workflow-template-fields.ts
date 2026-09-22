// Workflow-template field-placement ports (060).
//
// Mirrors `preparation.ts`'s ports deliberately: the same field-type
// vocabulary and geometry, and the same whole-layout-replace model, for the
// same drag-and-drop-autosave reason preparation's own header states.
//
// ── What is different from preparation, and why ─────────────────────────────
//
// No `expectedRevision`. A real preparation is edited by one sender while
// OTHER people (recipients, later, the ceremony) may be reading a version of
// it concurrently over its lifetime — the revision exists for that. A
// template's field layout has no such audience: it is authored, saved, and
// read back by admins editing the same template, one at a time, in
// practice. Adding concurrency control for a race that does not occur would
// be complexity with no defect it prevents.
//
// No `lockedAt` / editability gate, for the same reason preparation's own
// freeze belongs to signing-request creation: a TEMPLATE is never sent, so
// nothing ever needs to freeze its layout.

import type { PreparationFieldType } from "@lagda/contracts";

/** Opaque, server-generated. Never an array index. */
export type WorkflowTemplateFieldId = string & { readonly __brand: "WorkflowTemplateFieldId" };

/**
 * A placed field, as persisted — geometry for one ROLE, not one person.
 *
 * No `value`, no `signedAt`: identical in spirit to `PreparationFieldRecord`,
 * which records only the requirement. A template field is one step further
 * still from a signer — it does not even know who will fill it, only which
 * role slot does.
 */
export interface WorkflowTemplateFieldRecord {
  readonly fieldId: WorkflowTemplateFieldId;
  /** One of the template's OWN `role_slots[].slotId` values, validated by
   *  the use case against the template's current slots on every write. */
  readonly slotId: string;
  readonly type: PreparationFieldType;
  /** 1-based, against the template's attached document. */
  readonly pageNumber: number;
  /** Normalized 0–1, top-left origin. `y` is to the field's TOP edge —
   *  the same coordinate model `@lagda/core/preparation` defines. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  readonly label: string;
  /** z-order; higher draws on top. */
  readonly layer: number;
}

/**
 * Workflow-template field persistence, bound to ONE workspace and ONE
 * transaction — the same rule every other scoped repository here follows.
 */
export interface ScopedWorkflowTemplateFieldRepository {
  /** The fields, in deterministic order: page, then layer, then id. */
  list(workflowTemplateId: string): Promise<readonly WorkflowTemplateFieldRecord[]>;

  /**
   * Replaces the entire field set for one template.
   *
   * Unconditional — no revision to check, no lock to respect (see this
   * file's header). The caller has already validated every field against the
   * template's current slots and the document's page bounds before this is
   * called; this method is the write, not another check.
   */
  replaceAll(
    workflowTemplateId: string,
    fields: readonly WorkflowTemplateFieldRecord[],
    now: number,
  ): Promise<void>;
}

// Id generation for a field lives on `WorkflowTemplateIdGenerator`
// (common/ports/workflow-templates.ts), alongside `nextWorkflowTemplateId`
// and `nextWorkflowRoleSlotId` — one generator, reused by every
// workflow-template use case, rather than a second dependency bag routes
// would have to thread through separately.
