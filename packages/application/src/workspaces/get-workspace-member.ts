// GetWorkspaceMember — a representative QUERY.
//
// FOUNDATION IMPLEMENTATION. It proves tenant-scoped reads: the unit of work is
// bound to the actor's workspace, so there is no workspace parameter to get
// wrong and no way to express a read against another tenant.

import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";
import type { TransactionManager } from "../common/ports/index.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { UserActor } from "../common/context.js";

export interface GetWorkspaceMemberInput {
  /** Resolved from authentication. The workspace scope comes from here. */
  readonly actor: UserActor;
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
    // Scope comes from the ACTOR, never from the request. The unit of work binds
    // it, so `findMember` cannot be pointed at another workspace — and under RLS
    // the transaction also carries tenant context, scoping the query twice.
    const membership = await this.transactions.runForWorkspace(
      input.actor.workspaceId,
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
