// CreateWorkspace — a representative COMMAND.
//
// FOUNDATION IMPLEMENTATION, not the workspace feature. It exists to prove the
// orchestration pattern end to end: explicit dependencies, clock, ID
// generation, a domain invariant, two writes in one transaction, a typed
// result. BACKEND-25 owns settings, invitations, roles and ownership transfer.
//
// Chosen because it needs no storage, no PDF, no email and no authentication —
// so it demonstrates the architecture without consuming a later command's scope.

import type { UserId, WorkspaceId } from "@lagda/contracts";
import { assertExactlyOneOwner, type MembershipView } from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "../common/ports/index.js";
import { ApplicationValidationError } from "../common/errors/index.js";

export interface CreateWorkspaceInput {
  /**
   * The user who will own the workspace.
   *
   * From resolved authentication context, never from a request body — a
   * client-supplied owner ID would let anyone create a workspace owned by
   * someone else.
   */
  readonly ownerUserId: UserId;
  readonly name: string;
}

export interface CreateWorkspaceResult {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly ownerUserId: UserId;
  readonly createdAt: number;
}

export interface CreateWorkspaceDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly workspaceIds: WorkspaceIdGenerator;
  readonly memberIds: WorkspaceMemberIdGenerator;
}

export class CreateWorkspace {
  constructor(private readonly deps: CreateWorkspaceDependencies) {}

  async execute(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    // Cheap validation first. Nothing is generated or written until the input
    // is known to be usable — the general rule that no irreversible work
    // precedes a check that could have prevented it.
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ApplicationValidationError("Workspace name is required.", ["name"]);
    }

    // Identity and time come from ports, never from `crypto.randomUUID()` or
    // `Date.now()`. Generating the ID here rather than letting the database
    // assign one means the workspace and its membership can be built and
    // written together, and a test can predict both.
    const workspaceId = this.deps.workspaceIds.nextWorkspaceId();
    const memberId = this.deps.memberIds.nextWorkspaceMemberId();
    const createdAt = this.deps.clock.now();

    const workspace: WorkspaceRecord = {
      workspaceId, name, ownerUserId: input.ownerUserId, createdAt,
    };
    const ownerMembership: WorkspaceMembershipRecord = {
      memberId, workspaceId, userId: input.ownerUserId, role: "owner", createdAt,
    };

    // The domain invariant, checked against the state about to be written.
    // Application does not re-implement it — a workspace having exactly one
    // owner is a business rule, and it lives in core.
    const members: MembershipView[] = [{ memberId, role: "owner" }];
    assertExactlyOneOwner(members);

    // Both writes or neither. A workspace with no owner is unrecoverable: no
    // one could transfer ownership or delete it. That is exactly the state a
    // partial write would produce.
    // Bound to the workspace being created. The ID is generated first, so the
    // tenant context matches the rows about to be written and RLS's WITH CHECK
    // permits them — no global escape is needed to create a workspace.
    await this.deps.transactions.runForWorkspace(workspaceId, async uow => {
      // Both repositories come from the unit of work, so both write through the
      // same transaction. Independently constructed repositories could hold the
      // pool instead, and the resulting write would survive a rollback.
      await uow.workspaces.insert(workspace);
      await uow.memberships.insert(ownerMembership);
    });

    // No event is published here. Publishing before the commit is durable would
    // let the world learn about a workspace that does not exist; publishing
    // after the transaction, with no outbox, drops the event if the process
    // dies in between. Neither is solved yet — see the foundation report.
    return { workspaceId, name, ownerUserId: input.ownerUserId, createdAt };
  }
}
