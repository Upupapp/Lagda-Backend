// Generating a template's OWN document from authored content (066).
//
// A FAKE `TemplateDocumentGenerator`, not the real one — application never
// imports `@lagda/sealing` (an architecture guard enforces it; the port is
// defined here and IMPLEMENTED there, and an import the other way would
// invert that). This file proves the USE CASE's orchestration: validation
// BEFORE any byte is produced, bytes-before-rows, and regenerate-replaces.
// The renderer itself — real PDFs, word-wrap, the overflow refusal — is
// proven in `packages/sealing`'s own
// `node-template-document-generator.test.ts`, the same split
// `field-merge.test.ts` already makes for `FieldMerger`.
//
// The claims that carry weight here:
//
//   BYTES BEFORE ROWS. A generate that fails VALIDATION (bad page number, a
//   rectangle off the page) writes nothing — no document, no artifact, no
//   content, and the generator is never even called.
//
//   A GENERATOR FAILURE writes nothing either — the same ordering, one layer
//   later.
//
//   REGENERATING REPLACES. A second generate on the same template produces a
//   NEW document/artifact pair and the template points at the new one.

import { describe, it, expect, vi } from "vitest";
import type {
  UserId, WorkspaceId, DocumentId, Sha256Digest,
} from "@lagda/contracts";
import {
  createWorkflowTemplate, generateWorkflowTemplateDocument,
  type WorkflowTemplateGenerateDocumentDependencies, type WorkflowTemplateInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/evidence.js";
import type { StorageObjectRef } from "../common/ports/storage.js";
import type {
  TemplateDocumentGenerator, GenerateTemplateDocumentResult,
} from "../common/ports/template-content.js";
import { createInMemoryObjectStorage, collect } from "../test-support/in-memory-object-storage.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

/** A minimal, deterministic stand-in for `NodeTemplateDocumentGenerator`.
 *  Produces bytes that LOOK like a PDF (the magic bytes a real reader checks
 *  for) without any real rendering — this file is not the one proving
 *  rendering works.
 *
 *  Returns the spy as its OWN value, not as a property read off the port
 *  object — the port's `generate` is a method-shorthand interface member, and
 *  reading it back off an object (`generator.generate`) trips
 *  `@typescript-eslint/unbound-method`. */
function fakeGenerator(): { port: TemplateDocumentGenerator; generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(
    (): Promise<GenerateTemplateDocumentResult> => Promise.resolve({
      bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
      digest: "a".repeat(64) as Sha256Digest,
      pageCount: 1,
    }),
  );
  return { port: { generate }, generate };
}

const AT = Date.parse("2026-09-23T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const ROLE_SLOTS: WorkflowTemplateInput["roleSlots"] = [
  {
    label: "Employee", role: "signer", required: true,
    routingStep: 1, defaultAuthMethod: "none",
  },
];

const SETTINGS: WorkflowTemplateInput["completionSettings"] = { notifySenderOnComplete: true };

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: WorkflowTemplateGenerateDocumentDependencies;
  readonly storage: ReturnType<typeof createInMemoryObjectStorage>;
  readonly generator: ReturnType<typeof fakeGenerator>;
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

  const storage = createInMemoryObjectStorage({ now: () => AT });
  const generator = fakeGenerator();

  let documentCounter = 0;
  let artifactCounter = 0;

  const deps: WorkflowTemplateGenerateDocumentDependencies = {
    transactions,
    clock,
    ids: new SequentialWorkflowTemplateIds(),
    storage,
    // A trivial, deterministic strategy — no dependency on the real S3
    // package from an application-layer test.
    keys: {
      artifactKey: ({ workspaceId, documentId, artifactId }): StorageObjectRef => ({
        zone: "artifacts",
        key: `${workspaceId}/${documentId}/${artifactId}` as never,
      }),
      quarantineKey: ({ uploadId }): StorageObjectRef => ({
        zone: "quarantine", key: uploadId as never,
      }),
    },
    templateDocumentGenerator: generator.port,
    documentIds: { nextDocumentId: () => `doc_${String(++documentCounter)}` as DocumentId },
    artifactIds: { nextArtifactId: () => `art_${String(++artifactCounter)}` as ArtifactId },
  };

  return { store, workspaceId: created.workspaceId, deps, storage, generator };
}

describe("generating a template's own document", () => {
  it("renders, uploads and attaches the document", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "Offer Letter", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    const updated = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 1,
        blocks: [{
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          text: "This offer letter confirms your position.",
        }],
      },
      h.deps);

    expect(updated.documentId).not.toBeNull();
    expect(updated.sourceArtifactId).not.toBeNull();
    expect(updated.contentBlocks).toHaveLength(1);
    expect(updated.contentBlocks[0]?.text).toBe("This offer letter confirms your position.");
    expect(updated.contentPageCount).toBe(1);

    const stored = h.store.artifacts.find(a => a.artifactId === updated.sourceArtifactId);
    expect(stored?.artifactType).toBe("original");
    expect(stored?.pageCount).toBe(1);
    expect(stored?.rotatedPageCount).toBe(0);

    const objectContent = await h.storage.getObject({
      zone: "artifacts", key: stored!.storageReference,
    });
    expect(objectContent).not.toBeNull();
    const bytes = await collect(objectContent!.stream);
    const magic = new TextDecoder().decode(bytes.slice(0, 5));
    expect(magic).toBe("%PDF-");
    expect(h.generator.generate).toHaveBeenCalledTimes(1);
  });

  it("writes NOTHING and never calls the generator when a block names a page beyond pageCount", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 1,
        blocks: [{
          pageNumber: 2, rect: { x: 0, y: 0, width: 0.5, height: 0.1 }, text: "Off the end.",
        }],
      },
      h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);

    // Nothing rendered, nothing uploaded, nothing attached.
    expect(h.storage.size).toBe(0);
    expect(h.generator.generate).not.toHaveBeenCalled();
    const reread = h.store.workflowTemplates.find(
      t => t.workflowTemplateId === template.workflowTemplateId);
    expect(reread?.documentId).toBeNull();
  });

  it("writes NOTHING and never calls the generator when a rectangle runs off the page", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 1,
        blocks: [{
          pageNumber: 1, rect: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, text: "Runs off.",
        }],
      },
      h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);

    expect(h.storage.size).toBe(0);
    expect(h.generator.generate).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the generator itself refuses (e.g. text does not fit)", async () => {
    // The renderer's own refusals (an unfittable block, an unrenderable code
    // point) are proven for real in `node-template-document-generator.test.ts`
    // — this proves only that THIS layer reacts to one correctly: no bytes
    // uploaded, no rows written, and the caller sees a 422, not a 500.
    const h = await harness();
    h.generator.generate.mockRejectedValueOnce(new Error("does not fit its box"));
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 1,
        blocks: [{
          pageNumber: 1, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 }, text: "Anything.",
        }],
      },
      h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);

    expect(h.storage.size).toBe(0);
  });

  it("404s a template that does not exist", async () => {
    const h = await harness();
    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, "wft_missing",
      { pageCount: 1, blocks: [] },
      h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REGENERATING replaces — the template ends up pointing at the NEW pair", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    const first = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 1,
        blocks: [{
          pageNumber: 1, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 }, text: "First version.",
        }],
      },
      h.deps);

    const second = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      {
        pageCount: 2,
        blocks: [{
          pageNumber: 2, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 }, text: "Second version.",
        }],
      },
      h.deps);

    expect(second.sourceArtifactId).not.toBe(first.sourceArtifactId);
    expect(second.contentPageCount).toBe(2);
    expect(second.contentBlocks).toHaveLength(1);
    expect(second.contentBlocks[0]?.text).toBe("Second version.");
  });
});
