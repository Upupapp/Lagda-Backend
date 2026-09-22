// A workflow template's attached document (migration 059).
//
// The claims that carry weight:
//
//   THE PAIR IS VERIFIED, NEVER TRUSTED. attachWorkflowTemplateDocument does
//   not take the caller's word that an artifact belongs to a document, or
//   that it is the pristine upload rather than a sealed output. Both are
//   checked against the actual rows before anything is written.
//
//   AUTHORIZATION mirrors the write path exactly — attaching a document is
//   editing the template, not a separate capability.
//
//   SNAPSHOT, NOT REFERENCE, still holds. resolveTemplateForApply hands back
//   a copy of the document reference as it stood at apply time; re-attaching
//   a different document afterwards does not reach back into it.
//
//   NAME/SLOTS UPDATES DO NOT TOUCH THE DOCUMENT. A PUT to the template's
//   shape must not silently detach what it points at as a side effect.

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceMemberId, DocumentId,
} from "@lagda/contracts";
import {
  createWorkflowTemplate, updateWorkflowTemplate, deleteWorkflowTemplate,
  getWorkflowTemplate, resolveTemplateForApply,
  attachWorkflowTemplateDocument, detachWorkflowTemplateDocument,
  WorkflowTemplateDocumentMismatchError,
  type WorkflowTemplateDependencies, type WorkflowTemplateInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
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
const SEALED_ART = "art_sealed" as ArtifactId;
const OTHER_DOC_ART = "art_other_doc" as ArtifactId;

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

  // The document and its ORIGINAL artifact — the pair a real attach would
  // name, produced by the ordinary create-then-upload path this use case
  // deliberately does not reimplement.
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

  // A SEALED artifact of the SAME document — the wrong type to attach.
  store.artifacts.push({
    artifactId: SEALED_ART, workspaceId: created.workspaceId, documentId: DOC,
    artifactType: "sealed",
    storageReference: "artifacts/ws/art_sealed.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 1024,
    digestAlgorithm: "sha-256", digest: "b".repeat(64) as never,
    pageCount: 3, rotatedPageCount: 0, createdAt: AT,
  });

  // An artifact belonging to a DIFFERENT document — the mismatched-pair case.
  store.documents.push({
    documentId: "doc_2" as DocumentId, workspaceId: created.workspaceId, title: "NDA",
    originalFilename: "nda.pdf", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT, folderId: null,
  });
  store.artifacts.push({
    artifactId: OTHER_DOC_ART, workspaceId: created.workspaceId,
    documentId: "doc_2" as DocumentId,
    artifactType: "original",
    storageReference: "artifacts/ws/art_other.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 512,
    digestAlgorithm: "sha-256", digest: "c".repeat(64) as never,
    pageCount: 1, rotatedPageCount: 0, createdAt: AT,
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
  ],
  completionSettings: { notifySenderOnComplete: true },
};

// ── Attaching ────────────────────────────────────────────────────────────────

describe("attachWorkflowTemplateDocument", () => {
  it("attaches a verified document and artifact", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const attached = await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    expect(attached.documentId).toBe(DOC);
    expect(attached.sourceArtifactId).toBe(ART);
  });

  it("bumps updatedAt", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    // A fresh deps object with a later clock, rather than mutating `h.deps`
    // — `WorkflowTemplateDependencies.clock` is readonly, deliberately: a
    // use case that could swap its own clock mid-transaction is a use case
    // that could read two different "now"s for one write.
    const attached = await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART },
      { ...h.deps, clock: new FixedClock(AT + 5000) });

    expect(attached.updatedAt).toBe(AT + 5000);
    expect(attached.updatedAt).toBeGreaterThan(template.updatedAt);
  });

  it("is reflected on a subsequent read", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    const read = await getWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read.documentId).toBe(DOC);
    expect(read.sourceArtifactId).toBe(ART);
  });

  it("refuses an artifact belonging to a DIFFERENT document", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: OTHER_DOC_ART }, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateDocumentMismatchError);

    // Refused whole — nothing was written.
    const read = await getWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(read.documentId).toBeNull();
  });

  it("refuses a SEALED artifact — only the original upload may be attached", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: SEALED_ART }, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateDocumentMismatchError);
  });

  it("refuses a document id that does not exist in this workspace", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: "doc_missing" as DocumentId, artifactId: ART }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses an artifact id that does not exist", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: "art_missing" as ArtifactId }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses a template id that does not exist", async () => {
    const h = await harness();
    await expect(attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, "wft_missing",
      { documentId: DOC, artifactId: ART }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses a SENDER, who may read and apply but not author", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(attachWorkflowTemplateDocument(
      actor(SENDER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Detaching ────────────────────────────────────────────────────────────────

describe("detachWorkflowTemplateDocument", () => {
  it("clears both fields", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    const detached = await detachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(detached.documentId).toBeNull();
    expect(detached.sourceArtifactId).toBeNull();
  });

  it("leaves the document and artifact themselves untouched", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    await detachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    // Still in the store — detaching a reference is not deleting the thing
    // referenced.
    expect(h.store.documents.some(d => d.documentId === DOC)).toBe(true);
    expect(h.store.artifacts.some(a => a.artifactId === ART)).toBe(true);
  });

  it("succeeds on a template that never had a document — idempotent", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const detached = await detachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(detached.documentId).toBeNull();
  });

  it("refuses a SENDER", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await expect(detachWorkflowTemplateDocument(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Interaction with the rest of the template ───────────────────────────────

describe("the document reference and the rest of the template", () => {
  it("survives a PUT to name, slots and routing — attaching is not part of that write", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    const updated = await updateWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { ...VALID, name: "Renamed" }, h.deps);

    expect(updated.name).toBe("Renamed");
    expect(updated.documentId).toBe(DOC);
    expect(updated.sourceArtifactId).toBe(ART);
  });

  it("is included in what a SENDER resolves when applying the template", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(applied.documentId).toBe(DOC);
    expect(applied.sourceArtifactId).toBe(ART);
  });

  it("resolves to null on a template with no document — the pre-059 case", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(applied.documentId).toBeNull();
    expect(applied.sourceArtifactId).toBeNull();
  });

  it("SNAPSHOT: re-attaching a different document does not change what was already resolved", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(applied.documentId).toBe(DOC);

    // The template is re-pointed at a different document afterwards.
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: "doc_2" as DocumentId, artifactId: OTHER_DOC_ART }, h.deps);

    // What was already resolved is untouched — it is a copy, not a pointer.
    expect(applied.documentId).toBe(DOC);
    expect(applied.sourceArtifactId).toBe(ART);
  });

  it("deleting the template deletes no document or artifact", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await attachWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { documentId: DOC, artifactId: ART }, h.deps);

    await deleteWorkflowTemplate(actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(h.store.documents.some(d => d.documentId === DOC)).toBe(true);
    expect(h.store.artifacts.some(a => a.artifactId === ART)).toBe(true);
  });
});
