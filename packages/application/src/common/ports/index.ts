// Ports the application requires. Infrastructure implements them.
//
// The inversion is the point: `@lagda/db` imports these definitions to
// implement them, and application never imports `@lagda/db`. That is what lets
// PostgreSQL be replaced without touching a use case.
//
// Every port here has a NAMED CONSUMER except one, and that exception is
// called out where it appears. A port nobody consumes is the same failure as a
// field nobody reads.

import type { WorkspaceId, WorkspaceMemberId, UserId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * The only source of "now" in the backend.
 *
 * Use cases read the clock and pass the value into pure domain functions, which
 * never read it themselves. A test supplies a fixed instant and gets the same
 * result forever.
 */
export interface Clock {
  /** Milliseconds since the epoch, matching the domain's `Instant`. */
  now(): number;
}

// ── Identity generation ──────────────────────────────────────────────────────
//
// Separate generators per identifier type, not one `generateId(): string`.
// A single generator returning a bare string would hand back a value assignable
// to any branded ID, which quietly undoes the branding BACKEND-02 introduced.
//
// These are for ENTITY identity only. Security tokens — reset, session, signing
// access, OTP — need unguessability guarantees an entity ID does not, and get
// their own ports in the commands that need them.

export interface WorkspaceIdGenerator {
  nextWorkspaceId(): WorkspaceId;
}

export interface WorkspaceMemberIdGenerator {
  nextWorkspaceMemberId(): WorkspaceMemberId;
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly ownerUserId: UserId;
  readonly createdAt: number;
}

export interface WorkspaceMembershipRecord {
  readonly memberId: WorkspaceMemberId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly createdAt: number;
}

// ── Scoped repositories ──────────────────────────────────────────────────────
//
// Bound to ONE workspace and ONE transaction, obtained from a unit of work.
//
// The binding is the security property. Previously a method took a workspace ID
// and a transaction as arguments, which made `findInWorkspace(otherWorkspace,
// …)` inside this workspace's transaction *expressible* — RLS caught it, but
// the API allowed writing it. Here the workspace is not a parameter, so the
// mistake cannot be typed.
//
// No `workspaceId` argument, no optional tenant scope, no bypass flag anywhere.

export interface ScopedWorkspaceRepository {
  /** The workspace this unit of work is bound to, or null if it does not exist. */
  find(): Promise<WorkspaceRecord | null>;

  /**
   * @throws if the record's workspace differs from the bound scope. The
   *         workspace is never silently rewritten to match.
   */
  insert(workspace: WorkspaceRecord): Promise<void>;
}

export interface ScopedMembershipRepository {
  findMember(memberId: WorkspaceMemberId): Promise<WorkspaceMembershipRecord | null>;

  findByUser(userId: UserId): Promise<WorkspaceMembershipRecord | null>;

  list(): Promise<readonly WorkspaceMembershipRecord[]>;

  countOwners(): Promise<number>;

  /** @throws on workspace mismatch, as above. */
  insert(membership: WorkspaceMembershipRecord): Promise<void>;

  /**
   * Changes a role only if it still holds the expected value.
   *
   * A conditional update, not read-then-write: two concurrent requests reading
   * `sender` would both write, and the second would overwrite the first without
   * either noticing. Here the second matches zero rows.
   *
   * Returns whether the change applied. **Zero rows is ambiguous** — the member
   * may not exist, may belong to another workspace, or may have changed
   * concurrently — and a caller must not reveal which.
   *
   * The repository makes an *authorized* transition race-safe. Whether the
   * transition is *valid* is a domain question and stays in `@lagda/core`.
   */
  changeRoleIfUnchanged(input: {
    readonly memberId: WorkspaceMemberId;
    readonly expectedRole: WorkspaceRole;
    readonly nextRole: WorkspaceRole;
  }): Promise<boolean>;
}

// ── Unit of work ─────────────────────────────────────────────────────────────

/**
 * Repositories sharing ONE transaction and ONE workspace.
 *
 * Every repository reachable here writes through the same transaction, so
 * "atomic" means atomic. The previous shape — separate repository instances each
 * handed a context — made it possible for one to use the pool while another used
 * the transaction, producing false atomicity that looked correct.
 *
 * Do not retain this past the callback: its repositories are bound to a
 * transaction that has committed, and using them afterwards is a
 * use-after-commit bug.
 */
export interface WorkspaceUnitOfWork {
  readonly workspaceId: WorkspaceId;
  readonly workspaces: ScopedWorkspaceRepository;
  readonly memberships: ScopedMembershipRepository;
}

/**
 * A unit of work with NO tenant context, for genuinely global data.
 *
 * Deliberately exposes no tenant repositories: global mode is not a route to
 * workspace data. Under RLS it would see nothing anyway; this makes that
 * structural rather than incidental.
 */
export interface GlobalUnitOfWork {
  readonly scope: "global";
}

export interface TransactionManager {
  /**
   * A transaction bound to ONE workspace. The ordinary path.
   *
   * The adapter establishes tenant context for the transaction, so a query that
   * forgets its scope returns nothing rather than another tenant's rows.
   * Application code never issues that context itself.
   */
  runForWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T>;

  /**
   * A transaction with NO tenant context — user accounts, sessions, system
   * records.
   *
   * A separate method rather than an optional workspace argument. With
   * `run(workspaceId?)`, forgetting the argument would silently mean
   * unrestricted access — the most dangerous possible default. Here, global
   * access is something you have to ask for by name.
   */
  runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T>;
}

// ── Document sealing ─────────────────────────────────────────────────────────

/**
 * The escape hatch BACKEND-00 built the architecture around.
 *
 * **This port has no consumer yet**, and that is stated rather than hidden.
 * `@lagda/sealing` will implement it (BACKEND-09) and the signing completion
 * use case will consume it (BACKEND-38).
 *
 * ONE operation. `mergeFields`, `hashDocument` and `signPdf` stay internal to
 * the sealing package — exposing them would give twenty callers a reason to
 * reach past the seam, and INV-002 exists so exactly one does.
 *
 * `SealRequest` and `SealResult` are LAGDA-owned. No `pdf-lib` type crosses
 * this boundary (INV-008), which is what makes a later Java or .NET
 * implementation a substitution rather than a rewrite.
 */
export interface SealRequest {
  readonly transactionId: string;
  readonly workspaceId: WorkspaceId;
  readonly sealedAt: number;
}

export interface SealResult {
  readonly signedDocumentHash: string;
  readonly sealScheme: string;
  readonly sealVersion: number;
  readonly digestAlgorithm: string;
}

export interface DocumentSealer {
  seal(request: SealRequest): Promise<SealResult>;
}
