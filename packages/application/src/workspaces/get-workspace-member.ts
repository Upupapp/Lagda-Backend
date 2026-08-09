// GetWorkspaceMember — a tenant-scoped read.
//
// Predates BACKEND-25 as BACKEND-05's representative QUERY. Retained and
// rewired: it now takes a `WorkspaceAccessContext` rather than a `UserActor`
// carrying a workspace, because BACKEND-25 made membership resolution the thing
// that produces workspace scope.
//
// It is NOT a member directory. It reads one membership by ID inside a
// workspace the caller already holds access to; listing members is BACKEND-26.

import type { WorkspaceId, WorkspaceMemberId, WorkspaceRole } from "@lagda/contracts";
import type { TransactionManager } from "../common/ports/index.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { WorkspaceAccessContext } from "./workspace-access.js";

export interface GetWorkspaceMemberInput {
  /**
   * Proof of membership, obtained from `resolveWorkspaceAccess`.
   *
   * The workspace scope comes from HERE, so there is no workspace parameter to
   * get wrong and no way to express a read against another tenant.
   */
  readonly access: WorkspaceAccessContext;
  readonly memberId: WorkspaceMemberId;
}

export interface GetWorkspaceMemberResult {
  readonly memberId: WorkspaceMemberId;
  readonly workspaceId: WorkspaceId;
  readonly role: WorkspaceRole;
  readonly createdAt: number;
}

export class GetWorkspaceMember {
  constructor(private readonly transactions: TransactionManager) {}

  async execute(input: GetWorkspaceMemberInput): Promise<GetWorkspaceMemberResult> {
    // Scope comes from the resolved ACCESS CONTEXT, never from the request. The
    // unit of work binds it, so `findMember` cannot be pointed at another
    // workspace — and under RLS the transaction also carries tenant context,
    // scoping the query twice.
    const membership = await this.transactions.runForWorkspace(
      input.access.workspaceId,
      uow => uow.memberships.findMember(input.memberId),
    );

    // A member in another workspace produces the SAME outcome as one that does
    // not exist. Distinguishing them would confirm another tenant's data to
    // anyone able to guess an ID.
    if (membership === null) {
      throw new ResourceNotFoundError("Workspace member");
    }

    return {
      memberId: membership.memberId,
      workspaceId: membership.workspaceId,
      role: membership.role,
      createdAt: membership.createdAt,
    };
  }
}
