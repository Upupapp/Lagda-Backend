// Folder use cases, tested with fakes.
//
// The claims carrying the most weight are the two refusals: a folder that
// still holds something cannot be archived, and the tree's depth bound is
// enforced against the tree as it exists inside the transaction. Both are
// rules nothing else in the system states.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { MAX_FOLDER_DEPTH } from "@lagda/core";
import {
  listFolders, createFolder, renameFolder, setFolderArchived,
  FolderPlacementError, FolderNotEmptyError, type FolderDependencies,
} from "./folders.js";
import { createDocument } from "../documents/documents.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ApplicationValidationError, ResourceNotFoundError, FolderUnavailableError,
} from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { FolderId } from "../common/ports/folders.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds, SequentialDocumentIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: FolderDependencies;
  readonly documentDeps: { transactions: FakeTransactionManager; clock: FixedClock;
    ids: SequentialDocumentIds };
  readonly workspaceId: WorkspaceId;
}

/** Sequential folder ids, so a test can name what it expects to be created. */
class SequentialFolderIds {
  private next = 0;
  nextFolderId(): FolderId {
    this.next += 1;
    return `fld_${String(this.next)}` as FolderId;
  }
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
    ["reviewer", REVIEWER, "reviewer"],
    ["auditor", AUDITOR, "auditor"],
  ] as const) {
    store.memberships.push({
      memberId: `mem_${key}` as WorkspaceMemberId,
      workspaceId: created.workspaceId,
      userId, role, createdAt: AT + 1000,
    });
  }

  return {
    store, workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialFolderIds() },
    documentDeps: { transactions, clock, ids: new SequentialDocumentIds() },
  };
}

describe("creating a folder", () => {
  it("creates at the root and reads back in the list", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Client Agreements", parentFolderId: null }, h.deps);

    expect(folder.name).toBe("Client Agreements");
    // Null is the ROOT, and it comes back as null rather than as some
    // invented root id.
    expect(folder.parentFolderId).toBeNull();
    expect(folder.archivedAt).toBeNull();

    const listed = await listFolders(actor(OWNER), h.workspaceId, h.deps);
    expect(listed.map(f => f.folderId)).toEqual([folder.folderId]);
  });

  it("nests under a live parent", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "2026", parentFolderId: null }, h.deps);
    const child = await createFolder(
      actor(OWNER), h.workspaceId,
      { name: "Renewals", parentFolderId: parent.folderId }, h.deps);

    expect(child.parentFolderId).toBe(parent.folderId);
  });

  /**
   * A new folder inside a closed drawer is invisible the moment it exists.
   *
   * The client's picker offers only live folders, so this would create
   * something the user could never select.
   */
  it("refuses an archived parent", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Closed", parentFolderId: null }, h.deps);
    await setFolderArchived(actor(OWNER), h.workspaceId, parent.folderId, true, h.deps);

    await expect(createFolder(
      actor(OWNER), h.workspaceId,
      { name: "Inside", parentFolderId: parent.folderId }, h.deps))
      .rejects.toBeInstanceOf(FolderUnavailableError);
  });

  it("refuses a parent that does not exist, and another workspace's alike", async () => {
    const h = await harness();
    h.store.folders.push({
      folderId: "fld_theirs" as FolderId,
      workspaceId: "ws_someone_else" as WorkspaceId,
      parentFolderId: null, name: "Theirs",
      createdByUserId: OWNER, createdAt: AT, archivedAt: null,
    });

    for (const parentFolderId of ["fld_ghost", "fld_theirs"]) {
      await expect(createFolder(
        actor(OWNER), h.workspaceId, { name: "X", parentFolderId }, h.deps))
        .rejects.toBeInstanceOf(FolderUnavailableError);
    }
  });

  /**
   * The depth bound, checked against the tree INSIDE the transaction.
   *
   * `MAX_FOLDER_DEPTH` counts a new node's ANCESTORS, so a chain of
   * MAX_FOLDER_DEPTH folders still accepts one more child -- core's own test
   * asserts exactly that. This builds one longer and checks BOTH sides of the
   * boundary, because a test that only checked the refusal would pass against
   * an off-by-one that refused everything.
   */
  it("allows a chain at the bound and refuses one past it", async () => {
    const h = await harness();
    const chain: string[] = [];
    let parentFolderId: string | null = null;
    for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth += 1) {
      const made: { folderId: string } = await createFolder(
        actor(OWNER), h.workspaceId,
        { name: `level-${String(depth)}`, parentFolderId }, h.deps);
      parentFolderId = made.folderId;
      chain.push(made.folderId);
    }

    // Still legal at the bound.
    const last: { folderId: string } = await createFolder(
      actor(OWNER), h.workspaceId, { name: "at-the-bound", parentFolderId }, h.deps);

    // One deeper is not.
    const rejected = createFolder(
      actor(OWNER), h.workspaceId,
      { name: "past-the-bound", parentFolderId: last.folderId }, h.deps);
    await expect(rejected).rejects.toBeInstanceOf(FolderPlacementError);
    // And the message names the real reason rather than blaming the parent.
    await expect(rejected).rejects.toThrow(/nested too deeply/);
  });

  it("refuses a blank or over-long name, writing nothing", async () => {
    const h = await harness();
    for (const name of ["   ", "x".repeat(200)]) {
      await expect(createFolder(
        actor(OWNER), h.workspaceId, { name, parentFolderId: null }, h.deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
    expect(h.store.folders).toHaveLength(0);
  });

  it("trims the name rather than storing the spaces", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "  Client Agreements  ", parentFolderId: null },
      h.deps);
    expect(folder.name).toBe("Client Agreements");
  });
});

describe("renaming a folder", () => {
  it("renames, leaving the placement alone", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "2026", parentFolderId: null }, h.deps);
    const child = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Renewls", parentFolderId: parent.folderId },
      h.deps);

    const renamed = await renameFolder(
      actor(OWNER), h.workspaceId, child.folderId, "Renewals", h.deps);

    expect(renamed.name).toBe("Renewals");
    expect(renamed.parentFolderId).toBe(parent.folderId);
  });

  /**
   * Archiving is "out of the way", not "frozen".
   *
   * Refusing would leave a badly named folder permanently badly named unless
   * it were restored first.
   */
  it("renames an archived folder", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Typo", parentFolderId: null }, h.deps);
    await setFolderArchived(actor(OWNER), h.workspaceId, folder.folderId, true, h.deps);

    const renamed = await renameFolder(
      actor(OWNER), h.workspaceId, folder.folderId, "Fixed", h.deps);
    expect(renamed.name).toBe("Fixed");
    expect(renamed.archivedAt).not.toBeNull();
  });

  it("refuses a folder that does not exist", async () => {
    const h = await harness();
    await expect(renameFolder(actor(OWNER), h.workspaceId, "fld_ghost", "X", h.deps))
      .rejects.toBeInstanceOf(FolderUnavailableError);
  });
});

describe("archiving and restoring", () => {
  it("archives an empty folder and restores it", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Old Matters", parentFolderId: null }, h.deps);

    const archived = await setFolderArchived(
      actor(OWNER), h.workspaceId, folder.folderId, true, h.deps);
    expect(archived.archivedAt).toBe(AT);

    const restored = await setFolderArchived(
      actor(OWNER), h.workspaceId, folder.folderId, false, h.deps);
    expect(restored.archivedAt).toBeNull();
  });

  /**
   * The product decision, asserted.
   *
   * Archiving does NOT cascade and does NOT relocate the contents. Both
   * alternatives are irreversible in practice -- once documents are scattered
   * to the root, nothing records where they were.
   */
  it("refuses to archive a folder that still holds a document", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Live Matters", parentFolderId: null }, h.deps);
    const document = await createDocument(
      actor(OWNER), h.workspaceId, { title: "Lease" }, h.documentDeps);
    // Filed directly through the store: this test is about ARCHIVING, and
    // going through fileDocument would make it depend on that command too.
    const stored = h.store.documents.find(d => d.documentId === document.documentId);
    if (stored !== undefined) {
      h.store.documents[h.store.documents.indexOf(stored)] =
        { ...stored, folderId: folder.folderId };
    }

    await expect(setFolderArchived(
      actor(OWNER), h.workspaceId, folder.folderId, true, h.deps))
      .rejects.toBeInstanceOf(FolderNotEmptyError);

    // And it is still live, so the refusal changed nothing.
    const listed = await listFolders(actor(OWNER), h.workspaceId, h.deps);
    expect(listed.find(f => f.folderId === folder.folderId)?.archivedAt).toBeNull();
  });

  it("refuses to archive a folder with a live child folder", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "2026", parentFolderId: null }, h.deps);
    await createFolder(
      actor(OWNER), h.workspaceId, { name: "Renewals", parentFolderId: parent.folderId },
      h.deps);

    await expect(setFolderArchived(
      actor(OWNER), h.workspaceId, parent.folderId, true, h.deps))
      .rejects.toBeInstanceOf(FolderNotEmptyError);
  });

  it("archives a parent once its only child is archived", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "2026", parentFolderId: null }, h.deps);
    const child = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Renewals", parentFolderId: parent.folderId },
      h.deps);

    await setFolderArchived(actor(OWNER), h.workspaceId, child.folderId, true, h.deps);
    const archived = await setFolderArchived(
      actor(OWNER), h.workspaceId, parent.folderId, true, h.deps);
    expect(archived.archivedAt).toBe(AT);
  });

  /**
   * Restoring refuses nothing, including into an archived parent.
   *
   * The result -- a live folder inside an archived one -- is visible and
   * fixable. Refusing would fail a restore for a reason about a folder the
   * user did not name.
   */
  it("restores a child whose parent is still archived", async () => {
    const h = await harness();
    const parent = await createFolder(
      actor(OWNER), h.workspaceId, { name: "2026", parentFolderId: null }, h.deps);
    const child = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Renewals", parentFolderId: parent.folderId },
      h.deps);
    await setFolderArchived(actor(OWNER), h.workspaceId, child.folderId, true, h.deps);
    await setFolderArchived(actor(OWNER), h.workspaceId, parent.folderId, true, h.deps);

    const restored = await setFolderArchived(
      actor(OWNER), h.workspaceId, child.folderId, false, h.deps);
    expect(restored.archivedAt).toBeNull();
  });
});

describe("who may do what", () => {
  /**
   * Reading the tree and changing it are different capabilities.
   *
   * `document.view` lists; `document.update` writes -- the same capability
   * that files a document, because organising documents is one permission.
   */
  it("lets a reviewer and an auditor LIST but not create, rename or archive", async () => {
    const h = await harness();
    const folder = await createFolder(
      actor(OWNER), h.workspaceId, { name: "Client Agreements", parentFolderId: null },
      h.deps);

    for (const userId of [REVIEWER, AUDITOR]) {
      await expect(listFolders(actor(userId), h.workspaceId, h.deps))
        .resolves.toHaveLength(1);

      await expect(createFolder(
        actor(userId), h.workspaceId, { name: "Mine", parentFolderId: null }, h.deps))
        .rejects.toBeDefined();
      await expect(renameFolder(actor(userId), h.workspaceId, folder.folderId, "X", h.deps))
        .rejects.toBeDefined();
      await expect(setFolderArchived(
        actor(userId), h.workspaceId, folder.folderId, true, h.deps))
        .rejects.toBeDefined();
    }

    // Nothing was written by any of those attempts.
    expect(h.store.folders).toHaveLength(1);
    expect(h.store.folders[0]?.name).toBe("Client Agreements");
    expect(h.store.folders[0]?.archivedAt).toBeNull();
  });

  it("gives a non-member the workspace 404, not a folder error", async () => {
    const h = await harness();
    await expect(createFolder(
      actor(OUTSIDER), h.workspaceId, { name: "X", parentFolderId: null }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
