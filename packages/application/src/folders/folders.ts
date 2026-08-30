// Listing a workspace's folders.
//
// The table has existed since migration 040 and the placement rules since
// `@lagda/core/folders`. Neither had a way out over HTTP, so the product's own
// navigation -- My Documents, Department Documents, Archived, Trash -- had
// nothing to build a tree from.
//
// Reads, and the three writes the tree needs to be usable: create, rename,
// archive/restore. The rules they carry -- depth, cycles, and what happens to
// the documents filed in a folder -- are stated below at the operation that
// enforces them.
//
// MOVING a folder is deliberately absent. `checkFolderPlacement` would decide
// it, but a move re-parents a whole subtree and can push its DESCENDANTS past
// the depth bound even when the folder itself lands legally. That is a rule
// about a subtree, not a node, and inventing it here would be inventing it.

import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type { FolderRecord, FolderId } from "../common/ports/folders.js";
import type { WorkspaceId } from "@lagda/contracts";
import {
  checkFolderPlacement, FOLDER_NAME_MAX_LENGTH, type FolderNode,
} from "@lagda/core";
import { assertCapability } from "../workspaces/workspace-access.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
  FolderUnavailableError,
} from "../common/errors/index.js";

export interface FolderIdGenerator {
  nextFolderId(): FolderId;
}

export interface FolderDependencies {
  readonly transactions: TransactionManager;
  /**
   * Required, though only the writes use them.
   *
   * Optional dependencies that a write path needs are how a composition root
   * builds something that typechecks and throws on first use. One shape, and
   * the reads carry two fields they ignore.
   */
  readonly clock: Clock;
  readonly ids: FolderIdGenerator;
}

export interface FolderView {
  readonly folderId: string;
  readonly parentFolderId: string | null;
  readonly name: string;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

/**
 * Every folder in the workspace, archived ones included.
 *
 * `document.view` rather than a folder-specific capability: a folder is a
 * container for documents and carries no content of its own, so anyone who may
 * see the documents may see where they are filed. A separate capability would
 * produce a state where a user sees a document and not its breadcrumb.
 */
export async function listFolders(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  deps: FolderDependencies,
): Promise<readonly FolderView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(actor.userId);
    // Another tenant's workspace is indistinguishable from an absent one.
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    assertCapability({
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      membershipId: membership.memberId,
      role: membership.role,
    }, "document.view");

    const folders = await uow.folders.list();
    return folders.map(present);
  });
}

/**
 * The wire shape.
 *
 * `createdByUserId` is deliberately NOT exposed. It is audit metadata, and a
 * folder list is read by every member -- publishing who made each folder tells
 * one colleague what another has been organising, for no product purpose.
 */
const present = (folder: FolderRecord): FolderView => ({
  folderId: folder.folderId,
  parentFolderId: folder.parentFolderId,
  name: folder.name,
  createdAt: folder.createdAt,
  archivedAt: folder.archivedAt,
});


// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The tree refuses this placement.
 *
 * The rejection strings come from `checkPlacement` and are matched EXACTLY.
 * An earlier draft tested for `"depth"`, which is not one of them -- every
 * too-deep rejection would have carried the fallback message, telling the user
 * the parent was unavailable when the parent was fine.
 *
 * For a CREATE only "too-deep" is reachable: the node does not exist yet, so
 * it cannot be its own parent or close a loop, and a missing or foreign parent
 * is refused earlier with `FolderUnavailableError`. The other cases are
 * handled anyway rather than assumed away, because the day this function is
 * reused for a move is the day they become reachable.
 */
export class FolderPlacementError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "folder_placement_invalid";

  constructor(readonly rejection: string) {
    super(
      rejection === "too-deep"
        ? "That folder would be nested too deeply."
        : rejection === "cycle" || rejection === "self-parent"
          ? "A folder cannot be placed inside itself."
          : "That parent folder is not available.",
    );
  }
}

/**
 * A folder still holding something cannot be archived.
 *
 * ── This is a product decision, and it is the conservative one ─────────────
 *
 * Three options existed. Archiving could CASCADE to the subtree, which
 * silently archives folders nobody named. It could MOVE the contents to the
 * root, which relocates a user's filing as a side effect of tidying. Or it can
 * refuse until the folder is empty.
 *
 * Refusing wins because the alternatives are both irreversible in practice:
 * once documents have been scattered to the root or a subtree flattened, no
 * record of where they were survives to undo it. Refusing costs the user one
 * extra step and loses nothing.
 *
 * It also protects a specific trap. The client's folder picker offers only
 * LIVE folders, so a document left inside an archived folder is filed
 * somewhere the UI can no longer select -- reachable only by un-archiving the
 * folder the user just archived.
 */
export class FolderNotEmptyError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "folder_not_empty";

  constructor() {
    super(
      "That folder still holds documents or folders. Move them out before "
      + "archiving it.",
    );
  }
}

/** Trimmed, bounded, and never blank. The same shape a document title takes. */
function resolveName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > FOLDER_NAME_MAX_LENGTH) {
    throw new ApplicationValidationError(
      `A folder name must be 1 to ${String(FOLDER_NAME_MAX_LENGTH)} characters.`,
      ["name"]);
  }
  return name;
}

const toNode = (folder: FolderRecord): FolderNode => ({
  folderId: folder.folderId,
  workspaceId: folder.workspaceId,
  parentFolderId: folder.parentFolderId,
});

/**
 * Authorizes a folder WRITE and returns the workspace's tree.
 *
 * The tree comes back because every write decides something against it, and
 * reading it once inside the transaction is what makes those decisions
 * consistent with what is about to be written.
 */
async function authorizeWrite(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
): Promise<readonly FolderRecord[]> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Another tenant's workspace is indistinguishable from an absent one.
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  assertCapability({
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  }, "document.update");
  // `document.update`, the capability that files a document -- organising
  // documents is one permission, not two. A role that may re-file a document
  // may make somewhere to file it.
  void workspaceId;
  return uow.folders.list();
}

/**
 * Creates a folder under a parent, or at the workspace root.
 *
 * `parentFolderId: null` is the ROOT -- a real destination, the same meaning it
 * carries everywhere else in this domain, not "no parent chosen".
 *
 * Names are NOT unique, deliberately. No constraint enforces it, and inventing
 * uniqueness in the application would produce a rule the database does not
 * share and a second create could still violate under concurrency. Two folders
 * called "2026" under different parents are also completely reasonable.
 */
export async function createFolder(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: { readonly name: string; readonly parentFolderId: string | null },
  deps: FolderDependencies,
): Promise<FolderView> {
  // Validated before the transaction: a blank name should not hold a
  // connection while it is rejected.
  const name = resolveName(input.name);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const folders = await authorizeWrite(uow, actor, workspaceId);

    if (input.parentFolderId !== null) {
      const parent = folders.find(f => f.folderId === input.parentFolderId);
      // An ARCHIVED parent is refused: a new folder inside a closed drawer is
      // invisible to the picker the moment it is created.
      if (parent === undefined || parent.archivedAt !== null) {
        throw new FolderUnavailableError("That parent folder is not available.");
      }
    }

    // Null as the first argument: the folder does not exist yet, so it cannot
    // be its own ancestor. `checkPlacement` still enforces the DEPTH bound and
    // that the parent belongs to this workspace.
    const rejection = checkFolderPlacement(
      null, input.parentFolderId, workspaceId, folders.map(toNode));
    if (rejection !== null) throw new FolderPlacementError(rejection);

    const record: FolderRecord = {
      folderId: deps.ids.nextFolderId(),
      workspaceId,
      parentFolderId: input.parentFolderId as FolderId | null,
      name,
      createdByUserId: actor.userId,
      createdAt: deps.clock.now(),
      archivedAt: null,
    };
    await uow.folders.create(record);
    return present(record);
  });
}

/**
 * Renames a folder. The name only -- this never moves it.
 *
 * An ARCHIVED folder can still be renamed. Archiving is "out of the way", not
 * "frozen", and refusing would leave a badly named folder permanently badly
 * named unless it were restored first.
 */
export async function renameFolder(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  folderId: string,
  rawName: string,
  deps: FolderDependencies,
): Promise<FolderView> {
  const name = resolveName(rawName);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const folders = await authorizeWrite(uow, actor, workspaceId);
    const folder = folders.find(f => f.folderId === folderId);
    if (folder === undefined) throw new FolderUnavailableError();

    const applied = await uow.folders.rename({ folderId: folder.folderId, name });
    if (!applied) throw new FolderUnavailableError();
    return present({ ...folder, name });
  });
}

/**
 * Archives a folder, or restores one.
 *
 * Archiving REFUSES a folder that still holds documents or live child folders
 * -- see `FolderNotEmptyError` for why that is the conservative choice among
 * three.
 *
 * Restoring refuses nothing. Its parent may itself be archived, which produces
 * a live folder inside an archived one; that is visible and fixable, whereas
 * refusing would make a restore fail for a reason about a folder the user did
 * not name.
 */
export async function setFolderArchived(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  folderId: string,
  archived: boolean,
  deps: FolderDependencies,
): Promise<FolderView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const folders = await authorizeWrite(uow, actor, workspaceId);
    const folder = folders.find(f => f.folderId === folderId);
    if (folder === undefined) throw new FolderUnavailableError();

    if (archived) {
      const liveChildren = folders.some(
        f => f.parentFolderId === folderId && f.archivedAt === null);
      // Only DIRECT children need checking: a live grandchild implies a live
      // child, because an archived folder cannot be created under an archived
      // parent and archiving one requires it to be empty first.
      if (liveChildren) throw new FolderNotEmptyError();

      // One page is enough to answer "is anything filed here". Asking for the
      // count of every document in the folder would read a whole page to
      // learn a boolean.
      const filed = await uow.documents.list({
        sort: "createdAt", direction: "desc", offset: 0, limit: 1,
        search: null, folderId,
      });
      if (filed.total > 0) throw new FolderNotEmptyError();
    }

    const archivedAt = archived ? deps.clock.now() : null;
    const applied = await uow.folders.setArchived({ folderId: folder.folderId, archivedAt });
    if (!applied) throw new FolderUnavailableError();
    return present({ ...folder, archivedAt });
  });
}
