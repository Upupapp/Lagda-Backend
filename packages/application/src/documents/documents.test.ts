// Document use cases, tested with fakes.
//
// The claim carrying the most weight is the capability split: `reviewer` and
// `auditor` may READ documents and may not create or rename them. That is a
// shape no previous domain had, and getting it wrong in either direction is a
// real access-control defect.

import { describe, it, expect } from "vitest";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import { WORKSPACE_ROLES } from "@lagda/contracts";
import {
  createDocument, listDocuments, getDocument, renameDocument,
  recordDocumentFilename, type DocumentDependencies,
} from "./documents.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds, SequentialDocumentIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const TEMPLATE_ADMIN = "usr_template" as UserId;
const SENDER = "usr_sender" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const MEMBER = "usr_member" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly transactions: FakeTransactionManager;
  readonly deps: DocumentDependencies;
  readonly workspaceId: WorkspaceId;
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

  for (const [key, userId, role] of [
    ["admin", ADMIN, "administrator"],
    ["template", TEMPLATE_ADMIN, "template_administrator"],
    ["sender", SENDER, "sender"],
    ["reviewer", REVIEWER, "reviewer"],
    ["auditor", AUDITOR, "auditor"],
    ["member", MEMBER, "member"],
  ] as const) {
    store.memberships.push({
      memberId: `mem_${key}` as WorkspaceMemberId,
      workspaceId: created.workspaceId,
      userId,
      role,
      createdAt: AT + 1000,
    });
  }

  return {
    store, transactions, workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialDocumentIds() },
  };
}

/** Attaches an accepted ORIGINAL artifact, as the upload pipeline would. */
function attachOriginal(h: Harness, documentId: string, pageCount = 4): void {
  h.store.artifacts.push({
    artifactId: `art_${documentId}` as ArtifactId,
    workspaceId: h.workspaceId,
    documentId: documentId as DocumentId,
    artifactType: "original",
    storageReference: `${h.workspaceId}/${documentId}/art` as never,
    mediaType: "application/pdf",
    sizeBytes: 204_800,
    digestAlgorithm: "sha-256",
    digest: "b".repeat(64) as never,
    pageCount,
    createdAt: AT + 2000,
  });
}

// ── Identity ─────────────────────────────────────────────────────────────────

describe("a DocumentId is not an ArtifactId", () => {
  it("keeps its id while acquiring bytes", async () => {
    const h = await harness();
    const created = await createDocument(
      actor(OWNER), h.workspaceId, { title: "Office Lease" }, h.deps);
    expect(created.source).toBeNull();

    attachOriginal(h, created.documentId);

    const withBytes = await getDocument(
      actor(OWNER), h.workspaceId, created.documentId, h.deps);
    // Same document, now with an artifact. The id did not change.
    expect(withBytes.documentId).toBe(created.documentId);
    expect(withBytes.source).toMatchObject({
      mediaType: "application/pdf", sizeBytes: 204_800, pageCount: 4,
    });
  });

  it("never exposes the artifact id, storage reference or digest", async () => {
    const h = await harness();
    const created = await createDocument(
      actor(OWNER), h.workspaceId, { title: "Lease" }, h.deps);
    attachOriginal(h, created.documentId);

    const document = await getDocument(
      actor(OWNER), h.workspaceId, created.documentId, h.deps);
    const serialized = JSON.stringify(document);
    for (const leaked of ["artifactId", "storageReference", "digest", "workspaceId"]) {
      expect(serialized, `leaked ${leaked}`).not.toContain(leaked);
    }
    expect(Object.keys(document.source ?? {}).sort())
      .toEqual(["mediaType", "pageCount", "sizeBytes", "uploadedAt"]);
  });

  it("reports a document with no bytes as source: null, not as an error", async () => {
    const h = await harness();
    const created = await createDocument(
      actor(OWNER), h.workspaceId, { title: "Awaiting upload" }, h.deps);
    expect(created.source).toBeNull();
    // And it is readable, listable and renameable in that state.
    await expect(getDocument(actor(OWNER), h.workspaceId, created.documentId, h.deps))
      .resolves.toMatchObject({ source: null });
  });

  it("ignores a SEALED artifact when resolving the original", async () => {
    const h = await harness();
    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);
    h.store.artifacts.push({
      artifactId: "art_sealed" as ArtifactId,
      workspaceId: h.workspaceId,
      documentId: created.documentId,
      artifactType: "sealed",
      storageReference: "k" as never,
      mediaType: "application/pdf",
      sizeBytes: 999,
      digestAlgorithm: "sha-256",
      digest: "c".repeat(64) as never,
      createdAt: AT + 3000,
    });
    const document = await getDocument(
      actor(OWNER), h.workspaceId, created.documentId, h.deps);
    // The sealed bytes are not the source. Same document, different artifact.
    expect(document.source).toBeNull();
  });
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("capability enforcement", () => {
  const WRITERS = [OWNER, ADMIN, TEMPLATE_ADMIN, SENDER];
  const READ_ONLY = [REVIEWER, AUDITOR];

  it("lets the four roles holding prepare_documents create and rename", async () => {
    for (const userId of WRITERS) {
      const h = await harness();
      const created = await createDocument(
        actor(userId), h.workspaceId, { title: "Draft" }, h.deps);
      await expect(renameDocument(
        actor(userId), h.workspaceId, created.documentId, "Renamed", h.deps))
        .resolves.toMatchObject({ title: "Renamed" });
    }
  });

  it("lets reviewer and auditor READ but not write", async () => {
    // The shape that matters. `view_documents` without `prepare_documents`.
    for (const userId of READ_ONLY) {
      const h = await harness();
      const created = await createDocument(
        actor(OWNER), h.workspaceId, { title: "Existing" }, h.deps);

      await expect(getDocument(actor(userId), h.workspaceId, created.documentId, h.deps))
        .resolves.toMatchObject({ title: "Existing" });
      await expect(listDocuments(actor(userId), h.workspaceId, {}, h.deps))
        .resolves.toMatchObject({ total: 1 });

      await expect(createDocument(actor(userId), h.workspaceId, { title: "X" }, h.deps))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(renameDocument(
        actor(userId), h.workspaceId, created.documentId, "X", h.deps))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      // And nothing was written.
      expect(h.store.documents).toHaveLength(1);
      expect(h.store.documents[0]?.title).toBe("Existing");
    }
  });

  it("REFUSES member entirely, including read", async () => {
    const h = await harness();
    await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);
    await expect(listDocuments(actor(MEMBER), h.workspaceId, {}, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REFUSES a non-member with the same hidden 404", async () => {
    const h = await harness();
    await expect(listDocuments(actor(OUTSIDER), h.workspaceId, {}, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("covers every role in the vocabulary", () => {
    expect([...WORKSPACE_ROLES].sort()).toEqual([
      "administrator", "auditor", "member", "owner",
      "reviewer", "sender", "template_administrator",
    ]);
  });

  it("re-reads the actor's role INSIDE the transaction", async () => {
    const h = await harness();
    const index = h.store.memberships.findIndex(m => m.userId === ADMIN);
    const existing = h.store.memberships[index];
    if (existing === undefined) throw new Error("fixture");
    // Demoted to a read-only role between requests.
    h.store.memberships[index] = { ...existing, role: "auditor" };

    await expect(createDocument(actor(ADMIN), h.workspaceId, { title: "X" }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Tenancy ──────────────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("cannot read, rename or list across the boundary", async () => {
    const h = await harness();
    const other = await harness();
    const theirs = await createDocument(
      actor(OWNER), other.workspaceId, { title: "Theirs" }, other.deps);

    await expect(getDocument(actor(OWNER), h.workspaceId, theirs.documentId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(renameDocument(
      actor(OWNER), h.workspaceId, theirs.documentId, "Hijacked", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    const still = await getDocument(
      actor(OWNER), other.workspaceId, theirs.documentId, other.deps);
    expect(still.title).toBe("Theirs");
  });

  it("never resolves another workspace's artifact as a document's source", async () => {
    const h = await harness();
    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);

    // An artifact with the right document id and the WRONG workspace. The
    // database refuses to store this at all (migration 016's compound FK); the
    // fake allows it so the application layer's scoping is tested independently.
    h.store.artifacts.push({
      artifactId: "art_foreign" as ArtifactId,
      workspaceId: "ws_elsewhere" as WorkspaceId,
      documentId: created.documentId,
      artifactType: "original",
      storageReference: "k" as never,
      mediaType: "application/pdf",
      sizeBytes: 1,
      digestAlgorithm: "sha-256",
      digest: "d".repeat(64) as never,
      createdAt: AT,
    });

    const document = await getDocument(
      actor(OWNER), h.workspaceId, created.documentId, h.deps);
    expect(document.source).toBeNull();
  });
});

// ── Metadata ─────────────────────────────────────────────────────────────────

describe("title and filename are separate", () => {
  it("renames without touching the filename", async () => {
    const h = await harness();
    const created = await createDocument(
      actor(OWNER), h.workspaceId, { title: "lease-v4-final" }, h.deps);
    await recordDocumentFilename(
      h.workspaceId, created.documentId, "lease-v4-final.pdf", h.deps);

    const renamed = await renameDocument(
      actor(OWNER), h.workspaceId, created.documentId, "Office Lease", h.deps);

    expect(renamed.title).toBe("Office Lease");
    expect(renamed.originalFilename).toBe("lease-v4-final.pdf");
  });

  it("records the filename write-once", async () => {
    const h = await harness();
    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);
    await recordDocumentFilename(h.workspaceId, created.documentId, "first.pdf", h.deps);
    await recordDocumentFilename(h.workspaceId, created.documentId, "second.pdf", h.deps);

    const document = await getDocument(
      actor(OWNER), h.workspaceId, created.documentId, h.deps);
    expect(document.originalFilename).toBe("first.pdf");
  });

  it("renaming does not touch the artifact", async () => {
    const h = await harness();
    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);
    attachOriginal(h, created.documentId);
    const before = JSON.stringify(h.store.artifacts);

    await renameDocument(actor(OWNER), h.workspaceId, created.documentId, "Renamed", h.deps);

    expect(JSON.stringify(h.store.artifacts)).toBe(before);
  });

  it("rejects an invalid title on create and on rename, writing nothing", async () => {
    const h = await harness();
    await expect(createDocument(actor(OWNER), h.workspaceId, { title: "  " }, h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    expect(h.store.documents).toHaveLength(0);

    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "Ok" }, h.deps);
    await expect(renameDocument(
      actor(OWNER), h.workspaceId, created.documentId, "x".repeat(400), h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    expect(h.store.documents[0]?.title).toBe("Ok");
  });

  it("requires a title", async () => {
    const h = await harness();
    await expect(createDocument(actor(OWNER), h.workspaceId, {}, h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("PERMITS two documents with the same title", async () => {
    const h = await harness();
    await createDocument(actor(OWNER), h.workspaceId, { title: "Lease Agreement" }, h.deps);
    await expect(createDocument(
      actor(OWNER), h.workspaceId, { title: "Lease Agreement" }, h.deps))
      .resolves.toMatchObject({ title: "Lease Agreement" });
    expect(h.store.documents).toHaveLength(2);
  });

  it("cannot change the id, creator or creation time by renaming", async () => {
    const h = await harness();
    const created = await createDocument(actor(OWNER), h.workspaceId, { title: "A" }, h.deps);
    const renamed = await renameDocument(
      actor(OWNER), h.workspaceId, created.documentId, "B", h.deps);

    expect(renamed.documentId).toBe(created.documentId);
    expect(renamed.createdByUserId).toBe(OWNER);
    expect(renamed.createdAt).toBe(created.createdAt);
  });
});

// ── Listing ──────────────────────────────────────────────────────────────────

describe("listDocuments", () => {
  async function seeded(): Promise<Harness> {
    const h = await harness();
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      await createDocument(actor(OWNER), h.workspaceId, { title }, h.deps);
    }
    return h;
  }

  it("defaults to newest first, 20 per page", async () => {
    const h = await seeded();
    const listed = await listDocuments(actor(OWNER), h.workspaceId, {}, h.deps);
    expect(listed).toMatchObject({ total: 3, page: 1, perPage: 20, hasNextPage: false });
  });

  it("sorts by title on request", async () => {
    const h = await seeded();
    const listed = await listDocuments(
      actor(OWNER), h.workspaceId, { sort: "title", direction: "asc" }, h.deps);
    expect(listed.items.map(d => d.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("paginates with a stable total", async () => {
    const h = await seeded();
    const page1 = await listDocuments(
      actor(OWNER), h.workspaceId, { sort: "title", direction: "asc", page: 1, perPage: 2 },
      h.deps);
    expect(page1.items.map(d => d.title)).toEqual(["Alpha", "Bravo"]);
    expect(page1.hasNextPage).toBe(true);

    const page2 = await listDocuments(
      actor(OWNER), h.workspaceId, { sort: "title", direction: "asc", page: 2, perPage: 2 },
      h.deps);
    expect(page2.items.map(d => d.title)).toEqual(["Charlie"]);
    expect(page2.hasNextPage).toBe(false);
  });

  it("returns an empty page past the end with no error", async () => {
    const h = await seeded();
    const listed = await listDocuments(
      actor(OWNER), h.workspaceId, { page: 99 }, h.deps);
    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(3);
  });

  it("includes artifact metadata per row", async () => {
    const h = await seeded();
    const first = h.store.documents[0];
    if (first === undefined) throw new Error("fixture");
    attachOriginal(h, first.documentId, 9);

    const listed = await listDocuments(actor(OWNER), h.workspaceId, {}, h.deps);
    const withSource = listed.items.filter(d => d.source !== null);
    expect(withSource).toHaveLength(1);
    expect(withSource[0]?.source?.pageCount).toBe(9);
  });

  it("lists only this workspace's documents", async () => {
    const h = await harness();
    const other = await harness();
    await createDocument(actor(OWNER), h.workspaceId, { title: "Mine" }, h.deps);
    await createDocument(actor(OWNER), other.workspaceId, { title: "Theirs" }, other.deps);

    const listed = await listDocuments(actor(OWNER), h.workspaceId, {}, h.deps);
    expect(listed.items.map(d => d.title)).toEqual(["Mine"]);
  });
});

// ── Transactionality ─────────────────────────────────────────────────────────

describe("transaction behaviour", () => {
  it("uses ONE transaction per operation", async () => {
    const h = await harness();
    const before = h.transactions.started;
    await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);
    expect(h.transactions.started - before).toBe(1);
  });

  it("rolls back and leaves no partial row when a rename misses", async () => {
    const h = await harness();
    await expect(renameDocument(
      actor(OWNER), h.workspaceId, "doc_missing" as DocumentId, "X", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.documents).toHaveLength(0);
    expect(h.transactions.rolledBack).toBeGreaterThan(0);
  });

  it("creates no user, membership, contact or invitation", async () => {
    // The document domain touches its own table and reads one membership.
    const h = await harness();
    const membershipsBefore = [...h.store.memberships];
    await createDocument(actor(OWNER), h.workspaceId, { title: "D" }, h.deps);

    expect(h.store.memberships).toEqual(membershipsBefore);
    expect(h.store.invitations).toHaveLength(0);
    expect(h.store.contacts).toHaveLength(0);
    // And no bytes: document creation writes metadata only.
    expect(h.store.artifacts).toHaveLength(0);
    expect(h.store.uploads.size).toBe(0);
  });
});
