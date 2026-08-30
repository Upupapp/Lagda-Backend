// Listing a workspace's folders.
//
// The table has existed since migration 040 and the placement rules since
// `@lagda/core/folders`. Neither had a way out over HTTP, so the product's own
// navigation -- My Documents, Department Documents, Archived, Trash -- had
// nothing to build a tree from.
//
// READS only. Creating, renaming and archiving are separate operations with
// their own rules (depth, cycles, and what happens to the documents filed in a
// folder), and shipping a list alongside a create that skipped those rules
// would be worse than shipping neither.

import type { AuthenticatedActor } from "../common/ports/session.js";
import type { TransactionManager } from "../common/ports/index.js";
import type { FolderRecord } from "../common/ports/folders.js";
import type { WorkspaceId } from "@lagda/contracts";
import { assertCapability } from "../workspaces/workspace-access.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

export interface FolderDependencies {
  readonly transactions: TransactionManager;
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
