// GetWorkspaceMember — a representative QUERY.
//
// FOUNDATION IMPLEMENTATION. It exists to prove tenant-scoped reads: the
// repository cannot be asked for a member without a workspace, so cross-tenant
// access is not something a caller has to remember to prevent.

import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";
import type {
  WorkspaceMembershipRepository, TransactionManager,
} from "../common/ports/index.js";
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
  constructor(
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly transactions: TransactionManager,
  ) {}

  async execute(input: GetWorkspaceMemberInput): Promise<GetWorkspaceMemberResult> {
    // Scope comes from the ACTOR, not from the request. A workspace ID supplied
    // alongside the member ID would be a client-controlled scope, and honouring
    // it would make the tenant boundary a suggestion.
    // Reads run inside a tenant transaction. Under RLS the tenant context is
    // transaction-local, so a read outside one carries no context and returns
    // nothing — the query is scoped twice, by predicate and by policy.
    const membership = await this.transactions.runForWorkspace(
      input.actor.workspaceId,
      tx => this.memberships.findInWorkspace(input.actor.workspaceId, input.memberId, tx),
    );

    // A member belonging to another workspace produces the SAME outcome as one
    // that does not exist. Distinguishing them would confirm the existence of
    // another tenant's data to anyone who could guess an ID.
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
