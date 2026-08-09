// Test doubles for application ports.
//
// Plain fakes, not a mocking framework: an in-memory repository states its
// behaviour in code, where a chain of `mockReturnValueOnce` calls hides it.
//
// **The fakes respect tenancy exactly as the real ports demand.** A fake that
// ignored workspace scope would let a cross-tenant bug pass its own test — the
// test double would be hiding the architecture problem it exists to catch.
//
// Not exported from the package entry point. Test support is not public API.

import type {
  Clock, TransactionContext, TransactionManager,
  WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRepository, WorkspaceMembershipRepository,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "../common/ports/index.js";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";

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

const TX = { __transaction: Symbol("tx") } as unknown as TransactionContext;

/**
 * Records whether the transaction body ran and whether it committed.
 *
 * This proves the use case OPENED a transaction and did its writes inside it.
 * It does not, and cannot, prove PostgreSQL rollback semantics — that needs a
 * real database and belongs to BACKEND-08.
 */
export class FakeTransactionManager implements TransactionManager {
  started = 0;
  committed = 0;
  rolledBack = 0;

  async run<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.started++;
    try {
      const result = await operation(TX);
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }
}

/** Fails on the Nth write, to exercise the failure path. */
export class FailingTransactionManager implements TransactionManager {
  started = 0;
  rolledBack = 0;

  constructor(private readonly failure: Error) {}

  async run<T>(_operation: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.started++;
    this.rolledBack++;
    return Promise.reject(this.failure);
  }
}

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly rows = new Map<string, WorkspaceRecord>();
  /** Records the transaction each write was given, so scoping can be asserted. */
  readonly writeContexts: TransactionContext[] = [];

  findById(workspaceId: WorkspaceId): Promise<WorkspaceRecord | null> {
    return Promise.resolve(this.rows.get(workspaceId) ?? null);
  }

  save(workspace: WorkspaceRecord, tx: TransactionContext): Promise<void> {
    this.writeContexts.push(tx);
    this.rows.set(workspace.workspaceId, workspace);
    return Promise.resolve();
  }
}

export class InMemoryMembershipRepository implements WorkspaceMembershipRepository {
  readonly rows: WorkspaceMembershipRecord[] = [];
  readonly writeContexts: TransactionContext[] = [];

  findInWorkspace(
    workspaceId: WorkspaceId,
    memberId: WorkspaceMemberId,
  ): Promise<WorkspaceMembershipRecord | null> {
    // BOTH keys, deliberately. Matching on `memberId` alone would make this
    // fake more permissive than the contract and hide cross-tenant reads.
    const found = this.rows.find(
      row => row.workspaceId === workspaceId && row.memberId === memberId,
    );
    return Promise.resolve(found ?? null);
  }

  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly WorkspaceMembershipRecord[]> {
    return Promise.resolve(this.rows.filter(row => row.workspaceId === workspaceId));
  }

  save(membership: WorkspaceMembershipRecord, tx: TransactionContext): Promise<void> {
    this.writeContexts.push(tx);
    this.rows.push(membership);
    return Promise.resolve();
  }
}
