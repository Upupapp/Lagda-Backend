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
  ScopedEvidenceRepository, ScopedArtifactRepository, ScopedFinalizationRepository,
  EvidenceEventInput, EvidenceEventRecord, ArtifactRecord, ArtifactId,
  FinalizationInput, SealRecord,
} from "../common/ports/index.js";
import type { TransactionId, DocumentId } from "@lagda/contracts";

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
  readonly evidence: EvidenceEventRecord[];
  readonly artifacts: ArtifactRecord[];
  readonly seals: SealRecord[];
  readonly verifications: FinalizationInput["verification"][];
}

/** Shared store, so a unit of work sees writes from earlier transactions. */
export class InMemoryStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly memberships: WorkspaceMembershipRecord[] = [];
  readonly evidence: EvidenceEventRecord[] = [];
  readonly artifacts: ArtifactRecord[] = [];
  readonly seals: SealRecord[] = [];
  readonly verifications: FinalizationInput["verification"][] = [];

  snapshot(): StoreSnapshot {
    return {
      workspaces: new Map(this.workspaces),
      memberships: [...this.memberships],
      evidence: [...this.evidence],
      artifacts: [...this.artifacts],
      seals: [...this.seals],
      verifications: [...this.verifications],
    };
  }

  restore(snapshot: StoreSnapshot): void {
    this.workspaces.clear();
    for (const [key, value] of snapshot.workspaces) this.workspaces.set(key, value);
    this.memberships.length = 0;
    this.memberships.push(...snapshot.memberships);
    this.evidence.length = 0;
    this.evidence.push(...snapshot.evidence);
    this.artifacts.length = 0;
    this.artifacts.push(...snapshot.artifacts);
    this.seals.length = 0;
    this.seals.push(...snapshot.seals);
    this.verifications.length = 0;
    this.verifications.push(...snapshot.verifications);
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
 * Append-only, exactly as the port and the database demand.
 *
 * There is no update or delete here either. A fake that quietly allowed
 * mutation would let a use case be written against behaviour PostgreSQL
 * refuses, and the divergence would only surface in the integration run.
 */
function scopedEvidence(store: InMemoryStore, scope: WorkspaceId): ScopedEvidenceRepository {
  return {
    append: (event: EvidenceEventInput) => {
      store.evidence.push({
        ...event,
        workspaceId: scope,
        // The real adapter lets the database stamp this. The fake cannot, and
        // says so by reusing occurredAt rather than inventing a plausible gap.
        recordedAt: event.occurredAt,
      });
      return Promise.resolve();
    },

    listForSigningRequest: (signingRequestId: TransactionId) =>
      Promise.resolve(
        store.evidence
          .filter(e => e.workspaceId === scope && e.signingRequestId === signingRequestId)
          // Same total order as the adapter: occurredAt, then ID. Sorting only
          // by timestamp would make the fake and PostgreSQL disagree whenever
          // two events share a millisecond.
          .sort((a, b) =>
            a.occurredAt - b.occurredAt
            || a.evidenceEventId.localeCompare(b.evidenceEventId)),
      ),
  };
}

function scopedArtifacts(store: InMemoryStore, scope: WorkspaceId): ScopedArtifactRepository {
  return {
    insert: (artifact: ArtifactRecord) => {
      if (artifact.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Artifact", scope, artifact.workspaceId);
      }
      if (artifact.sourceArtifactId === artifact.artifactId) {
        throw new Error("An artifact cannot be derived from itself.");
      }
      store.artifacts.push(artifact);
      return Promise.resolve();
    },

    find: (artifactId: ArtifactId) =>
      Promise.resolve(
        store.artifacts.find(a => a.workspaceId === scope && a.artifactId === artifactId) ?? null,
      ),

    listForDocument: (documentId: DocumentId) =>
      Promise.resolve(
        store.artifacts.filter(a => a.workspaceId === scope && a.documentId === documentId),
      ),
  };
}

function scopedFinalizations(
  store: InMemoryStore,
  scope: WorkspaceId,
): ScopedFinalizationRepository {
  return {
    recordFinalization: (input: FinalizationInput) => {
      const { seal, verification } = input;
      if (seal.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Seal", scope, seal.workspaceId);
      }
      if (verification.workspaceId !== scope) {
        throw new FakeScopeMismatchError("VerificationRecord", scope, verification.workspaceId);
      }
      // Mirrors the database's UNIQUE (workspace_id, signing_request_id).
      // Resealing is not a product feature.
      if (store.seals.some(s => s.workspaceId === scope
        && s.signingRequestId === seal.signingRequestId)) {
        throw new Error("This signing request is already finalized.");
      }
      store.seals.push(seal);
      store.verifications.push(verification);
      return Promise.resolve();
    },

    findBySigningRequest: (signingRequestId: TransactionId) =>
      Promise.resolve(
        store.seals.find(s => s.workspaceId === scope
          && s.signingRequestId === signingRequestId) ?? null,
      ),
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
        evidence: scopedEvidence(this.store, workspaceId),
        artifacts: scopedArtifacts(this.store, workspaceId),
        finalizations: scopedFinalizations(this.store, workspaceId),
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
