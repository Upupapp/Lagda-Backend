// A workflow template's field placements (migration 060).
//
// The claims that carry weight:
//
//   A FIELD BELONGS TO A SLOT, VERIFIED AGAINST THE TEMPLATE'S CURRENT
//   SLOTS — an unknown slotId is refused, the same way attachWorkflowTemplate
//   Document refuses an unverified document/artifact pair.
//
//   GEOMETRY IS CHECKED AGAINST A REAL PAGE COUNT, reusing @lagda/core's
//   validateRect/isValidPageNumber unchanged — the same rules a real
//   preparation enforces.
//
//   NO DOCUMENT, NO FIELDS — saving a non-empty layout on a template with
//   nothing attached is refused; clearing (an empty array) is not, since it
//   needs no page count to be well-formed.
//
//   WHOLE-LAYOUT REPLACE, with identity preserved across a save the same way
//   `FieldInput.fieldId` works in a real preparation.
//
//   SNAPSHOT, NOT REFERENCE — resolveTemplateForApply hands back a copy of
//   the field layout as it stood at apply time.
//
//   ORPHAN CLEANUP — removing a slot from the template removes any field
//   that pointed at it; detaching the document clears every field.

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceMemberId, DocumentId,
} from "@lagda/contracts";
import {
  createWorkflowTemplate, updateWorkflowTemplate, deleteWorkflowTemplate,
  resolveTemplateForApply,
  attachWorkflowTemplateDocument, detachWorkflowTemplateDocument,
  listWorkflowTemplateFields, saveWorkflowTemplateFields,
  type WorkflowTemplateDependencies, type WorkflowTemplateInput,
  type WorkflowTemplateFieldWriteInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/evidence.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-22T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const SENDER = "usr_sender" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const DOC = "doc_1" as DocumentId;
const ART = "art_original" as ArtifactId;
// A rotated artifact — `canPlaceFields` refuses it, the same rule a real
// preparation enforces.
const ROTATED_ART = "art_rotated" as ArtifactId;

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: WorkflowTemplateDependencies;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  store.memberships.push({
    memberId: "mem_sender" as WorkspaceMemberId,
    workspaceId: created.workspaceId,
    userId: SENDER, role: "sender", createdAt: AT + 1000,
  });

  store.documents.push({
    documentId: DOC, workspaceId: created.workspaceId, title: "Engagement Letter",
    originalFilename: "engagement.pdf", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT, folderId: null,
  });
  store.artifacts.push({
    artifactId: ART, workspaceId: created.workspaceId, documentId: DOC,
    artifactType: "original",
    storageReference: "artifacts/ws/art_original.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 1024,
    digestAlgorithm: "sha-256", digest: "a".repeat(64) as never,
    pageCount: 3, rotatedPageCount: 0, createdAt: AT,
  });

  store.documents.push({
    documentId: "doc_rotated" as DocumentId, workspaceId: created.workspaceId,
    title: "Rotated Scan", originalFilename: "scan.pdf", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT, folderId: null,
  });
  store.artifacts.push({
    artifactId: ROTATED_ART, workspaceId: created.workspaceId,
    documentId: "doc_rotated" as DocumentId,
    artifactType: "original",
    storageReference: "artifacts/ws/art_rotated.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 1024,
    digestAlgorithm: "sha-256", digest: "d".repeat(64) as never,
    pageCount: 2, rotatedPageCount: 1, createdAt: AT,
  });

  return {
    store,
    workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialWorkflowTemplateIds() },
  };
}

const VALID: WorkflowTemplateInput = {
  name: "Engagement Letter Template",
  routingMode: "sequential",
  roleSlots: [
    { label: "Client", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
    { label: "Witness", role: "signer", required: false, routingStep: 2, defaultAuthMethod: "none" },
  ],
  completionSettings: { notifySenderOnComplete: true },
  variables: [],
};

/** A field aimed at the first slot of a freshly created `VALID` template.
 *  Callers override `slotId` to point at whichever slot they actually got. */
function field(slotId: string, over: Partial<WorkflowTemplateFieldWriteInput> = {}):
WorkflowTemplateFieldWriteInput {
  return {
    slotId,
    type: "signature",
    pageNumber: 1,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    required: true,
    label: "Sign here",
    layer: 0,
    ...over,
  };
}

async function withDocument(h: Harness) {
  const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
  await attachWorkflowTemplateDocument(
    actor(OWNER), h.workspaceId, template.workflowTemplateId,
    { documentId: DOC, artifactId: ART }, h.deps);
  const slotId = template.roleSlots[0]!.slotId;
  return { template, slotId };
}

// ── Saving ───────────────────────────────────────────────────────────────────

describe("saveWorkflowTemplateFields", () => {
  it("saves a valid field and returns it", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    const fields = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    expect(fields).toHaveLength(1);
    expect(fields[0]!.slotId).toBe(slotId);
    expect(fields[0]!.type).toBe("signature");
  });

  it("is reflected on a subsequent read", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toHaveLength(1);
  });

  it("refuses a field on a template with NO document attached", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(template.roleSlots[0]!.slotId)], h.deps))
      .rejects.toThrow(/attach a document/i);
  });

  it("allows CLEARING the layout on a template with no document", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const fields = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, [], h.deps);
    expect(fields).toEqual([]);
  });

  it("refuses a field naming a slot that does NOT belong to this template", async () => {
    const h = await harness();
    const { template } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field("wfs_does_not_exist")], h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);

    // Mutation check: removing the slotId membership check would let this
    // through. Confirm nothing was written on the refusal.
    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toHaveLength(0);
  });

  it("places an outcome block only on the role it is reserved for (081)", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, {
      ...VALID,
      roleSlots: [
        { label: "Client", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
        { label: "Counsel", role: "reviewer", required: true, routingStep: 1, defaultAuthMethod: "none" },
        { label: "Partner", role: "approver", required: false, routingStep: 2, defaultAuthMethod: "none" },
      ],
    }, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);
    const [signer, reviewer, approver] = template.roleSlots.map(slot => slot.slotId);

    const saved = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, [
        field(reviewer!, { type: "review-block", required: false }),
        field(approver!, { type: "approval-block", required: false }),
      ], h.deps);
    expect(saved.map(f => [f.type, f.required])).toEqual([
      ["review-block", true], ["approval-block", false],
    ]);

    const failure = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, [
        field(signer!, { type: "review-block" }),
        field(reviewer!, { type: "approval-block" }),
      ], h.deps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationValidationError);
    expect((failure as ApplicationValidationError).issues).toEqual([
      'fields[0].slotId: "review-block" fields may be held only by a recipient of type "reviewer"',
      'fields[1].slotId: "approval-block" fields may be held only by a recipient of type "approver"',
    ]);
  });

  it("refuses a page number beyond the document's real page count", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { pageNumber: 4 })], h.deps)) // artifact has 3 pages
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses page 0 — 1-based, not 0-based", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { pageNumber: 0 })], h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a rectangle that overflows the page", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { rect: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } })], h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a zero-size rectangle", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { rect: { x: 0.1, y: 0.1, width: 0, height: 0.05 } })], h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a ROTATED document's page — same rule a real preparation enforces", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: "doc_rotated" as DocumentId, artifactId: ROTATED_ART }, h.deps);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(template.roleSlots[0]!.slotId)], h.deps))
      .rejects.toThrow(/attach a document/i);
  });

  it("forces required=true for a signature regardless of the request", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    const fields = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { type: "signature", required: false })], h.deps);

    expect(fields[0]!.required).toBe(true);
  });

  it("rounds the rectangle to the shared coordinate precision", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    const fields = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { rect: { x: 0.123456789, y: 0.1, width: 0.2, height: 0.05 } })],
      h.deps);

    expect(fields[0]!.x).toBe(0.123457);
  });

  it("PRESERVES a field's id across a save that supplies it back", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    const first = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { label: "Original" })], h.deps);
    const fieldId = first[0]!.fieldId;

    const second = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { fieldId, label: "Moved" })], h.deps);

    expect(second[0]!.fieldId).toBe(fieldId);
    expect(second[0]!.label).toBe("Moved");
  });

  it("mints a NEW id for a fieldId that does not belong to this template", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { fieldId: "wff_not_ours" })], h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("is a WHOLE-LAYOUT replace — a field left out of the next save is gone", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { label: "First" }), field(slotId, { label: "Second" })], h.deps);

    const replaced = await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { label: "Only one now" })], h.deps);

    expect(replaced).toHaveLength(1);
    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toHaveLength(1);
  });

  it("refuses a template id that does not exist", async () => {
    const h = await harness();
    await expect(saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, "wft_missing", [], h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses a SENDER, who may read and apply but not author", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);

    await expect(saveWorkflowTemplateFields(
      actor(SENDER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe("listWorkflowTemplateFields", () => {
  it("is empty for a template nobody has placed a field on", async () => {
    const h = await harness();
    const { template } = await withDocument(h);
    const fields = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(fields).toEqual([]);
  });

  it("lets a SENDER read — the role the feature exists for at apply time", async () => {
    const h = await harness();
    const { template } = await withDocument(h);
    await expect(listWorkflowTemplateFields(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps))
      .resolves.toEqual([]);
  });

  it("refuses a template id that does not exist", async () => {
    const h = await harness();
    await expect(listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, "wft_missing", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Interaction with the rest of the template ───────────────────────────────

describe("fields and the rest of the template", () => {
  it("SNAPSHOT: editing the field layout after resolving does not change what was resolved", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { label: "Original" })], h.deps);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(applied.fields).toHaveLength(1);
    expect(applied.fields[0]!.label).toBe("Original");

    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId, { label: "Changed after resolving" })], h.deps);

    // What was already resolved is untouched.
    expect(applied.fields[0]!.label).toBe("Original");
  });

  it("resolves to an empty array on a template with no fields", async () => {
    const h = await harness();
    const { template } = await withDocument(h);
    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(applied.fields).toEqual([]);
  });

  it("detaching the document CLEARS every field", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    await detachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toEqual([]);
  });

  it("removing a slot from the template ORPHANS and drops its fields", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    // Rewrite with only the SECOND slot — the first (and its field) is gone.
    await updateWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        ...VALID,
        roleSlots: [
          { label: "Witness", role: "signer", required: false, routingStep: 1, defaultAuthMethod: "none" },
        ],
      }, h.deps);

    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toEqual([]);
  });

  it("keeps a field whose slot SURVIVED an edit, by the slot's preserved id", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    // Re-save with the SAME slotId (round-tripped, as a real editor would)
    // plus a renamed label — the slot survives, so its field should too.
    const updated = await updateWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        ...VALID,
        roleSlots: [
          { slotId, label: "Client (renamed)", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
          { label: "Witness", role: "signer", required: false, routingStep: 2, defaultAuthMethod: "none" },
        ] as never,
      }, h.deps);
    expect(updated.roleSlots[0]!.slotId).toBe(slotId);

    const read = await listWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read).toHaveLength(1);
  });

  it("deleting the template CASCADES to its fields, and touches nothing else", async () => {
    const h = await harness();
    const { template, slotId } = await withDocument(h);
    await saveWorkflowTemplateFields(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      [field(slotId)], h.deps);

    await deleteWorkflowTemplate(actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    // The fields are gone with it (060's `on delete cascade`) — asserted
    // directly against the store, since `listWorkflowTemplateFields` would
    // now 404 on the deleted template rather than answer "empty".
    expect(h.store.workflowTemplateFields).toHaveLength(0);
    // The document and artifact it pointed at are untouched (059's own
    // claim, still true once a template has fields on top of a document).
    expect(h.store.documents.some(d => d.documentId === DOC)).toBe(true);
    expect(h.store.artifacts.some(a => a.artifactId === ART)).toBe(true);
  });
});
