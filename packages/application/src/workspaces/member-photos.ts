// Photos of the people in a workspace, for the people in it.
//
// The Workspace's People & Teams tree and its activity log show each person's
// photo beside their name. 072 stores the photos; 091 lets you see the photo
// of someone you are connected to or who is discoverable. Neither covers a
// colleague: someone you share a workspace with is not necessarily either.
//
// The rule here is the plain one — a member of a workspace may see the photos
// of that workspace's CURRENT members. Nothing else: a removed member's photo
// is not served through the workspace any more, and a non-member gets the
// same hidden 404 as every other workspace read.

import type { UserId, WorkspaceId } from "@lagda/contracts";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { TransactionManager } from "../common/ports/index.js";

export interface MemberPhotoDependencies {
  readonly transactions: TransactionManager;
}

/** The user ids of the workspace's current members, when `viewer` is one of them. */
export async function listWorkspacePeople(
  viewer: UserId,
  workspaceId: WorkspaceId,
  deps: MemberPhotoDependencies,
): Promise<readonly UserId[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(viewer);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const members = await uow.memberships.listWithAccounts();
    return members.map(m => m.userId);
  });
}

/** Whether `viewer` and `target` are both current members of the workspace. */
export async function canSeeMemberPhoto(
  viewer: UserId,
  workspaceId: WorkspaceId,
  target: UserId,
  deps: MemberPhotoDependencies,
): Promise<boolean> {
  try {
    return (await listWorkspacePeople(viewer, workspaceId, deps)).includes(target);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return false;
    throw error;
  }
}
