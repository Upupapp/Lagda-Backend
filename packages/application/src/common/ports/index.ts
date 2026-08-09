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

// ── Transactions ─────────────────────────────────────────────────────────────

/**
 * An opaque handle to an in-flight transaction.
 *
 * Deliberately carries nothing. A `PoolClient` or ORM transaction object here
 * would put a database type in every repository signature, and application
 * would depend on the driver through the back door.
 */
declare const transactionBrand: unique symbol;

export interface TransactionContext {
  readonly [transactionBrand]: true;
}

/**
 * Groups writes that must succeed or fail together.
 *
 * ONE style, chosen and documented: repositories take the context as an
 * explicit final parameter. The alternative — a transaction-scoped repository
 * set — reads better but requires every adapter to rebuild its whole repository
 * surface per transaction. Mixing both is what makes transaction boundaries
 * impossible to audit.
 *
 * External side effects do not belong inside `run`. Email delivery, storage
 * uploads and remote calls hold the transaction open for as long as the network
 * takes, and cannot be rolled back when the commit later fails.
 */
export interface TransactionManager {
  run<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

// ── Repositories ─────────────────────────────────────────────────────────────

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

/**
 * Workspaces themselves are not workspace-scoped — a workspace IS the scope —
 * so `findById` takes only its own identifier. Forcing a redundant
 * `workspaceId` here would make the tenancy rule look ceremonial rather than
 * meaningful.
 */
export interface WorkspaceRepository {
  findById(workspaceId: WorkspaceId): Promise<WorkspaceRecord | null>;
  save(workspace: WorkspaceRecord, tx: TransactionContext): Promise<void>;
}

/**
 * Memberships ARE workspace-owned, so every read is scoped by construction
 * (INV-003). There is deliberately no `findByMemberId(memberId)`: such a method
 * would resolve a member from any workspace, and a caller that forgot to check
 * ownership would silently read across tenants.
 *
 * Absence returns `null` rather than throwing. A membership belonging to
 * another workspace is indistinguishable from one that does not exist, which is
 * what stops a lookup confirming another tenant's data.
 */
export interface WorkspaceMembershipRepository {
  findInWorkspace(
    workspaceId: WorkspaceId,
    memberId: WorkspaceMemberId,
  ): Promise<WorkspaceMembershipRecord | null>;

  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly WorkspaceMembershipRecord[]>;

  save(membership: WorkspaceMembershipRecord, tx: TransactionContext): Promise<void>;
}

// ── Document sealing ─────────────────────────────────────────────────────────

/**
 * The escape hatch BACKEND-00 built the architecture around.
 *
 * **This port has no consumer yet**, and that is stated rather than hidden.
 * It exists here now because §148 asked to fix its ownership, and because a
 * port's whole job is to invert a dependency before the implementation exists:
 * `@lagda/sealing` will implement this (BACKEND-09), and the signing completion
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
