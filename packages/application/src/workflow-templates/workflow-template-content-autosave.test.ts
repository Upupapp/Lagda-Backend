// Autosaving a template's authored content (088).
//
// The claims that carry weight here:
//
//   DRAFT ONLY. An autosave writes the draft, its revision and when it was
//   saved — never the rendered `content`, the page count, the document pair,
//   the fields or `updatedAt` — and never calls the generator.
//
//   OPTIMISTIC CONCURRENCY. A save naming a stale `baseRevision` is refused
//   with `template_content_conflict` carrying the current revision, and
//   writes nothing.
//
//   THE GENERATED FLAG. False before any generate; true right after one;
//   false again once a draft is saved after it; true again on the next
//   generate, which also supersedes the draft.
//
//   SAME CAPABILITY AS EDITING. A sender (read-only) cannot autosave.
//
//   NOTHING IN THE ACTIVITY LOG.

import { describe, it, expect, vi } from "vitest";
import type {
  UserId, WorkspaceMemberId, DocumentId, Sha256Digest, FlowDocument,
} from "@lagda/contracts";
import {
  createWorkflowTemplate, generateWorkflowTemplateDocument, getWorkflowTemplate,
  saveWorkflowTemplateContent, WorkflowTemplateContentConflictError,
  WorkflowTemplateMalformedError,
  type WorkflowTemplateGenerateDocumentDependencies, type WorkflowTemplateInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/evidence.js";
import type { StorageObjectRef } from "../common/ports/storage.js";
import type { GenerateFlowDocumentResult } from "../common/ports/flow-document.js";
import { createInMemoryObjectStorage } from "../test-support/in-memory-object-storage.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-27T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const SENDER = "usr_sender" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const INPUT: WorkflowTemplateInput = {
  name: "Offer Letter",
  routingMode: "sequential",
  roleSlots: [{
    label: "Employee", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none",
  }],
  completionSettings: { notifySenderOnComplete: true },
  variables: [],
};

const doc = (text: string): FlowDocument => ({
  kind: "flowDocument",
  content: [{ kind: "paragraph", content: [{ kind: "text", text }] }],
});

/** A clock the test can advance, so "saved at" is observable per save. */
class SteppingClock {
  constructor(private at: number) {}
  now = (): number => this.at;
  advance(ms: number): void { this.at += ms; }
}

async function harness() {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new SteppingClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT),
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT),
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  store.memberships.push({
    memberId: "mem_sender" as WorkspaceMemberId, workspaceId: created.workspaceId,
    userId: SENDER, role: "sender", createdAt: AT,
  });

  const generate = vi.fn(
    (): Promise<GenerateFlowDocumentResult> => Promise.resolve({
      bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
      digest: "a".repeat(64) as Sha256Digest,
      pageCount: 1,
      resolvedAnchors: [],
    }),
  );
  let documents = 0;
  let artifacts = 0;
  const deps: WorkflowTemplateGenerateDocumentDependencies = {
    transactions,
    clock,
    ids: new SequentialWorkflowTemplateIds(),
    storage: createInMemoryObjectStorage({ now: () => AT }),
    keys: {
      artifactKey: ({ workspaceId, documentId, artifactId }): StorageObjectRef => ({
        zone: "artifacts", key: `${workspaceId}/${documentId}/${artifactId}` as never,
      }),
      quarantineKey: ({ uploadId }): StorageObjectRef => ({ zone: "quarantine", key: uploadId as never }),
    },
    flowDocumentGenerator: { generate },
    documentIds: { nextDocumentId: () => `doc_${String(++documents)}` as DocumentId },
    artifactIds: { nextArtifactId: () => `art_${String(++artifacts)}` as ArtifactId },
  };

  const template = await createWorkflowTemplate(actor(OWNER), created.workspaceId, INPUT, deps);
  return {
    store, clock, deps, generate, workspaceId: created.workspaceId,
    templateId: template.workflowTemplateId,
  };
}

describe("autosaving a template's content", () => {
  it("starts at revision 0, not generated", async () => {
    const h = await harness();
    const read = await getWorkflowTemplate(actor(OWNER), h.workspaceId, h.templateId, h.deps);
    expect(read.contentRevision).toBe(0);
    expect(read.contentGenerated).toBe(false);
    expect(read.contentSavedAt).toBe(AT);
  });

  it("saves ONLY the draft — no render, no document, no updatedAt", async () => {
    const h = await harness();
    h.clock.advance(5_000);

    const saved = await saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("Draft text.") }, h.deps);

    expect(saved).toEqual({ contentRevision: 1, contentSavedAt: AT + 5_000, contentGenerated: false });
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.store.documents).toHaveLength(0);
    expect(h.store.artifacts).toHaveLength(0);

    const read = await getWorkflowTemplate(actor(OWNER), h.workspaceId, h.templateId, h.deps);
    expect(read.content).toEqual(doc("Draft text."));
    expect(read.contentRevision).toBe(1);
    expect(read.contentSavedAt).toBe(AT + 5_000);
    expect(read.updatedAt).toBe(AT);
    expect(read.documentId).toBeNull();
    expect(read.contentPageCount).toBe(0);
  });

  it("bumps the revision monotonically across saves", async () => {
    const h = await harness();
    const revisions: number[] = [];
    for (const text of ["a", "ab", "abc"]) {
      const saved = await saveWorkflowTemplateContent(
        actor(OWNER), h.workspaceId, h.templateId,
        { content: doc(text), baseRevision: revisions.at(-1) ?? 0 }, h.deps);
      revisions.push(saved.contentRevision);
    }
    expect(revisions).toEqual([1, 2, 3]);
  });

  it("refuses a STALE baseRevision with the current revision, and writes nothing", async () => {
    const h = await harness();
    await saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("tab one"), baseRevision: 0 }, h.deps);

    const attempt = saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("tab two"), baseRevision: 0 }, h.deps);
    await expect(attempt).rejects.toBeInstanceOf(WorkflowTemplateContentConflictError);
    const error = await attempt.catch((e: unknown) => e) as WorkflowTemplateContentConflictError;
    expect(error.code).toBe("template_content_conflict");
    expect(error.category).toBe("conflict");
    expect(error.currentRevision).toBe(1);
    expect(error.details[0]?.message).toContain("1");

    const read = await getWorkflowTemplate(actor(OWNER), h.workspaceId, h.templateId, h.deps);
    expect(read.content).toEqual(doc("tab one"));
    expect(read.contentRevision).toBe(1);
  });

  it("overwrites unconditionally when no baseRevision is given", async () => {
    const h = await harness();
    await saveWorkflowTemplateContent(actor(OWNER), h.workspaceId, h.templateId, { content: doc("a") }, h.deps);
    const saved = await saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("b") }, h.deps);
    expect(saved.contentRevision).toBe(2);
  });

  it("refuses a SENDER — the same capability as editing the template", async () => {
    const h = await harness();
    await expect(saveWorkflowTemplateContent(
      actor(SENDER), h.workspaceId, h.templateId, { content: doc("x") }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
    const read = await getWorkflowTemplate(actor(OWNER), h.workspaceId, h.templateId, h.deps);
    expect(read.contentRevision).toBe(0);
  });

  it("404s a template that does not exist", async () => {
    const h = await harness();
    await expect(saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, "wft_missing", { content: doc("x") }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses content generate-document would refuse on read (anchor naming both targets)", async () => {
    const h = await harness();
    const bad = {
      kind: "flowDocument",
      content: [{
        kind: "paragraph",
        content: [{
          kind: "fieldAnchor", fieldType: "signature", slotId: "s", variableKey: "v",
          required: true, label: "Sign",
        }],
      }],
    } as unknown as FlowDocument;
    await expect(saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: bad }, h.deps,
    )).rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
    await expect(saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId,
      { content: { kind: "nope" } as unknown as FlowDocument }, h.deps,
    )).rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
    await expect(saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("x"), baseRevision: -1 }, h.deps,
    )).rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("walks the generated flag through generate → autosave → generate", async () => {
    const h = await harness();

    const { template: generated } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("v1") }, h.deps);
    expect(generated.contentGenerated).toBe(true);
    expect(generated.contentRevision).toBe(1);

    const draft = await saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("v2 draft"), baseRevision: 1 }, h.deps);
    expect(draft).toMatchObject({ contentRevision: 2, contentGenerated: false });

    const afterDraft = await getWorkflowTemplate(actor(OWNER), h.workspaceId, h.templateId, h.deps);
    // The DRAFT is what a reload shows; the rendered PDF is untouched.
    expect(afterDraft.content).toEqual(doc("v2 draft"));
    expect(afterDraft.contentGenerated).toBe(false);
    expect(afterDraft.documentId).toBe(generated.documentId);
    expect(afterDraft.contentPageCount).toBe(1);

    const { template: regenerated } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("v2 final") }, h.deps);
    expect(regenerated.contentRevision).toBe(3);
    expect(regenerated.contentGenerated).toBe(true);
    expect(regenerated.content).toEqual(doc("v2 final"));

    // A save from the pre-generate base is now stale.
    await expect(saveWorkflowTemplateContent(
      actor(OWNER), h.workspaceId, h.templateId, { content: doc("late"), baseRevision: 2 }, h.deps,
    )).rejects.toBeInstanceOf(WorkflowTemplateContentConflictError);
  });

  it("records nothing in the workspace activity log", async () => {
    const h = await harness();
    const before = h.store.activity.length;
    for (let i = 0; i < 5; i++) {
      await saveWorkflowTemplateContent(
        actor(OWNER), h.workspaceId, h.templateId, { content: doc(`keystroke ${String(i)}`) }, h.deps);
    }
    expect(h.store.activity).toHaveLength(before);
  });
});
