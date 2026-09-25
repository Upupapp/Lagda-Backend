// Ports the application requires. Infrastructure implements them.
//
// The inversion is the point: `@lagda/db` imports these definitions to
// implement them, and application never imports `@lagda/db`. That is what lets
// PostgreSQL be replaced without touching a use case.
//
// Every port here has a NAMED CONSUMER except one, and that exception is
// called out where it appears. A port nobody consumes is the same failure as a
// field nobody reads.
import type {
  UserSigningRecordsRepository, SigningResumeIntentRepository,
} from "./user-signing-records.js";
import type { ScopedWorkflowTemplateRepository } from "./workflow-templates.js";
import type { ScopedUploadRequestRepository } from "./upload-requests.js";
import type { ScopedWorkflowTemplateFieldRepository } from "./workflow-template-fields.js";
import type { ScopedDocumentNotificationStateRepository } from "./document-notification-states.js";
import type { ScopedUploadRepository } from "./upload.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type {
  ScopedInvitationRepository, InvitationCredentialUnitOfWork,
  InvitationTokenDigest,
} from "./invitations.js";
import type { ScopedContactRepository } from "./contacts.js";
import type { ScopedDocumentRepository } from "./documents.js";
import type { ScopedFolderRepository } from "./folders.js";
import type { ScopedPreparationRepository } from "./preparation.js";
import type { ScopedRecipientRepository } from "./recipients.js";
import type {
  ScopedSigningRequestRepository, SigningRequestExpiryIndexRepository,
} from "./signing-requests.js";
import type { ScopedSigningAccessRepository } from "./signing-access.js";
import type {
  ScopedSigningWorkflowRepository, SigningWorkflowReconciliationRepository,
} from "./signing-workflow.js";
import type {
  ScopedCompletionRepository, CompletionReconciliationRepository,
  CompletionInputRepository, CompletionRetryIndexRepository,
} from "./completion.js";
import type {
  SigningCredentialUnitOfWork, RecipientSessionUnitOfWork,
  RecipientSessionDigest,
} from "./signing-sessions.js";
import type { SigningAccessDigest } from "./signing-access.js";

import type {
  WorkspaceId, WorkspaceMemberId, UserId, WorkspaceRole,
} from "@lagda/contracts";
import type { NormalizedEmail } from "../../auth/email-identity.js";
import type {
  NotificationRepository, NotificationTransportRepository,
  NotificationDispatchRepository, NotificationScope,
} from "./notifications.js";
import type { ScopedOrganizationUnitRepository } from "../../organization/index.js";

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
  /**
   * Display names for people this workspace already knows about.
   *
   * ONE method, and narrow on purpose. An invitation email says who invited
   * you, and a membership record carries a `userId` and no name — so rendering
   * that sentence needs a read the workspace unit of work did not have.
   *
   * It is not a general account repository and must not become one. Anything
   * beyond a display name — an email, a password hash, a verification state —
   * would put account data inside a tenant transaction, where a workspace
   * member could become readable to the workspace rather than to themselves.
   */
  readonly actorProfiles: ActorProfileRepository;
  /**
   * The org chart (TENANT_CORE): departments, offices, teams and four more
   * labels for the same structural thing.
   *
   * Scoped like every other tenant repository. A unit is a CONTAINER rather
   * than a permission, so nothing in the authorization path reads it — the org
   * chart routes and reports, and roles decide access.
   */
  readonly organizationUnits: ScopedOrganizationUnitRepository;
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
   * The notification substrate, on the SAME transaction (BACKEND-44).
   *
   * Reachable here for the same reason idempotency is: the guarantee depends on
   * it. A notification intent must be written inside the transaction that owns
   * the fact justifying it, so a rollback takes the intent with it and a commit
   * cannot leave a message owed for something that never happened.
   *
   * The tables carry their own scope discriminant rather than a bare
   * `workspace_id`, because an account security notification belongs to a user
   * and not to a tenant. The repository is therefore unscoped at construction
   * and each row states its own scope.
   */
  readonly notifications: NotificationRepository;
  /**
   * Delivery claiming and attempt history (BACKEND-45).
   *
   * Separate from `notifications` because it exists only once a provider does.
   * On the same unit of work because a claim and the attempt it opens must
   * commit together, or a provider call could happen with no durable record
   * that it was about to.
   */
  readonly notificationTransport: NotificationTransportRepository;
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
  /** The workspace's folder tree. Reads only -- see the repository. */
  readonly folders: ScopedFolderRepository;
  /**
   * Document preparation (BACKEND-30).
   *
   * Beside `documents` and `artifacts`, and the adjacency matters: a layout
   * save validates against the source artifact's page count and writes the
   * fields on ONE transaction with ONE tenant context.
   */
  readonly preparations: ScopedPreparationRepository;
  /**
   * Signing recipients (BACKEND-31).
   *
   * Beside `preparations` and `contacts`, and the adjacency is load-bearing:
   * creating a recipient from a contact reads the contact and writes the
   * snapshot on ONE transaction, so the copy cannot be taken from a contact
   * that a concurrent edit has since changed.
   */
  readonly recipients: ScopedRecipientRepository;
  /**
   * Signing requests (BACKEND-32).
   *
   * Beside the four repositories a snapshot reads from - documents, artifacts,
   * preparations, recipients - and the adjacency is the whole point: the
   * snapshot is taken and written on ONE transaction, so it cannot capture
   * recipients from one revision and fields from another.
   */
  readonly signingRequests: ScopedSigningRequestRepository;
  /**
   * Signing access provisioning (BACKEND-33).
   *
   * Beside `signingRequests`, because the state transition and the credentials
   * that make it meaningful must commit together: a request marked SENT whose
   * recipients hold no way in is worse than one that failed to send.
   */
  readonly signingAccess: ScopedSigningAccessRepository;
  /**
   * Signing workflow state (BACKEND-37).
   *
   * Beside `signingAccess`, and the adjacency is load-bearing: activating the
   * next cohort writes the recipients' states AND their credentials AND their
   * delivery intents, and a cohort that activated without a usable way in is
   * worse than one that did not activate at all (§53, §54, §167).
   */
  readonly signingWorkflow: ScopedSigningWorkflowRepository;
  /**
   * Completion pipeline state (BACKEND-38).
   *
   * Beside `signingWorkflow`, and the adjacency is the trigger: the transition
   * to `completion-ready` and the CompletionRun that acts on it are written in
   * ONE transaction, so a request cannot reach readiness without acquiring
   * durable completion work.
   */
  readonly completion: ScopedCompletionRepository;
  readonly completionReconciliation: CompletionReconciliationRepository;
  /** BACKEND-38. Completion's read-only view of accepted signing facts. */
  readonly completionInputs: CompletionInputRepository;
  /**
   * Migration 056's invitation-side writes: an invited recipient whose
   * address belongs to a verified account gets an entry that account alone
   * can read. Never read back from here -- see the migration's rule.
   */
  readonly userSigningRecords: UserSigningRecordsRepository;
  /**
   * Whether a recipient of THIS workspace's request bound an account (051).
   *
   * The one read migration 051 calls out as permitted: per-request audit,
   * never a join key across a list. `getSigningRequestSignatures` is its
   * only caller.
   */
  readonly accountLinks: Pick<SigningAccountLinkRepository, "findLinkForRecipient">;
  /**
   * Migration 058's reusable workflow templates. Workspace configuration,
   * scoped by this unit of work and again by row-level security.
   */
  readonly workflowTemplates: ScopedWorkflowTemplateRepository;
  /** 060. A template's field geometry, per role slot. */
  readonly workflowTemplateFields: ScopedWorkflowTemplateFieldRepository;
  /**
   * 071. This reader's own read/dismissed state on the document notification
   * feed. Keyed by the SESSION's user id, which the use case supplies — never
   * a body field.
   */
  readonly notificationStates: ScopedDocumentNotificationStateRepository;
  /**
   * 067. Documents this workspace has ASKED a member to supply — the one
   * flow where the workspace does not hold the file yet.
   */
  readonly uploadRequests: ScopedUploadRequestRepository;
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

  /**
   * The account-binding handoff (Phase 2).
   *
   * Global for the same reason the exceptions above are, with one difference
   * worth stating: those tables carry no policy because a cross-tenant SWEEP
   * needs to see every tenant. These two carry none because they are a MESSAGE
   * BETWEEN realms — an intent minted by a recipient session and claimed by an
   * account, neither of which can see the other's scope. A message only one
   * side can read is not a message.
   *
   * `signing_account_links` offers no lookup by user, deliberately. Migration
   * 051 explains why at length; the short version is that a query by user is
   * the query an inbox would need, and this table must not become the thing an
   * inbox is built on.
   */
  readonly signingAccountLinks: SigningAccountLinkRepository;

  /**
   * An account's own signing records (migrations 055, 056), read by the
   * account's user id. Global because the rows span every workspace the
   * account was ever sent a document from, and no tenant scope holds them.
   */
  readonly userSigningRecords: UserSigningRecordsRepository;
  /** The account-to-ceremony handoff for continuing to sign from the app. */
  readonly signingResumeIntents: SigningResumeIntentRepository;

  /**
   * Saved marks handed to one ceremony session, awaiting use.
   *
   * Global for the same reason the handoff tables are: written by the
   * workspace realm, read by the recipient realm, and readable by neither
   * one's own scope.
   */
  readonly preparedSignatures: PreparedSignatureRepository;
  /**
   * Outstanding signing-workflow advances, across every tenant (BACKEND-37).
   *
   * One of THREE exceptions to "global mode is not a route to workspace data",
   * and all three are narrow enough to state exactly: the table each reads
   * carries no policy because a cross-tenant scan cannot have one without
   * `BYPASSRLS`, and each returns IDENTIFIERS ONLY. The caller then enters each
   * workspace properly and does the work under normal tenancy.
   *
   * `idempotency_records` established the shape. Nothing here can read a name,
   * an address, a field value or a credential, because none of those is in the
   * table.
   */
  readonly signingWorkflowReconciliation: SigningWorkflowReconciliationRepository;

  /**
   * Requests whose deadline has passed, across every tenant (BACKEND-46).
   *
   * The THIRD exception, and deliberately identical in shape to the first two:
   * `signing_request_expiry_index` carries no policy, is maintained by a
   * trigger, and holds a request id, a workspace id and an instant. A deadline
   * passes with nobody watching, so the work has to be findable without a
   * tenant -- and `signing_requests` itself cannot be scanned across tenants
   * without `BYPASSRLS`, which INV-334 rejected.
   */
  readonly signingRequestExpiryIndex: SigningRequestExpiryIndexRepository;

  /**
   * Completion runs waiting to be driven again (BACKEND-38 recovery).
   *
   * The FOURTH exception, same shape and same reason. A run that failed
   * retryably parks in `waiting-retry` and NOTHING inside its own workspace is
   * watching for it: the immediate trigger already fired, the stale-attempt
   * sweep only reclaims `processing`, and the readiness sweep only looks for
   * requests with no run at all. So the parked run has to be findable without
   * a tenant, and `signing_request_completion_runs` cannot be scanned across
   * tenants any more than `signing_requests` can.
   */
  readonly completionRetryIndex: CompletionRetryIndexRepository;

  /**
   * Transport work that needs finding without a tenant (BACKEND-45, OD-174).
   *
   * The second exception, and the same shape as the others by design rather
   * than by coincidence: `notification_dispatch_index` is derived, unpoliced and
   * made of identifiers. It answers "which deliveries are due", "which leases
   * expired" and "which delivery does this provider reference name" — and
   * nothing else about any of them.
   */
  readonly notificationDispatch: NotificationDispatchRepository;
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

/**
 * A transaction bound to ONE delivery's own scope (BACKEND-45).
 *
 * ── Why transport needs its own unit of work ──────────────────────────────
 *
 * A notification is workspace-scoped or global-user-scoped, and only the row
 * knows which. `runForWorkspace` cannot reach an account security message, and
 * `runForUser` is read-only by policy and carries no transport repository —
 * so between them a password reset could be created and never delivered.
 *
 * ── Why it is narrow ──────────────────────────────────────────────────────
 *
 * Two repositories. It cannot read a signing request, a recipient, an evidence
 * event or a document, because it holds nothing that could — the same
 * structural argument the webhook module makes, applied to the transaction
 * rather than to the imports.
 */
export interface NotificationDeliveryUnitOfWork {
  readonly scope: NotificationScope;
  readonly notifications: NotificationRepository;
  readonly notificationTransport: NotificationTransportRepository;
}

/**
 * The one account fact a workspace transaction may read.
 *
 * `users` carries no tenant policy, so this read is possible from here; the
 * bound on it is the interface, not the database. Null for an account that no
 * longer exists — the caller renders a fallback rather than failing a whole
 * invitation over a deleted inviter.
 */
export interface ActorProfileRepository {
  displayNameOf(userId: UserId): Promise<string | null>;
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
   * A transaction in ONE delivery's own scope, workspace or global-user.
   *
   * The scope is READ FROM THE DISPATCH INDEX, never taken from a queue
   * payload. A job that could name its own tenant would be a job an operator
   * could hand-write into another workspace's data.
   */
  runForNotificationDelivery<T>(
    scope: NotificationScope,
    operation: (uow: NotificationDeliveryUnitOfWork) => Promise<T>,
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

  /**
   * A transaction bound to a signing BOOTSTRAP credential (BACKEND-34).
   *
   * The recipient realm's entry point. A recipient has no workspace context, so
   * the credential establishes it — the same shape invitations use, with its
   * own setting so the two realms cannot see each other's rows.
   */
  runForSigningCredential<T>(
    credentialDigest: SigningAccessDigest,
    operation: (uow: SigningCredentialUnitOfWork) => Promise<T>,
  ): Promise<T>;

  /**
   * A transaction bound to an established recipient SESSION cookie.
   *
   * A third realm. Read-only: resolving a session tells the caller who is
   * asking, and every write it then performs happens through a scope the
   * session's own workspace establishes.
   */
  runForRecipientSession<T>(
    sessionDigest: RecipientSessionDigest,
    operation: (uow: RecipientSessionUnitOfWork) => Promise<T>,
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
export * from "./folders.js";

export * from "./preparation.js";

// `RecipientId` is declared here and re-exported by `evidence.js`, so it is
// exported explicitly to tell TypeScript which module owns it.
export * from "./recipients.js";

export * from "./signing-requests.js";
export * from "./user-signing-records.js";
export * from "./workflow-templates.js";
export * from "./workflow-template-fields.js";
export * from "./document-notification-states.js";
export * from "./flow-document.js";
export * from "./upload-requests.js";

export * from "./signing-access.js";

export * from "./signing-sessions.js";
export * from "./signing-ceremony.js";
export * from "./signing-submission.js";
export * from "./signing-workflow.js";
export * from "./completion.js";
export * from "./completion-certificate.js";

export * from "./notifications.js";
import type { SigningAccountLinkRepository } from "./signing-account-link.js";
import type { PreparedSignatureRepository } from "./prepared-signatures.js";
export * from "./signing-account-link.js";
export * from "./prepared-signatures.js";
