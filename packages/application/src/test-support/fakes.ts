// Test doubles for application ports.
//
// Plain fakes, not a mocking framework: an in-memory repository states its
// behaviour in code, where a chain of `mockReturnValueOnce` calls hides it.
//
// **The fakes respect tenancy exactly as the real ports demand** — scope is
// bound by the unit of work, and a workspace mismatch throws. A permissive fake
// would let a cross-tenant bug pass its own test, which is the opposite of what
// a test double is for.
//
// Not exported from the package entry point. Test support is not public API.

import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork, GlobalUnitOfWork,
  ScopedWorkspaceRepository, ScopedMembershipRepository,
  WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "../common/ports/index.js";

/** A fixed instant, so assertions mean the same thing in any year. */
export class FixedClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** Sequential IDs, so a test can predict what a use case will produce. */
export class SequentialWorkspaceIds implements WorkspaceIdGenerator {
  private next = 1;
  nextWorkspaceId(): WorkspaceId {
    return `ws_${String(this.next++)}` as WorkspaceId;
  }
}

export class SequentialMemberIds implements WorkspaceMemberIdGenerator {
  private next = 1;
  nextWorkspaceMemberId(): WorkspaceMemberId {
    return `mem_${String(this.next++)}` as WorkspaceMemberId;
  }
}

/** Mirrors the adapter's mismatch rejection so fakes cannot be more permissive. */
export class FakeScopeMismatchError extends Error {
  constructor(entity: string, scope: string, actual: string) {
    super(`${entity} belongs to workspace ${actual}, scope is ${scope}.`);
    this.name = "FakeScopeMismatchError";
  }
}

interface StoreSnapshot {
  readonly workspaces: Map<string, WorkspaceRecord>;
  readonly memberships: WorkspaceMembershipRecord[];
}

/** Shared store, so a unit of work sees writes from earlier transactions. */
export class InMemoryStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly memberships: WorkspaceMembershipRecord[] = [];

  snapshot(): StoreSnapshot {
    return { workspaces: new Map(this.workspaces), memberships: [...this.memberships] };
  }

  restore(snapshot: StoreSnapshot): void {
    this.workspaces.clear();
    for (const [key, value] of snapshot.workspaces) this.workspaces.set(key, value);
    this.memberships.length = 0;
    this.memberships.push(...snapshot.memberships);
  }
}

function scopedWorkspaces(store: InMemoryStore, scope: WorkspaceId): ScopedWorkspaceRepository {
  return {
    find: () => Promise.resolve(store.workspaces.get(scope) ?? null),
    insert: (workspace: WorkspaceRecord) => {
      if (workspace.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Workspace", scope, workspace.workspaceId);
      }
      store.workspaces.set(workspace.workspaceId, workspace);
      return Promise.resolve();
    },
  };
}

function scopedMemberships(store: InMemoryStore, scope: WorkspaceId): ScopedMembershipRepository {
  // Every read filters by scope, exactly as the SQL does. A fake matching on
  // member ID alone would hide the cross-tenant bug it exists to catch.
  const inScope = () => store.memberships.filter(m => m.workspaceId === scope);

  return {
    findMember: (memberId: WorkspaceMemberId) =>
      Promise.resolve(inScope().find(m => m.memberId === memberId) ?? null),

    findByUser: (userId: UserId) =>
      Promise.resolve(inScope().find(m => m.userId === userId) ?? null),

    list: () => Promise.resolve(inScope()),

    countOwners: () => Promise.resolve(inScope().filter(m => m.role === "owner").length),

    insert: (membership: WorkspaceMembershipRecord) => {
      if (membership.workspaceId !== scope) {
        throw new FakeScopeMismatchError("WorkspaceMembership", scope, membership.workspaceId);
      }
      store.memberships.push(membership);
      return Promise.resolve();
    },

    changeRoleIfUnchanged: (input: {
      readonly memberId: WorkspaceMemberId;
      readonly expectedRole: WorkspaceRole;
      readonly nextRole: WorkspaceRole;
    }) => {
      const index = store.memberships.findIndex(
        m => m.workspaceId === scope
          && m.memberId === input.memberId
          && m.role === input.expectedRole,
      );
      const current = index === -1 ? undefined : store.memberships[index];
      if (current === undefined) return Promise.resolve(false);
      store.memberships[index] = { ...current, role: input.nextRole };
      return Promise.resolve(true);
    },
  };
}

/**
 * Commits on success and restores a snapshot on failure.
 *
 * A crude rollback, and honest about it: this proves a use case does not proceed
 * past a failure. It does **not** prove PostgreSQL atomicity, which needs a real
 * database.
 */
export class FakeTransactionManager implements TransactionManager {
  started = 0;
  committed = 0;
  rolledBack = 0;
  readonly scopes: (WorkspaceId | "global")[] = [];

  constructor(readonly store: InMemoryStore = new InMemoryStore()) {}

  async runForWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    this.scopes.push(workspaceId);
    this.started++;
    const snapshot = this.store.snapshot();
    try {
      const result = await operation({
        workspaceId,
        workspaces: scopedWorkspaces(this.store, workspaceId),
        memberships: scopedMemberships(this.store, workspaceId),
      });
      this.committed++;
      return result;
    } catch (error) {
      this.store.restore(snapshot);
      this.rolledBack++;
      throw error;
    }
  }

  async runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
    this.scopes.push("global");
    this.started++;
    try {
      const result = await operation({ scope: "global" });
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }
}

/** Fails before the operation body runs, to exercise the failure path. */
export class FailingTransactionManager implements TransactionManager {
  started = 0;
  rolledBack = 0;

  constructor(private readonly failure: Error) {}

  runForWorkspace<T>(
    _workspaceId: WorkspaceId,
    _operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.fail();
  }

  runGlobal<T>(_operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
    return this.fail();
  }

  private fail<T>(): Promise<T> {
    this.started++;
    this.rolledBack++;
    return Promise.reject(this.failure);
  }
}
