// Ports the application requires. Infrastructure implements them.
//
// The inversion is the point: `@lagda/db` imports these definitions to
// implement them, and application never imports `@lagda/db`. That is what lets
// PostgreSQL be replaced without touching a use case.
//
// Every port here has a NAMED CONSUMER except one, and that exception is
// called out where it appears. A port nobody consumes is the same failure as a
// field nobody reads.
import type { ScopedUploadRepository } from "./upload.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type {
  ScopedInvitationRepository, InvitationCredentialUnitOfWork,
  InvitationTokenDigest,
} from "./invitations.js";
import type { ScopedContactRepository } from "./contacts.js";
import type { ScopedDocumentRepository } from "./documents.js";
import type { ScopedPreparationRepository } from "./preparation.js";

import type {
  WorkspaceId, WorkspaceMemberId, UserId, WorkspaceRole,
} from "@lagda/contracts";
import type { NormalizedEmail } from "../../auth/email-identity.js";

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

/**
 * A workspace row.
 *
 * ── There is no `ownerUserId`, and its removal is the point of BACKEND-25 ──
 *
 * The column existed from BACKEND-05 and was a SECOND authority on who owns a
 * workspace, alongside the `owner` membership row that the same transaction
 * writes. Two authorities agree until one of them is updated alone — which is
 * exactly what an ownership transfer does — and then "who owns this workspace?"
 * has two answers and no rule for choosing.
 *
 * Membership is the authoritative user-to-tenant edge (§12). Ownership is a
 * membership whose role is `owner`, and it is read from `workspace_memberships`
 * or it is not read at all. Migration 013 drops the column.
 */
export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly createdAt: number;
}

/**
 * One row of "the workspaces this user belongs to".
 *
 * A JOIN projection, not a workspace and not a membership: it carries the
 * caller's OWN role, which is meaningful only in relation to the user who asked.
 * Modelling it as a `WorkspaceRecord` with a role bolted on would invite that
 * role to be read as a property of the workspace.
 */
export interface UserWorkspaceMembershipRecord {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly workspaceCreatedAt: number;
  readonly membershipId: WorkspaceMemberId;
  readonly role: WorkspaceRole;
  readonly joinedAt: number;
}

export interface WorkspaceMembershipRecord {
  readonly memberId: WorkspaceMemberId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly createdAt: number;
}

/**
 * A membership joined to its account, for the member directory (BACKEND-27).
 *
 * A JOIN projection, and a DISTINCT type from `WorkspaceMembershipRecord`
 * rather than an optional email on it. The distinction is the point: this shape
 * carries personal data, and a type that sometimes has an address and sometimes
 * does not is one a caller stops thinking about.
 */
export interface WorkspaceMemberDirectoryRecord {
  readonly memberId: WorkspaceMemberId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly createdAt: number;
  /** The DISPLAY address. `normalized_email` is internal and never leaves. */
  readonly email: string;
  readonly displayName: string;
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

  /**
   * Renames the bound workspace. Returns false if it does not exist.
   *
   * ONE named column. Not `update(patch: Partial<WorkspaceRecord>)`, which would
   * let a caller pass `{ workspaceId }` and move a tenant, or `{ createdAt }`
   * and rewrite history — the mass-assignment shape INV-306 already banned on
   * the accounts table for the same reason.
   */
  updateName(name: string): Promise<boolean>;
}

export interface ScopedMembershipRepository {
  findMember(memberId: WorkspaceMemberId): Promise<WorkspaceMembershipRecord | null>;

  findByUser(userId: UserId): Promise<WorkspaceMembershipRecord | null>;

  /**
   * The membership of whoever owns this email address, if they are in this
   * workspace (BACKEND-26).
   *
   * A JOIN to `users` on the canonical normalized address, inside the tenant
   * scope. It exists so invitation creation can refuse to email someone who is
   * already a member, rather than discovering it only when they try to accept.
   *
   * Takes an ALREADY-NORMALIZED key. A repository that normalized for itself
   * would be a second normalization rule, and the two would drift (INV-231).
   *
   * Returns null for an address with no account — which is the ordinary case
   * for an invitation, and is not an error.
   */
  findByNormalizedEmail(
    email: NormalizedEmail,
  ): Promise<WorkspaceMembershipRecord | null>;

  list(): Promise<readonly WorkspaceMembershipRecord[]>;

  /**
   * The member directory, joined to accounts (BACKEND-27).
   *
   * A separate method from `list()` rather than a flag, because it returns
   * PERSONAL DATA — every member's email address — and a boolean parameter is
   * how a caller ends up fetching it without meaning to. The capability gate is
   * `membership.view`; this is the only method that can produce the addresses.
   */
  listWithAccounts(): Promise<readonly WorkspaceMemberDirectoryRecord[]>;

  /**
   * How many owners this workspace currently has.
   *
   * Read INSIDE the mutation transaction by anything that could reduce it. A
   * count read before the transaction is a check against state that may have
   * changed by the time the write lands (§44, §141).
   */
  countOwners(): Promise<number>;

  /**
   * Removes a membership, conditionally on its role being unchanged.
   *
   * Conditional for the same reason `changeRoleIfUnchanged` is: two
   * administrators acting concurrently must not both proceed against state only
   * one of them saw. The role is the thing the last-owner check was made
   * against, so it is the thing the delete is conditioned on.
   *
   * A hard DELETE. See `removeWorkspaceMember` for why the row is not marked
   * instead — a `removed_at` column would put non-members in the table that
   * answers "may this person act here".
   *
   * Returns whether it applied. Zero rows is ambiguous — absent, another
   * tenant, or changed concurrently — and the caller reports none of those.
   */
  removeIfRole(input: {
    readonly memberId: WorkspaceMemberId;
    readonly expectedRole: WorkspaceRole;
  }): Promise<boolean>;

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
  readonly evidence: ScopedEvidenceRepository;
  readonly artifacts: ScopedArtifactRepository;
  readonly finalizations: ScopedFinalizationRepository;
  /**
   * Upload processing records (BACKEND-18).
   *
   * In the unit of work like every other tenant repository, so an upload row
   * and the artifact it accepts are written on ONE transaction with ONE tenant
   * context. Built separately, they would run on different connections and the
   * second would have no RLS context at all.
   */
  readonly uploads: ScopedUploadRepository;
  /**
   * Durable idempotency, on the SAME transaction (BACKEND-25).
   *
   * Reachable from the unit of work because the guarantee depends on it: the
   * claim row must be inserted inside the business transaction, so that a
   * rollback takes the claim with it and a retry can execute. A repository built
   * from the pool would leave a poisoned key behind every failed mutation.
   *
   * `idempotency_records` carries no `workspace_id` and no RLS — its scope is a
   * typed union that includes user and recipient. It is on the tenant unit of
   * work for transactional reasons only, and every method still takes the full
   * identity.
   */
  readonly idempotency: IdempotencyRepository;
  /**
   * Workspace invitations (BACKEND-26).
   *
   * On the tenant unit of work like every other workspace-owned repository, so
   * an invitation and the membership its acceptance creates are written on ONE
   * transaction with ONE tenant context.
   */
  readonly invitations: ScopedInvitationRepository;
  /**
   * The workspace address book (BACKEND-28).
   *
   * On the tenant unit of work like every other workspace-owned repository. It
   * is here rather than on its own so a future operation that creates a
   * document's recipients FROM contacts reads the address book and writes the
   * recipients on one transaction — but note that reading is all it will do:
   * the recipient snapshot copies values out, it does not reference the row.
   */
  readonly contacts: ScopedContactRepository;
  /**
   * Documents (BACKEND-29).
   *
   * On the tenant unit of work beside `artifacts`, and that adjacency is the
   * point: creating a document and later resolving its original artifact happen
   * through the same transaction and the same tenant context, so a document can
   * never be paired with bytes from another workspace.
   */
  readonly documents: ScopedDocumentRepository;
  /**
   * Document preparation (BACKEND-30).
   *
   * Beside `documents` and `artifacts`, and the adjacency matters: a layout
   * save validates against the source artifact's page count and writes the
   * fields on ONE transaction with ONE tenant context.
   */
  readonly preparations: ScopedPreparationRepository;
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

/**
 * Reads a user's own memberships, across every workspace they belong to.
 *
 * ── Why this exists, and why it is not `runGlobal` ─────────────────────────
 *
 * "Which workspaces do I belong to?" is the one question that is genuinely
 * user-scoped rather than tenant-scoped: there is no single workspace to bind,
 * because finding them is the point. Under `runGlobal` the RLS policies match
 * nothing and the answer is always empty; the alternatives are to grant the
 * runtime role BYPASSRLS (§85 forbids it) or to define a user-scoped access
 * path (§88 requires it). This is that path.
 *
 * ── Why it cannot become a tenant escape ───────────────────────────────────
 *
 * The transaction sets `lagda.user_id` and NOT `lagda.workspace_id`, so the
 * tenant-isolation policies match nothing for the whole transaction. The
 * user-scoped policies added by migration 013 are `FOR SELECT` only. A write of
 * any kind against `workspaces` or `workspace_memberships` from here is refused
 * by PostgreSQL, not by convention — which is why this interface has one method
 * and it is a read.
 */
export interface UserMembershipQueryRepository {
  /**
   * The caller's memberships joined to their workspaces.
   *
   * Ordered by the database, deterministically. Sorting in the application
   * would require loading every row first, and "insertion order" is an
   * assumption PostgreSQL never made.
   */
  listWorkspaces(): Promise<readonly UserWorkspaceMembershipRecord[]>;
}

/** A transaction scoped to ONE user's own records. Read-only by policy. */
export interface UserUnitOfWork {
  readonly userId: UserId;
  readonly memberships: UserMembershipQueryRepository;
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

  /**
   * A transaction scoped to ONE user's own membership records (BACKEND-25).
   *
   * A THIRD named method rather than an optional argument on either of the
   * others, for the same reason `runGlobal` is separate: every scope you can
   * get has to be asked for by name, so no scope is ever the accidental
   * default.
   *
   * Not a second tenant mechanism (§92). It establishes no workspace context and
   * exposes no tenant repositories — the only thing reachable through it is the
   * caller's own membership edges, and only for reading.
   */
  runForUser<T>(
    userId: UserId,
    operation: (uow: UserUnitOfWork) => Promise<T>,
  ): Promise<T>;

  /**
   * A transaction scoped to ONE invitation credential (BACKEND-26).
   *
   * The FOURTH named scope, and the narrowest. It establishes no workspace
   * context and exposes exactly one read: the invitation whose digest was
   * supplied. Its purpose is the one operation the other three cannot express —
   * a non-member resolving which tenant they were invited to.
   *
   * Tenant context is entered afterwards, from the RESOLVED workspace, through
   * `enterWorkspace` on the same transaction.
   */
  runForInvitationCredential<T>(
    tokenDigest: InvitationTokenDigest,
    operation: (uow: InvitationCredentialUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

import type {
  ScopedEvidenceRepository,
  ScopedArtifactRepository,
  ScopedFinalizationRepository,
} from "./evidence.js";

// ── Evidence, artifacts and finalization ─────────────────────────────────────
//
// Defined in ./evidence.ts and re-exported here, same as the sealing seam.

export * from "./evidence.js";

// ── Document sealing ─────────────────────────────────────────────────────────
//
// The seam lives in ./sealing.ts, re-exported here so there is exactly one
// definition of DocumentSealer in the codebase.

export * from "./sealing.js";

export * from "./invitations.js";

export * from "./contacts.js";

export * from "./documents.js";

export * from "./preparation.js";
