// Signing request creation, tested with fakes.
//
// The claims that carry weight, in the order they matter:
//
//   the snapshot is INDEPENDENT — later edits to the contact, the preparation
//   recipient, the field, the assignment or the document title change nothing;
//
//   the ids are NEW — a request recipient is not a preparation recipient;
//
//   an incoherent authoring state cannot become a workflow;
//
//   a retry replays the ORIGINAL request, even after the preparation moved on;
//
//   nothing is sent.

import { describe, it, expect } from "vitest";
import type {
  ContactId, DocumentId, IdempotencyKey, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  createSigningRequest, getSigningRequest,
  PreparationNotReadyError, DocumentNotPreparedError,
  type SigningRequestDependencies,
} from "./signing-requests.js";
import {
  addRecipient, updateRecipient, type RecipientDependencies,
} from "../recipients/recipients.js";
import {
  saveDocumentPreparation, type PreparationDependencies,
} from "../preparation/preparation.js";
import { renameDocument, type DocumentDependencies } from "../documents/documents.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds, SequentialSigningRequestIds,
  SequentialDocumentIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const DOC = "doc_1" as DocumentId;
const CONTACT = "con_1" as ContactId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: SigningRequestDependencies;
  readonly recipientDeps: RecipientDependencies;
  readonly prepDeps: PreparationDependencies;
  readonly documentDeps: DocumentDependencies;
}

const DIGEST = "b".repeat(64);

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
    memberId: "mem_auditor" as WorkspaceMemberId,
    workspaceId: created.workspaceId,
    userId: AUDITOR, role: "auditor", createdAt: AT + 1000,
  });

  store.documents.push({
    documentId: DOC, workspaceId: created.workspaceId, title: "Office Lease",
    originalFilename: "lease.pdf", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT,
  });
  store.artifacts.push({
    artifactId: "art_original" as ArtifactId,
    workspaceId: created.workspaceId, documentId: DOC, artifactType: "original",
    storageReference: "ws/doc/art" as never,
    mediaType: "application/pdf", sizeBytes: 204_800,
    digestAlgorithm: "sha-256", digest: DIGEST as never,
    pageCount: 5, rotatedPageCount: 0, createdAt: AT + 2000,
  });
  store.contacts.push({
    contactId: CONTACT, workspaceId: created.workspaceId,
    name: "Maria Santos", email: "Maria.Santos@AyalaLand.com.ph",
    emailKey: "maria.santos@ayalaland.com.ph" as never,
    phone: null, organization: "Ayala Land", title: "General Counsel",
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });

  const recipientIds = new SequentialRecipientIds();
  const preparationIds = new SequentialPreparationIds();
  const requestIds = new SequentialSigningRequestIds();
  const authoring = {
    nextRecipientId: () => recipientIds.nextRecipientId(),
    nextPreparationId: () => preparationIds.nextPreparationId(),
    nextPreparationFieldId: () => preparationIds.nextPreparationFieldId(),
  };
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIds(),
    clock,
    policy: { retentionMs: 86_400_000 },
  };

  return {
    store,
    workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: requestIds, idempotency },
    recipientDeps: { transactions, clock, ids: authoring },
    prepDeps: { transactions, clock, ids: authoring },
    documentDeps: { transactions, clock, ids: new SequentialDocumentIds() },
  };
}

const signatureField = (recipientId: string, over: Record<string, unknown> = {}) => ({
  type: "signature" as const,
  pageNumber: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  required: true,
  label: "Landlord signature",
  layer: 0,
  recipientId,
  ...over,
});

/** A document prepared to the point where it can become a request. */
async function ready(h: Harness, over: Record<string, unknown> = {}) {
  const recipient = await addRecipient(
    actor(OWNER), h.workspaceId, DOC,
    {
      source: "contact", contactId: CONTACT, type: "signer",
      ...over,
    } as never, h.recipientDeps);

  await saveDocumentPreparation(
    actor(OWNER), h.workspaceId, DOC,
    { expectedRevision: 1, fields: [signatureField(recipient.recipientId)] },
    h.prepDeps);

  return recipient;
}

// ── Creation ─────────────────────────────────────────────────────────────────

describe("createSigningRequest", () => {
  it("creates one request with the recipients and fields of the preparation", async () => {
    const h = await harness();
    await ready(h);

    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    expect(created.state).toBe("draft");
    expect(created.recipientCount).toBe(1);
    expect(created.fieldCount).toBe(1);
    expect(h.store.signingRequests).toHaveLength(1);
  });

  it("snapshots the exact source artifact the preparation named", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(h.store.signingRequests[0]?.sourceArtifactId).toBe("art_original");
  });

  it("snapshots the preparation revision it was built from", async () => {
    const h = await harness();
    await ready(h);
    const revision = h.store.preparations[0]?.revision;
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(h.store.signingRequests[0]?.sourcePreparationRevision).toBe(revision);
  });

  it("records the creator from the session", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(h.store.signingRequests[0]?.createdByUserId).toBe(OWNER);
  });

  it("copies the recipient's snapshot values", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const snapshot = h.store.signingRequestRecipients[0];
    expect(snapshot?.name).toBe("Maria Santos");
    // The DISPLAY address, with its original casing.
    expect(snapshot?.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(snapshot?.organization).toBe("Ayala Land");
    expect(snapshot?.type).toBe("signer");
    expect(snapshot?.routingOrder).toBe(1);
  });

  it("copies the field geometry exactly, without re-rounding", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const source = h.store.preparationFields[0];
    const snapshot = h.store.signingRequestFields[0];
    expect(snapshot?.x).toBe(source?.x);
    expect(snapshot?.y).toBe(source?.y);
    expect(snapshot?.width).toBe(source?.width);
    expect(snapshot?.height).toBe(source?.height);
    expect(snapshot?.pageNumber).toBe(source?.pageNumber);
    expect(snapshot?.label).toBe(source?.label);
    expect(snapshot?.required).toBe(source?.required);
  });

  it("permits a second request from the same document", async () => {
    // No unique constraint. The evidence for one-per-document was a fixture
    // display shape and a rule about a different aggregate.
    const h = await harness();
    await ready(h);
    const first = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    const second = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(second.signingRequestId).not.toBe(first.signingRequestId);
    expect(h.store.signingRequests).toHaveLength(2);
  });

  it("does not freeze the preparation", async () => {
    // Freezing would make the second request above impossible.
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(h.store.preparations[0]?.lockedAt).toBeNull();
  });
});

// ── Request-scoped identity ──────────────────────────────────────────────────

describe("the ids are request-scoped", () => {
  it("gives the request recipient an id that is not the preparation recipient's", async () => {
    const h = await harness();
    const recipient = await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const snapshot = h.store.signingRequestRecipients[0];
    expect(snapshot?.recipientId).not.toBe(recipient.recipientId);
    // The provenance, kept and correct.
    expect(snapshot?.sourcePreparationRecipientId).toBe(recipient.recipientId);
  });

  it("gives the request field an id that is not the preparation field's", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const source = h.store.preparationFields[0];
    const snapshot = h.store.signingRequestFields[0];
    expect(snapshot?.fieldId).not.toBe(source?.fieldId);
    expect(snapshot?.sourcePreparationFieldId).toBe(source?.fieldId);
  });

  it("gives the request an id that is not the document, preparation or artifact id", async () => {
    const h = await harness();
    await ready(h);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    for (const other of [
      String(DOC),
      String(h.store.preparations[0]?.preparationId),
      "art_original",
    ]) {
      expect(created.signingRequestId).not.toBe(other);
    }
  });

  it("remaps the field's assignee to the REQUEST recipient", async () => {
    const h = await harness();
    const recipient = await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const requestRecipient = h.store.signingRequestRecipients[0];
    const requestField = h.store.signingRequestFields[0];
    expect(requestField?.recipientId).toBe(requestRecipient?.recipientId);
    // And emphatically NOT the preparation recipient's id.
    expect(requestField?.recipientId).not.toBe(recipient.recipientId);
  });
});

// ── Independence: the whole point ────────────────────────────────────────────

describe("the snapshot is independent of everything mutable", () => {
  const create = (h: Harness) => createSigningRequest(
    { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

  it("survives a contact edit", async () => {
    const h = await harness();
    await ready(h);
    await create(h);

    const contact = h.store.contacts[0];
    if (contact === undefined) throw new Error("fixture");
    h.store.contacts[0] = { ...contact, name: "Someone Else", email: "new@x.com" };

    expect(h.store.signingRequestRecipients[0]?.name).toBe("Maria Santos");
    expect(h.store.signingRequestRecipients[0]?.email)
      .toBe("Maria.Santos@AyalaLand.com.ph");
  });

  it("survives a contact delete", async () => {
    const h = await harness();
    await ready(h);
    await create(h);
    h.store.contacts = [];
    expect(h.store.signingRequestRecipients[0]?.name).toBe("Maria Santos");
  });

  it("survives a preparation recipient edit", async () => {
    const h = await harness();
    const recipient = await ready(h);
    await create(h);

    await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Renamed Party", email: "renamed@x.com", type: "approver" },
      h.recipientDeps);

    const snapshot = h.store.signingRequestRecipients[0];
    expect(snapshot?.name).toBe("Maria Santos");
    expect(snapshot?.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(snapshot?.type).toBe("signer");
  });

  it("survives the field being moved", async () => {
    const h = await harness();
    const recipient = await ready(h);
    await create(h);

    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: revision,
        fields: [signatureField(recipient.recipientId, {
          rect: { x: 0.8, y: 0.9, width: 0.1, height: 0.05 },
          pageNumber: 4,
        })],
      }, h.prepDeps);

    const snapshot = h.store.signingRequestFields[0];
    expect(snapshot?.x).toBe(0.1);
    expect(snapshot?.y).toBe(0.2);
    expect(snapshot?.pageNumber).toBe(1);
  });

  it("survives the field being deleted", async () => {
    const h = await harness();
    await ready(h);
    await create(h);

    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: revision, fields: [] },
      h.prepDeps);

    expect(h.store.preparationFields).toHaveLength(0);
    expect(h.store.signingRequestFields).toHaveLength(1);
  });

  it("survives the assignment being changed", async () => {
    const h = await harness();
    const first = await ready(h);
    await create(h);
    const originalAssignee = h.store.signingRequestFields[0]?.recipientId;

    const second = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "Second Party", email: "second@x.com", type: "signer" },
      h.recipientDeps);
    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: revision,
        fields: [signatureField(second.recipientId)],
      }, h.prepDeps);

    expect(h.store.signingRequestFields[0]?.recipientId).toBe(originalAssignee);
    expect(String(originalAssignee)).not.toBe(String(first.recipientId));
  });

  it("survives the document being renamed", async () => {
    const h = await harness();
    await ready(h);
    await create(h);

    await renameDocument(actor(OWNER), h.workspaceId, DOC, "Renamed Lease", h.documentDeps);

    expect(h.store.documents[0]?.title).toBe("Renamed Lease");
    expect(h.store.signingRequests[0]?.documentTitle).toBe("Office Lease");
  });
});

// ── Readiness ────────────────────────────────────────────────────────────────

describe("an incoherent authoring state cannot become a workflow", () => {
  const create = (h: Harness) => createSigningRequest(
    { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

  it("refuses a document with no preparation at all", async () => {
    const h = await harness();
    await expect(create(h)).rejects.toBeInstanceOf(DocumentNotPreparedError);
  });

  it("refuses a preparation with no recipients", async () => {
    const h = await harness();
    // A preparation with a field but nobody to fill it cannot be built through
    // the normal path, so it is reached by creating one with no fields either.
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "A", email: "a@x.com", type: "signer" },
      h.recipientDeps);
    h.store.recipients = [];

    await expect(create(h)).rejects.toBeInstanceOf(PreparationNotReadyError);
  });

  it("refuses a preparation with no fields", async () => {
    const h = await harness();
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "A", email: "a@x.com", type: "signer" },
      h.recipientDeps);

    const failure = await create(h).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreparationNotReadyError);
    expect((failure as PreparationNotReadyError).issues)
      .toContain("fields: at least one is required");
  });

  it("refuses a required signer with no field", async () => {
    // The product's own rule: "at least one signing field per signer".
    const h = await harness();
    const first = await ready(h);
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "Idle Signer", email: "idle@x.com", type: "signer" },
      h.recipientDeps);

    const failure = await create(h).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreparationNotReadyError);
    expect((failure as PreparationNotReadyError).issues.join(" "))
      .toContain("has no fields to complete");
    expect(String(first.recipientId)).not.toBe("");
  });

  it("refuses an unassigned field", async () => {
    const h = await harness();
    const recipient = await ready(h);
    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: revision,
        fields: [
          signatureField(recipient.recipientId),
          { ...signatureField(recipient.recipientId), label: "Unassigned", layer: 1,
            recipientId: null },
        ],
      }, h.prepDeps);

    const failure = await create(h).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreparationNotReadyError);
    expect((failure as PreparationNotReadyError).issues.join(" "))
      .toContain("has no assigned recipient");
  });

  it("refuses a request whose only participants cannot block completion", async () => {
    const h = await harness();
    const viewer = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "Watcher", email: "watch@x.com", type: "viewer" },
      h.recipientDeps);
    // A viewer cannot hold fields, so there is no way to give it one - which is
    // exactly why "no blocking participant" and "no fields" both fire.
    const failure = await create(h).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreparationNotReadyError);
    expect((failure as PreparationNotReadyError).issues.join(" "))
      .toContain("required participant who can hold fields");
    expect(String(viewer.recipientId)).not.toBe("");
  });

  it("names indexes, never labels or addresses", async () => {
    const h = await harness();
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.recipientDeps);

    const failure = await create(h).catch((error: unknown) => error);
    const text = (failure as PreparationNotReadyError).issues.join(" ");
    for (const secret of ["Maria", "ayalaland", "Landlord", "Office Lease"]) {
      expect(text, `the blocker mentions "${secret}"`).not.toContain(secret);
    }
  });

  it("writes nothing when readiness fails", async () => {
    const h = await harness();
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "manual", name: "A", email: "a@x.com", type: "signer" },
      h.recipientDeps);
    await create(h).catch(() => undefined);
    expect(h.store.signingRequests).toHaveLength(0);
    expect(h.store.signingRequestRecipients).toHaveLength(0);
    expect(h.store.signingRequestFields).toHaveLength(0);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("idempotency", () => {
  const KEY = "key-1" as IdempotencyKey;

  it("replays the same request id for the same key", async () => {
    const h = await harness();
    await ready(h);
    const first = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: KEY }, h.deps);
    const second = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: KEY }, h.deps);

    expect(second.signingRequestId).toBe(first.signingRequestId);
    expect(h.store.signingRequests).toHaveLength(1);
  });

  it("replays the ORIGINAL snapshot after the preparation has changed", async () => {
    // The scenario that makes the fingerprint choice matter. A retry arriving
    // after the sender edited must return the request that exists, not create
    // a second one from the new revision and not report a conflict.
    const h = await harness();
    const recipient = await ready(h);

    const first = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: KEY }, h.deps);

    await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Edited After Creation" }, h.recipientDeps);
    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: revision,
        fields: [signatureField(recipient.recipientId, { pageNumber: 3 })],
      }, h.prepDeps);

    const replay = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: KEY }, h.deps);

    expect(replay.signingRequestId).toBe(first.signingRequestId);
    expect(h.store.signingRequests).toHaveLength(1);
    // And the snapshot is still the one from before the edits.
    expect(h.store.signingRequestRecipients[0]?.name).toBe("Maria Santos");
    expect(h.store.signingRequestFields[0]?.pageNumber).toBe(1);
  });

  it("creates a second request under a different key", async () => {
    const h = await harness();
    await ready(h);
    const first = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: KEY }, h.deps);
    const second = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC,
        idempotencyKey: "key-2" as IdempotencyKey }, h.deps);

    expect(second.signingRequestId).not.toBe(first.signingRequestId);
    expect(h.store.signingRequests).toHaveLength(2);
  });

  it("creates a request without a key", async () => {
    // Not required by the type. The route supplies one; a worker or a test
    // need not.
    const h = await harness();
    await ready(h);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(created.signingRequestId).not.toBe("");
  });
});

// ── Authorization and tenancy ────────────────────────────────────────────────

describe("authorization", () => {
  it("refuses an auditor", async () => {
    const h = await harness();
    await ready(h);
    await expect(createSigningRequest(
      { actor: actor(AUDITOR), workspaceId: h.workspaceId, documentId: DOC }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.signingRequests).toHaveLength(0);
  });

  it("lets an auditor read", async () => {
    const h = await harness();
    await ready(h);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    const read = await getSigningRequest(
      actor(AUDITOR), h.workspaceId, created.signingRequestId, h.deps);
    expect(read.state).toBe("draft");
  });

  it("reports a non-member's workspace as absent", async () => {
    const h = await harness();
    await ready(h);
    await expect(createSigningRequest(
      { actor: actor("usr_stranger" as UserId), workspaceId: h.workspaceId,
        documentId: DOC }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reports an unknown document as absent", async () => {
    const h = await harness();
    await expect(createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId,
        documentId: "doc_nope" as DocumentId }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reports an unknown request as absent", async () => {
    const h = await harness();
    await expect(getSigningRequest(
      actor(OWNER), h.workspaceId, "sr_nope", h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Read ─────────────────────────────────────────────────────────────────────

describe("getSigningRequest", () => {
  it("returns the snapshot, not the current preparation", async () => {
    const h = await harness();
    const recipient = await ready(h);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

    await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Changed" }, h.recipientDeps);
    await renameDocument(actor(OWNER), h.workspaceId, DOC, "Changed Title", h.documentDeps);

    const read = await getSigningRequest(
      actor(OWNER), h.workspaceId, created.signingRequestId, h.deps);
    expect(read.recipients[0]?.name).toBe("Maria Santos");
    expect(read.documentTitle).toBe("Office Lease");
  });

  it("exposes no provenance, no comparison key and no ceremony state", async () => {
    const h = await harness();
    await ready(h);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    const read = await getSigningRequest(
      actor(OWNER), h.workspaceId, created.signingRequestId, h.deps);
    const serialized = JSON.stringify(read);

    for (const absent of [
      // Provenance is an operator's concern, and the artifact id is one step
      // from a storage key.
      "sourceArtifactId", "sourcePreparationId", "sourcePreparationRevision",
      "sourcePreparationRecipientId", "sourcePreparationFieldId",
      "normalizedEmail", "createdByUserId",
      // A recipient is never resolved to an account.
      "userId", "isRegisteredUser",
      // Nothing has been sent and nobody authenticated.
      "sentAt", "signingUrl", "accessToken", "otp", "signedAt", "viewedAt",
      "declinedAt", "deliveryStatus", "expiresAt",
      // Tenancy is the URL.
      "workspaceId",
    ]) {
      expect(serialized, `exposes ${absent}`).not.toContain(absent);
    }
  });
});

// ── Side effects ─────────────────────────────────────────────────────────────

describe("creating a request sends nothing", () => {
  it("writes no evidence event", async () => {
    const h = await harness();
    await ready(h);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    // Configuring a workflow is not evidence that anything happened to a
    // recipient. BACKEND-43 owns signing evidence.
    expect(h.store.evidence).toHaveLength(0);
  });

  it("creates no artifact and no seal", async () => {
    const h = await harness();
    await ready(h);
    const artifactsBefore = h.store.artifacts.length;
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(h.store.artifacts).toHaveLength(artifactsBefore);
    expect(h.store.seals).toHaveLength(0);
  });

  it("does not touch the source artifact row", async () => {
    const h = await harness();
    await ready(h);
    const before = JSON.stringify(h.store.artifacts[0]);
    await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);
    expect(JSON.stringify(h.store.artifacts[0])).toBe(before);
  });
});
