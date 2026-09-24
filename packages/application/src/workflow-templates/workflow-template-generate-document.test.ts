// Generating a template's OWN document from authored content (070).
//
// A FAKE `FlowDocumentGenerator`, not the real one — application never
// imports `@lagda/sealing` (an architecture guard enforces it; the port is
// defined here and IMPLEMENTED there, and an import the other way would
// invert that). This file proves the USE CASE's orchestration: bytes-
// before-rows, and regenerate-replaces. The renderer itself — real PDFs,
// line-wrapping, pagination, the layout-overflow refusal — is proven in
// `packages/sealing`'s own tests, the same split `field-merge.test.ts`
// already makes for `FieldMerger`.
//
// The claims that carry weight here:
//
//   BYTES BEFORE ROWS. A GENERATOR FAILURE (an unrenderable code point, a
//   document too long to lay out) writes nothing — no document, no
//   artifact, no content.
//
//   RESOLVED ANCHORS pass through to the caller, in document order, and are
//   NOT written to `workflow_template_fields` by this use case — that is a
//   separate act with its own capability, left to the caller.
//
//   REGENERATING REPLACES. A second generate on the same template produces a
//   NEW document/artifact pair and the template points at the new one.

import { describe, it, expect, vi } from "vitest";
import type {
  UserId, WorkspaceId, DocumentId, Sha256Digest, FlowDocument,
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
  FlowDocumentGenerator, GenerateFlowDocumentResult,
} from "../common/ports/flow-document.js";
import { createInMemoryObjectStorage, collect } from "../test-support/in-memory-object-storage.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

/** A minimal, deterministic stand-in for `NodeFlowDocumentGenerator`.
 *  Produces bytes that LOOK like a PDF (the magic bytes a real reader checks
 *  for) without any real rendering, and a page count/anchor list the test
 *  controls directly — this file is not the one proving rendering works. */
function fakeGenerator(
  over: { pageCount?: number; resolvedAnchors?: GenerateFlowDocumentResult["resolvedAnchors"] } = {},
): { port: FlowDocumentGenerator; generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(
    (): Promise<GenerateFlowDocumentResult> => Promise.resolve({
      bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
      digest: "a".repeat(64) as Sha256Digest,
      pageCount: over.pageCount ?? 1,
      resolvedAnchors: over.resolvedAnchors ?? [],
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

const SIMPLE_DOC: FlowDocument = {
  kind: "flowDocument",
  content: [
    { kind: "paragraph", content: [{ kind: "text", text: "This offer letter confirms your position." }] },
  ],
};

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: WorkflowTemplateGenerateDocumentDependencies;
  readonly storage: ReturnType<typeof createInMemoryObjectStorage>;
  readonly generator: ReturnType<typeof fakeGenerator>;
}

async function harness(
  generatorOverride?: ReturnType<typeof fakeGenerator>,
): Promise<Harness> {
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
  const generator = generatorOverride ?? fakeGenerator();

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
    flowDocumentGenerator: generator.port,
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

    const { template: updated, resolvedAnchors } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { content: SIMPLE_DOC },
      h.deps);

    expect(updated.documentId).not.toBeNull();
    expect(updated.sourceArtifactId).not.toBeNull();
    expect(updated.content).toEqual(SIMPLE_DOC);
    expect(updated.contentPageCount).toBe(1);
    expect(resolvedAnchors).toEqual([]);

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

  it("passes resolved field anchors straight through, in the generator's own order", async () => {
    const anchors: GenerateFlowDocumentResult["resolvedAnchors"] = [
      {
        fieldType: "signature", slotId: "slot_1", required: true, label: "Employer Signature",
        pageNumber: 1, rect: { x: 0.1, y: 0.8, width: 0.2, height: 0.03 },
      },
      {
        fieldType: "date-signed", variableKey: "signed_on", required: false, label: "Date",
        pageNumber: 1, rect: { x: 0.5, y: 0.8, width: 0.15, height: 0.03 },
      },
    ];
    const h = await harness(fakeGenerator({ resolvedAnchors: anchors }));
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    const { resolvedAnchors } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { content: SIMPLE_DOC },
      h.deps);

    expect(resolvedAnchors).toEqual(anchors);
    // Not persisted by THIS use case — the caller (the route) writes it
    // through `saveWorkflowTemplateFields` separately.
    expect(h.store.workflowTemplateFields).toEqual([]);
  });

  it("writes NOTHING when the generator itself refuses (e.g. an unrenderable code point)", async () => {
    // The renderer's own refusals are proven for real in
    // `packages/sealing`'s tests — this proves only that THIS layer reacts
    // to one correctly: no bytes uploaded, no rows written, and the caller
    // sees a 422, not a 500.
    const h = await harness();
    h.generator.generate.mockRejectedValueOnce(new Error("has no glyph for U+65E5"));
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { content: SIMPLE_DOC },
      h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);

    expect(h.storage.size).toBe(0);
  });

  it("404s a template that does not exist", async () => {
    const h = await harness();
    await expect(generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, "wft_missing",
      { content: { kind: "flowDocument", content: [] } },
      h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REGENERATING replaces — the template ends up pointing at the NEW pair", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      { name: "T", routingMode: "sequential", roleSlots: ROLE_SLOTS, completionSettings: SETTINGS, variables: [] },
      h.deps);

    const { template: first } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { content: { kind: "flowDocument", content: [{ kind: "paragraph", content: [{ kind: "text", text: "First version." }] }] } },
      h.deps);

    h.generator.generate.mockResolvedValueOnce({
      bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
      digest: "b".repeat(64) as Sha256Digest,
      pageCount: 2,
      resolvedAnchors: [],
    });
    const secondDoc: FlowDocument = {
      kind: "flowDocument",
      content: [{ kind: "paragraph", content: [{ kind: "text", text: "Second version." }] }],
    };
    const { template: second } = await generateWorkflowTemplateDocument(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { content: secondDoc },
      h.deps);

    expect(second.sourceArtifactId).not.toBe(first.sourceArtifactId);
    expect(second.contentPageCount).toBe(2);
    expect(second.content).toEqual(secondDoc);
  });
});
