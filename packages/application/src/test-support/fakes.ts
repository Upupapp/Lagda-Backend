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

import type {
  RecipientWorkflowRepository, ScopedSigningWorkflowRepository,
  SigningWorkflowReconciliationRepository, WorkflowAdvanceIntentRef,
  WorkflowAdvanceTrigger, SigningWorkflowIntentId, SigningWorkflowIdGenerator,
} from "../common/ports/signing-workflow.js";
import type {
  RecipientWorkflowState, SigningDeclineReason,
  CompletionRunState, CompletionStep, CompletionStepState, CompletionFailureCode,
} from "@lagda/contracts";
import type {
  ScopedCompletionRepository, CompletionReconciliationRepository,
  CompletionRunRecord, CompletionRunId, CompletionStepId, CompletionIdGenerator,
  CompletionInputRepository,
} from "../common/ports/completion.js";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";
import type { UploadRecord, ScopedUploadRepository } from "../common/ports/upload.js";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork, GlobalUnitOfWork, UserUnitOfWork,
  ScopedWorkspaceRepository, ScopedMembershipRepository,
  UserMembershipQueryRepository, UserWorkspaceMembershipRecord,
  WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRecord, WorkspaceMembershipRecord,
  ScopedEvidenceRepository, ScopedArtifactRepository, ScopedFinalizationRepository,
  EvidenceEventInput, EvidenceEventRecord, ArtifactRecord, ArtifactId,
  EvidenceEventId, EvidenceEventIdGenerator,
  FinalizationInput, SealRecord,
} from "../common/ports/index.js";
import { InMemoryIdempotencyRepository } from "./idempotency-fake.js";
import type {
  ScopedInvitationRepository, InvitationCredentialUnitOfWork,
  InvitationTokenDigest, WorkspaceInvitationRecord, NewWorkspaceInvitation,
} from "../common/ports/invitations.js";
import type {
  RecipientCeremonyUnitOfWork, NewCeremonyConsent,
} from "../common/ports/signing-ceremony.js";
import type {
  NewRecipientSubmission, NewSigningRepresentation, NewSigningFieldValue,
  RecipientSubmissionId,
} from "../common/ports/signing-submission.js";
import type {
  RenderableValue, CompletionRecord,
} from "../common/ports/completion.js";
import type { WorkspaceInvitationId } from "@lagda/contracts";
import type { NormalizedEmail } from "../auth/email-identity.js";
import type { TransactionId, DocumentId, ContactId } from "@lagda/contracts";
import type {
  ScopedContactRepository, ContactRecord, NewContact, ContactIdGenerator,
} from "../common/ports/contacts.js";
import type {
  ScopedDocumentRepository, DocumentRecord, NewDocument, DocumentIdGenerator,
} from "../common/ports/documents.js";
import type {
  ScopedPreparationRepository, PreparationRecord, NewPreparation,
  PreparationFieldRecord, PreparationId, PreparationFieldId,
  PreparationIdGenerator,
} from "../common/ports/preparation.js";
import type {
  ScopedRecipientRepository, RecipientRecord, NewRecipient,
  RecipientId, RecipientIdGenerator,
} from "../common/ports/recipients.js";
import type {
  SigningCredentialUnitOfWork, RecipientSessionUnitOfWork,
  RecipientWorkspaceUnitOfWork, ResolvedSigningAccess, ResolvedRecipientSession,
  NewRecipientSigningSession, RecipientSigningSessionId, RecipientSessionDigest,
  RecipientSigningSessionIdGenerator,
} from "../common/ports/signing-sessions.js";
import type { SigningAccessDigest } from "../common/ports/signing-access.js";
import type {
  ScopedSigningAccessRepository, NewSigningAccessGrant, NewDeliveryIntent,
  SigningAccessGrantId, DeliveryIntentId,
  SigningAccessIdGenerator,
} from "../common/ports/signing-access.js";
import type {
  ScopedSigningRequestRepository, NewSigningRequestSnapshot,
  SigningRequestRecord, SigningRequestRecipientRecord, SigningRequestFieldRecord,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningRequestIdGenerator,
} from "../common/ports/signing-requests.js";

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

export class SequentialContactIds implements ContactIdGenerator {
  private next = 1;
  nextContactId(): ContactId {
    return `con_${String(this.next++)}` as ContactId;
  }
}

export class SequentialDocumentIds implements DocumentIdGenerator {
  private next = 1;
  nextDocumentId(): DocumentId {
    return `doc_${String(this.next++)}` as DocumentId;
  }
}

/**
 * Sequential signing-access ids.
 *
 * Separate counters again, so a grant id and a delivery-intent id can never
 * be compared successfully by accident.
 */
/** Sequential recipient signing-session ids. */
export class SequentialRecipientSessionIds
implements RecipientSigningSessionIdGenerator {
  private next = 1;
  nextRecipientSigningSessionId(): RecipientSigningSessionId {
    return `rss_${String(this.next++)}` as RecipientSigningSessionId;
  }
}

/** Sequential workflow advance-intent ids (BACKEND-37). */
export class SequentialSigningWorkflowIds implements SigningWorkflowIdGenerator {
  private next = 1;
  nextSigningWorkflowIntentId(): SigningWorkflowIntentId {
    return `swi_${String(this.next++)}` as SigningWorkflowIntentId;
  }
}

export class SequentialSigningAccessIds
implements SigningAccessIdGenerator, EvidenceEventIdGenerator {
  private grant = 1;
  private intent = 1;
  private evidence = 1;

  /** BACKEND-43. Send appends `transaction-sent` and one event per activation. */
  nextEvidenceEventId(): EvidenceEventId {
    return `ev_${String(this.evidence++)}` as EvidenceEventId;
  }
  nextSigningAccessGrantId(): SigningAccessGrantId {
    return `sag_${String(this.grant++)}` as SigningAccessGrantId;
  }
  nextDeliveryIntentId(): DeliveryIntentId {
    return `sdi_${String(this.intent++)}` as DeliveryIntentId;
  }
}

/**
 * Sequential signing-request ids.
 *
 * Three counters, not one. A test that accidentally compared a request id to a
 * recipient id would pass against a shared counter and fail against the real
 * generators - and telling the three apart is most of what BACKEND-32 is for.
 */
export class SequentialSigningRequestIds
implements SigningRequestIdGenerator, EvidenceEventIdGenerator {
  private request = 1;
  private recipient = 1;
  private field = 1;
  private evidence = 1;

  /**
   * BACKEND-43. Creation appends `transaction-created`.
   *
   * A FOURTH counter, for the same reason the class already has three: a test
   * that accidentally compared an event id to a request id would pass against a
   * shared counter and fail against the real generators.
   */
  nextEvidenceEventId(): EvidenceEventId {
    return `ev_${String(this.evidence++)}` as EvidenceEventId;
  }
  nextSigningRequestId(): SigningRequestId {
    return `sr_${String(this.request++)}` as SigningRequestId;
  }
  nextSigningRequestRecipientId(): SigningRequestRecipientId {
    return `srr_${String(this.recipient++)}` as SigningRequestRecipientId;
  }
  nextSigningRequestFieldId(): SigningRequestFieldId {
    return `srf_${String(this.field++)}` as SigningRequestFieldId;
  }
}

/**
 * Sequential recipient ids.
 *
 * `rcp_1`, not the email and not the order index: a test that accidentally
 * depended on either would pass here and break the moment the real generator
 * ran (§7).
 */
export class SequentialRecipientIds implements RecipientIdGenerator {
  private next = 1;
  nextRecipientId(): RecipientId {
    return `rcp_${String(this.next++)}` as RecipientId;
  }
}

export class SequentialPreparationIds implements PreparationIdGenerator {
  private preparation = 1;
  private field = 1;
  nextPreparationId(): PreparationId {
    return `prep_${String(this.preparation++)}` as PreparationId;
  }
  nextPreparationFieldId(): PreparationFieldId {
    return `pf_${String(this.field++)}` as PreparationFieldId;
  }
}

/** Mirrors the adapter's mismatch rejection so fakes cannot be more permissive. */
export class FakeScopeMismatchError extends Error {
  constructor(entity: string, scope: string, actual: string) {
    super(`${entity} belongs to workspace ${actual}, scope is ${scope}.`);
    this.name = "FakeScopeMismatchError";
  }
}

/** One accepted signing act. The real table is unique per recipient. */
export interface SubmissionRow {
  readonly submissionId: string;
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly acceptedAt: number;
  /**
   * Recorded ON the submission, mirroring `recipient_submissions`.
   *
   * The real table carries this column, and the certificate binds to it rather
   * than to a session lookup (§150). A fake without it could not represent that
   * binding, so a test could not tell a correct implementation from one that
   * resolved the recipient's latest authentication instead.
   */
  readonly authenticationMethod: string;
  readonly valueCount: number;
  readonly representations: readonly NewSigningRepresentation[];
  readonly values: readonly NewSigningFieldValue[];
}

/** The immutable completion fact. Mirrors `signing_request_completions`. */
export interface CompletionRow {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly completionRunId: string;
  readonly mergedArtifactId: string;
  readonly certificateArtifactId: string;
  readonly finalArtifactId: string;
  readonly completedAt: number;
  readonly sealScheme: string;
  readonly sealVersion: number;
  readonly digestAlgorithm: string;
  readonly pipelineVersion: number;
}

/** A ceremony-entry row. Keyed like the real composite primary key. */
export interface CeremonyProgressRow {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly firstEnteredAt: number;
}

/** An acceptance row. The real table's unique constraint is emulated below. */
export interface CeremonyConsentRow {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly consentType: string;
  readonly consentVersion: string;
  readonly acceptedAt: number;
  readonly signingSessionId: string;
  readonly authenticationMethod: string;
}

/**
 * One recipient's workflow row (BACKEND-37).
 *
 * MUTABLE in place, unlike almost everything else in this store, because the
 * real table is the one thing in the signing stack that legitimately changes:
 * a recipient goes waiting -> active -> signed. Snapshot and restore copy each
 * ROW rather than the array, so a rolled-back fake transaction really does undo
 * a state change instead of keeping a shared object's new value.
 */
interface ActivationRow {
  signingRequestId: string;
  recipientId: SigningRequestRecipientId;
  state: RecipientWorkflowState;
  activatedAt: number | null;
  signedAt: number | null;
  submissionId: RecipientSubmissionId | null;
  declinedAt: number | null;
  declineReason: SigningDeclineReason | null;
}

/** A durable "this request needs re-evaluating" record. */
interface WorkflowIntentRow {
  intentId: SigningWorkflowIntentId;
  workspaceId: WorkspaceId;
  signingRequestId: SigningRequestId;
  recipientId: SigningRequestRecipientId;
  trigger: WorkflowAdvanceTrigger;
  submissionId: RecipientSubmissionId | null;
  createdAt: number;
  appliedAt: number | null;
  attempts: number;
  lastFailureCode: string | null;
}

/** A completion run. MUTABLE in place, like the workflow row. */
interface CompletionRunRow {
  completionRunId: CompletionRunId;
  workspaceId: WorkspaceId;
  signingRequestId: SigningRequestId;
  state: CompletionRunState;
  pipelineVersion: number;
  attemptCount: number;
  createdAt: number;
  startedAt: number | null;
  lastAttemptAt: number | null;
  succeededAt: number | null;
  failureStep: CompletionStep | null;
  failureCode: CompletionFailureCode | null;
}

/** One accepted step result. The real table admits exactly one per step. */
interface CompletionStepRow {
  completionStepId: CompletionStepId;
  workspaceId: WorkspaceId;
  completionRunId: CompletionRunId;
  step: CompletionStep;
  state: CompletionStepState;
  outputArtifactId: ArtifactId | null;
  attemptCount: number;
  succeededAt: number | null;
  failureCode: CompletionFailureCode | null;
}

interface StoreSnapshot {
  readonly workspaces: Map<string, WorkspaceRecord>;
  readonly memberships: WorkspaceMembershipRecord[];
  readonly invitations: WorkspaceInvitationRecord[];
  readonly invitationDigests: Map<string, string>;
  readonly contacts: ContactRecord[];
  readonly documents: DocumentRecord[];
  readonly preparations: PreparationRecord[];
  readonly preparationFields: PreparationFieldRecord[];
  readonly recipients: RecipientRecord[];
  readonly signingRequests: SigningRequestRecord[];
  readonly signingRequestRecipients: SigningRequestRecipientRecord[];
  readonly signingRequestFields: SigningRequestFieldRecord[];
  readonly signingAccessGrants: NewSigningAccessGrant[];
  readonly deliveryIntents: NewDeliveryIntent[];
  readonly activations: ActivationRow[];
  readonly workflowIntents: WorkflowIntentRow[];
  readonly completionRuns: CompletionRunRow[];
  readonly completionSteps: CompletionStepRow[];
  readonly completions: CompletionRow[];
  readonly recipientSessions: NewRecipientSigningSession[];
  readonly ceremonyProgress: CeremonyProgressRow[];
  readonly ceremonyConsents: CeremonyConsentRow[];
  readonly submissions: SubmissionRow[];
  readonly evidence: EvidenceEventRecord[];
  readonly artifacts: ArtifactRecord[];
  readonly seals: SealRecord[];
  readonly verifications: FinalizationInput["verification"][];
  readonly uploads: Map<string, UploadRecord>;
}

/** Shared store, so a unit of work sees writes from earlier transactions. */
export class InMemoryStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly memberships: WorkspaceMembershipRecord[] = [];
  invitations: WorkspaceInvitationRecord[] = [];
  /**
   * Canonical address to account, standing in for the `users` table.
   *
   * The fake models repositories, not the database. This is the minimum needed
   * for the one membership query that joins to accounts.
   */
  readonly accountEmails = new Map<string, UserId>();
  /** Digest to invitation id. The real lookup is an RLS policy on a unique column. */
  readonly invitationDigests = new Map<string, string>();
  contacts: ContactRecord[] = [];
  documents: DocumentRecord[] = [];
  preparations: PreparationRecord[] = [];
  preparationFields: PreparationFieldRecord[] = [];
  recipients: RecipientRecord[] = [];
  signingRequests: SigningRequestRecord[] = [];
  signingRequestRecipients: SigningRequestRecipientRecord[] = [];
  signingRequestFields: SigningRequestFieldRecord[] = [];
  signingAccessGrants: NewSigningAccessGrant[] = [];
  deliveryIntents: NewDeliveryIntent[] = [];
  activations: ActivationRow[] = [];
  workflowIntents: WorkflowIntentRow[] = [];
  completionRuns: CompletionRunRow[] = [];
  completionSteps: CompletionStepRow[] = [];
  completions: CompletionRow[] = [];
  recipientSessions: NewRecipientSigningSession[] = [];
  ceremonyProgress: CeremonyProgressRow[] = [];
  ceremonyConsents: CeremonyConsentRow[] = [];
  submissions: SubmissionRow[] = [];
  /** Snapshot row to its request. The real tables carry the column. */
  readonly snapshotOwners = new Map<string, SigningRequestId>();
  /** Field id to preparation id. The real table has a column. */
  readonly fieldOwners = new Map<string, PreparationId>();
  readonly evidence: EvidenceEventRecord[] = [];
  readonly artifacts: ArtifactRecord[] = [];
  readonly seals: SealRecord[] = [];
  readonly verifications: FinalizationInput["verification"][] = [];
  readonly uploads = new Map<string, UploadRecord>();

  snapshot(): StoreSnapshot {
    return {
      workspaces: new Map(this.workspaces),
      uploads: new Map(this.uploads),
      memberships: [...this.memberships],
      invitations: [...this.invitations],
      invitationDigests: new Map(this.invitationDigests),
      contacts: [...this.contacts],
      documents: [...this.documents],
      preparations: [...this.preparations],
      preparationFields: [...this.preparationFields],
      recipients: [...this.recipients],
      signingRequests: [...this.signingRequests],
      signingRequestRecipients: [...this.signingRequestRecipients],
      signingRequestFields: [...this.signingRequestFields],
      signingAccessGrants: [...this.signingAccessGrants],
      deliveryIntents: [...this.deliveryIntents],
      activations: this.activations.map(row => ({ ...row })),
      workflowIntents: this.workflowIntents.map(row => ({ ...row })),
      completionRuns: this.completionRuns.map(row => ({ ...row })),
      completionSteps: this.completionSteps.map(row => ({ ...row })),
      completions: this.completions.map(row => ({ ...row })),
      recipientSessions: [...this.recipientSessions],
      ceremonyProgress: [...this.ceremonyProgress],
      ceremonyConsents: [...this.ceremonyConsents],
      submissions: [...this.submissions],
      evidence: [...this.evidence],
      artifacts: [...this.artifacts],
      seals: [...this.seals],
      verifications: [...this.verifications],
    };
  }

  restore(snapshot: StoreSnapshot): void {
    // Uploads restore with everything else. Omitting them would let a
    // rolled-back transaction leave an upload row behind - the exact
    // inconsistency the snapshot exists to prevent.
    this.uploads.clear();
    for (const [key, value] of snapshot.uploads) this.uploads.set(key, value);
    this.workspaces.clear();
    for (const [key, value] of snapshot.workspaces) this.workspaces.set(key, value);
    this.memberships.length = 0;
    this.memberships.push(...snapshot.memberships);
    this.invitations = [...snapshot.invitations];
    this.contacts = [...snapshot.contacts];
    this.documents = [...snapshot.documents];
    this.preparations = [...snapshot.preparations];
    this.preparationFields = [...snapshot.preparationFields];
    this.recipients = [...snapshot.recipients];
    this.signingRequests = [...snapshot.signingRequests];
    this.signingRequestRecipients = [...snapshot.signingRequestRecipients];
    this.signingRequestFields = [...snapshot.signingRequestFields];
    this.signingAccessGrants = [...snapshot.signingAccessGrants];
    this.deliveryIntents = [...snapshot.deliveryIntents];
    this.activations = snapshot.activations.map(row => ({ ...row }));
    this.workflowIntents = snapshot.workflowIntents.map(row => ({ ...row }));
    this.completionRuns = snapshot.completionRuns.map(row => ({ ...row }));
    this.completionSteps = snapshot.completionSteps.map(row => ({ ...row }));
    this.completions = snapshot.completions.map(row => ({ ...row }));
    this.recipientSessions = [...snapshot.recipientSessions];
    this.ceremonyProgress = [...snapshot.ceremonyProgress];
    this.ceremonyConsents = [...snapshot.ceremonyConsents];
    this.submissions = [...snapshot.submissions];
    this.invitationDigests.clear();
    for (const [k, v] of snapshot.invitationDigests) this.invitationDigests.set(k, v);
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
    updateName: (name: string) => {
      const existing = store.workspaces.get(scope);
      if (existing === undefined) return Promise.resolve(false);
      store.workspaces.set(scope, { ...existing, name });
      return Promise.resolve(true);
    },
  };
}

/**
 * The user-scoped read, in memory.
 *
 * Filters on `userId` and joins to the workspace, exactly as the SQL does — and
 * applies the SAME ordering. A fake that returned insertion order would let a
 * test assert an order the database does not guarantee.
 */
function userMemberships(
  store: InMemoryStore, userId: UserId,
): UserMembershipQueryRepository {
  return {
    listWorkspaces: () => {
      const rows: UserWorkspaceMembershipRecord[] = [];
      for (const membership of store.memberships) {
        if (membership.userId !== userId) continue;
        const workspace = store.workspaces.get(membership.workspaceId);
        // An INNER JOIN. A membership without its workspace produces no row,
        // which is what the database does and what the foreign key prevents.
        if (workspace === undefined) continue;
        rows.push({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          workspaceCreatedAt: workspace.createdAt,
          membershipId: membership.memberId,
          role: membership.role,
          joinedAt: membership.createdAt,
        });
      }
      rows.sort((a, b) =>
        b.joinedAt - a.joinedAt || a.membershipId.localeCompare(b.membershipId));
      return Promise.resolve(rows);
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

    // The fake has no accounts table, so the join is against the store's
    // registered addresses. `InMemoryStore.accountEmails` is what a test seeds
    // to say "this user's canonical address is X" — the PostgreSQL adapter
    // reads the real `users` row.
    findByNormalizedEmail: (email: NormalizedEmail) => {
      const userId = store.accountEmails.get(email);
      if (userId === undefined) return Promise.resolve(null);
      return Promise.resolve(inScope().find(m => m.userId === userId) ?? null);
    },

    list: () => Promise.resolve(inScope()),

    listWithAccounts: () => Promise.resolve(
      [...inScope()]
        .sort((a, b) => a.createdAt - b.createdAt || a.memberId.localeCompare(b.memberId))
        .map(m => {
          // The fake has no accounts table; `accountEmails` is what a test
          // seeds. An unseeded user gets a placeholder rather than throwing,
          // so a directory test does not have to register every fixture.
          let email = `${m.userId}@fixture.invalid`;
          for (const [address, id] of store.accountEmails) {
            if (id === m.userId) email = address;
          }
          return { ...m, email, displayName: m.userId };
        })),

    removeIfRole: (input) => {
      const index = store.memberships.findIndex(
        m => m.workspaceId === scope
          && m.memberId === input.memberId
          && m.role === input.expectedRole,
      );
      if (index === -1) return Promise.resolve(false);
      store.memberships.splice(index, 1);
      return Promise.resolve(true);
    },

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
/**
 * The "still live" predicate, mirroring the partial unique index exactly.
 *
 * A fake that defined "active" differently would let a use case be written
 * against behaviour PostgreSQL refuses, and only the integration run would say
 * so.
 */
const isLive = (i: WorkspaceInvitationRecord): boolean =>
  i.acceptedAt === null && i.revokedAt === null
  && i.declinedAt === null && i.supersededAt === null;

function scopedInvitations(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedInvitationRepository {
  const inScope = () => store.invitations.filter(i => i.workspaceId === scope);
  const replaceLive = (
    id: WorkspaceInvitationId,
    change: (current: WorkspaceInvitationRecord) => WorkspaceInvitationRecord,
  ): boolean => {
    const index = store.invitations.findIndex(
      i => i.workspaceId === scope && i.invitationId === id && isLive(i));
    const current = index === -1 ? undefined : store.invitations[index];
    if (current === undefined) return false;
    store.invitations[index] = change(current);
    return true;
  };

  return {
    insert: (invitation: NewWorkspaceInvitation) => {
      if (invitation.workspaceId !== scope) {
        throw new FakeScopeMismatchError(
          "WorkspaceInvitation", scope, invitation.workspaceId);
      }
      // The partial unique index, in memory. Without it a use case could leave
      // two live invitations for one address and only PostgreSQL would object.
      const clash = inScope().some(
        i => i.inviteeNormalizedEmail === invitation.inviteeNormalizedEmail && isLive(i));
      if (clash) throw new Error("duplicate active invitation");
      if (store.invitationDigests.has(invitation.tokenDigest)) {
        throw new Error("duplicate invitation token digest");
      }
      store.invitationDigests.set(invitation.tokenDigest, invitation.invitationId);
      store.invitations.push({
        invitationId: invitation.invitationId,
        workspaceId: invitation.workspaceId,
        inviteeEmail: invitation.inviteeEmail,
        inviteeNormalizedEmail: invitation.inviteeNormalizedEmail,
        requestedRole: invitation.requestedRole,
        invitedByUserId: invitation.invitedByUserId,
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        acceptedAt: null, acceptedByUserId: null,
        revokedAt: null, declinedAt: null, supersededAt: null,
      });
      return Promise.resolve();
    },

    findById: (invitationId: WorkspaceInvitationId) =>
      Promise.resolve(inScope().find(i => i.invitationId === invitationId) ?? null),

    findActiveByNormalizedEmail: (email: NormalizedEmail) =>
      Promise.resolve(
        inScope().find(i => i.inviteeNormalizedEmail === email && isLive(i)) ?? null),

    list: () => Promise.resolve(
      [...inScope()].sort((a, b) =>
        b.createdAt - a.createdAt || a.invitationId.localeCompare(b.invitationId))),

    supersedeActiveForEmail: (input) => {
      let count = 0;
      store.invitations = store.invitations.map(i => {
        if (i.workspaceId !== scope) return i;
        if (i.inviteeNormalizedEmail !== input.email || !isLive(i)) return i;
        count += 1;
        return { ...i, supersededAt: input.now };
      });
      return Promise.resolve(count);
    },

    rotateCredentialIfLive: (input) =>
      Promise.resolve(replaceLive(input.invitationId, current => {
        // The old digest stops resolving. That IS the supersession of the old
        // link, and a fake that left it resolvable would hide the defect.
        for (const [digest, id] of store.invitationDigests) {
          if (id === current.invitationId) store.invitationDigests.delete(digest);
        }
        store.invitationDigests.set(input.tokenDigest, current.invitationId);
        return { ...current, expiresAt: input.expiresAt };
      })),

    revokeIfLive: (input) =>
      Promise.resolve(replaceLive(input.invitationId, c => ({ ...c, revokedAt: input.now }))),

    acceptIfLive: (input) => Promise.resolve(replaceLive(input.invitationId, c => ({
      ...c, acceptedAt: input.now, acceptedByUserId: input.acceptedByUserId,
    }))),

    declineIfLive: (input) =>
      Promise.resolve(replaceLive(input.invitationId, c => ({ ...c, declinedAt: input.now }))),
  };
}

/**
 * The in-memory address book.
 *
 * Mirrors the adapter's ORDERING and its CONDITIONAL updates, not just its
 * return types. Both matter: a fake that sorted differently would let a
 * pagination bug pass, and one whose `updateIfActive` was unconditional would
 * let a use case be written that resurrects an archived contact.
 *
 * It deliberately does NOT enforce a unique email — because the table does not.
 * A fake stricter than the schema would hide the duplicate-warning behaviour
 * the product asked for.
 */
function scopedContacts(store: InMemoryStore, scope: WorkspaceId): ScopedContactRepository {
  const inScope = () => store.contacts.filter(c => c.workspaceId === scope);

  const replaceWhere = (
    contactId: ContactId,
    matches: (current: ContactRecord) => boolean,
    change: (current: ContactRecord) => ContactRecord,
  ): boolean => {
    const index = store.contacts.findIndex(
      c => c.workspaceId === scope && c.contactId === contactId && matches(c));
    const current = index === -1 ? undefined : store.contacts[index];
    if (current === undefined) return false;
    store.contacts[index] = change(current);
    return true;
  };

  const active = (c: ContactRecord) => c.archivedAt === null;

  return {
    insert: (contact: NewContact) => {
      if (contact.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Contact", scope, contact.workspaceId);
      }
      store.contacts.push({
        contactId: contact.contactId,
        workspaceId: contact.workspaceId,
        name: contact.name,
        email: contact.email,
        emailKey: contact.emailKey,
        phone: contact.phone,
        organization: contact.organization,
        title: contact.title,
        createdAt: contact.createdAt,
        // Equal to createdAt, exactly as the adapter does it.
        updatedAt: contact.createdAt,
        archivedAt: null,
      });
      return Promise.resolve();
    },

    findById: (contactId: ContactId) =>
      Promise.resolve(inScope().find(c => c.contactId === contactId) ?? null),

    list: (query) => {
      const term = query.search?.toLocaleLowerCase("en-US") ?? null;
      const matched = inScope()
        .filter(c => query.state === "active" ? c.archivedAt === null : c.archivedAt !== null)
        .filter(c => term === null || [c.name, c.email, c.organization, c.title]
          .some(field => field !== null && field.toLocaleLowerCase("en-US").includes(term)));

      const key = (c: ContactRecord): string | number =>
        query.sort === "name" ? c.name
          : query.sort === "organization" ? (c.organization ?? "")
            : c.updatedAt;

      const sorted = [...matched].sort((a, b) => {
        const left = key(a);
        const right = key(b);
        // NULLS LAST in both directions, matching the adapter. An empty
        // organization sorts after every non-empty one either way.
        if (query.sort === "organization") {
          const aNull = a.organization === null;
          const bNull = b.organization === null;
          if (aNull !== bNull) return aNull ? 1 : -1;
        }
        const cmp = typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : Number(left) - Number(right);
        const directed = query.direction === "asc" ? cmp : -cmp;
        // The same tie-breaker the adapter applies, so pagination is stable.
        return directed || a.contactId.localeCompare(b.contactId);
      });

      return Promise.resolve({
        items: sorted.slice(query.offset, query.offset + query.limit),
        // The total matching the FILTER, not the page.
        total: sorted.length,
      });
    },

    findDuplicateCandidates: (input) => Promise.resolve(
      inScope()
        .filter(c => c.emailKey === input.emailKey && c.archivedAt === null)
        .filter(c => input.excludeContactId === null || c.contactId !== input.excludeContactId)
        .sort((a, b) => a.createdAt - b.createdAt || a.contactId.localeCompare(b.contactId))),

    updateIfActive: (input) => Promise.resolve(
      replaceWhere(input.contactId, active, current => ({
        ...current,
        // Only the keys the caller supplied — `??` would treat an explicit null
        // (clear the field) as absent, which is the one distinction that
        // matters here.
        name: input.patch.name ?? current.name,
        email: input.patch.email ?? current.email,
        emailKey: input.patch.emailKey ?? current.emailKey,
        phone: input.patch.phone === undefined ? current.phone : input.patch.phone,
        organization: input.patch.organization === undefined
          ? current.organization : input.patch.organization,
        title: input.patch.title === undefined ? current.title : input.patch.title,
        updatedAt: input.now,
      }))),

    archiveIfActive: (input) => Promise.resolve(
      replaceWhere(input.contactId, active,
        c => ({ ...c, archivedAt: input.now, updatedAt: input.now }))),

    restoreIfArchived: (input) => Promise.resolve(
      replaceWhere(input.contactId, c => c.archivedAt !== null,
        c => ({ ...c, archivedAt: null, updatedAt: input.now }))),
  };
}

/**
 * The in-memory document table.
 *
 * Mirrors the adapter's ORDERING and its write-once filename rule, not merely
 * its return types. The second matters: a fake whose `recordOriginalFilename`
 * was unconditional would let a use case be written that rewrites the
 * provenance of an earlier upload.
 */
function scopedDocuments(store: InMemoryStore, scope: WorkspaceId): ScopedDocumentRepository {
  const inScope = () => store.documents.filter(d => d.workspaceId === scope);

  const replace = (
    documentId: DocumentId,
    matches: (current: DocumentRecord) => boolean,
    change: (current: DocumentRecord) => DocumentRecord,
  ): boolean => {
    const index = store.documents.findIndex(
      d => d.workspaceId === scope && d.documentId === documentId && matches(d));
    const current = index === -1 ? undefined : store.documents[index];
    if (current === undefined) return false;
    store.documents[index] = change(current);
    return true;
  };

  return {
    insert: (document: NewDocument) => {
      if (document.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Document", scope, document.workspaceId);
      }
      store.documents.push({
        documentId: document.documentId,
        workspaceId: document.workspaceId,
        title: document.title,
        originalFilename: document.originalFilename,
        createdByUserId: document.createdByUserId,
        createdAt: document.createdAt,
        // Equal to createdAt, exactly as the adapter does it.
        updatedAt: document.createdAt,
      });
      return Promise.resolve();
    },

    findById: (documentId: DocumentId) =>
      Promise.resolve(inScope().find(d => d.documentId === documentId) ?? null),

    list: (query) => {
      const sorted = [...inScope()].sort((a, b) => {
        const cmp = query.sort === "title"
          ? a.title.localeCompare(b.title)
          : a.createdAt - b.createdAt;
        const directed = query.direction === "asc" ? cmp : -cmp;
        // The same tie-breaker the adapter applies, so pagination is stable.
        return directed || b.documentId.localeCompare(a.documentId);
      });
      return Promise.resolve({
        items: sorted.slice(query.offset, query.offset + query.limit),
        total: sorted.length,
      });
    },

    rename: (input) => Promise.resolve(
      replace(input.documentId, () => true,
        d => ({ ...d, title: input.title, updatedAt: input.now }))),

    recordOriginalFilename: (input) => Promise.resolve(
      // Write-once, matching the adapter's `where original_filename is null`.
      replace(input.documentId, d => d.originalFilename === null,
        d => ({ ...d, originalFilename: input.originalFilename, updatedAt: input.now }))),
  };
}

/**
 * The in-memory preparation store.
 *
 * Mirrors the adapter's CONDITIONAL replace exactly: the revision and the
 * editability check happen together, so a use case cannot be written that
 * passes here and races in PostgreSQL.
 */
function scopedPreparations(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedPreparationRepository {
  return {
    insert: (preparation: NewPreparation) => {
      if (preparation.workspaceId !== scope) {
        throw new FakeScopeMismatchError(
          "DocumentPreparation", scope, preparation.workspaceId);
      }
      // The unique constraint, in memory. Without it the creation race would
      // pass against the fake and converge only in PostgreSQL.
      const clash = store.preparations.some(
        p => p.workspaceId === scope && p.documentId === preparation.documentId);
      if (clash) throw new Error("duplicate preparation for document");

      store.preparations.push({
        preparationId: preparation.preparationId,
        workspaceId: preparation.workspaceId,
        documentId: preparation.documentId,
        sourceArtifactId: preparation.sourceArtifactId,
        revision: 1,
        lockedAt: null,
        createdAt: preparation.createdAt,
        updatedAt: preparation.createdAt,
      });
      return Promise.resolve();
    },

    findByDocument: (documentId) => Promise.resolve(
      store.preparations.find(
        p => p.workspaceId === scope && p.documentId === documentId) ?? null),

    listFields: (preparationId) => Promise.resolve(
      store.preparationFields
        .filter(f => f.fieldId.startsWith("") && preparationOf(store, f) === preparationId)
        .filter(() => true)
        // The adapter's order: page, then layer, then id.
        .sort((a, b) =>
          a.pageNumber - b.pageNumber
          || a.layer - b.layer
          || a.fieldId.localeCompare(b.fieldId))),

    replaceLayout: (input) => {
      const index = store.preparations.findIndex(
        p => p.workspaceId === scope
          && p.preparationId === input.preparationId
          && p.revision === input.expectedRevision
          && p.lockedAt === null);
      const current = index === -1 ? undefined : store.preparations[index];
      if (current === undefined) return Promise.resolve(null);

      const revision = input.expectedRevision + 1;
      store.preparations[index] = { ...current, revision, updatedAt: input.now };
      // Replace, matching the adapter: delete then insert.
      store.preparationFields = store.preparationFields.filter(
        f => preparationOf(store, f) !== input.preparationId);
      for (const field of input.fields) {
        store.preparationFields.push(field);
        store.fieldOwners.set(field.fieldId, input.preparationId);
      }
      return Promise.resolve(revision);
    },
  };
}

/**
 * The in-memory signing-access store.
 *
 * Reproduces the two constraints that carry the rules: ONE active grant per
 * recipient, and ONE delivery intent per grant. Without them a duplicate-send
 * bug would pass here and be caught only by PostgreSQL.
 */
function scopedSigningAccess(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedSigningAccessRepository {
  return {
    insertGrant: (grant: NewSigningAccessGrant) => {
      if (grant.workspaceId !== scope) {
        throw new FakeScopeMismatchError(
          "SigningAccessGrant", scope, grant.workspaceId);
      }
      const clash = store.signingAccessGrants.some(
        existing => existing.workspaceId === scope
          && existing.signingRequestId === grant.signingRequestId
          && existing.recipientId === grant.recipientId);
      if (clash) throw new Error("recipient already holds an active grant");
      store.signingAccessGrants.push(grant);
      return Promise.resolve();
    },

    insertDeliveryIntent: (intent: NewDeliveryIntent) => {
      if (intent.workspaceId !== scope) {
        throw new FakeScopeMismatchError(
          "SigningDeliveryIntent", scope, intent.workspaceId);
      }
      if (store.deliveryIntents.some(existing => existing.grantId === intent.grantId)) {
        throw new Error("grant already has a delivery intent");
      }
      store.deliveryIntents.push(intent);
      return Promise.resolve();
    },

    insertActivations: (input) => {
      for (const activation of input.activations) {
        store.activations.push({
          signingRequestId: String(input.signingRequestId),
          recipientId: activation.recipientId,
          state: activation.state,
          activatedAt: activation.activatedAt,
          signedAt: null, submissionId: null,
          declinedAt: null, declineReason: null,
        });
      }
      return Promise.resolve();
    },

    listActivations: (signingRequestId) => Promise.resolve(
      store.activations
        .filter(a => a.signingRequestId === String(signingRequestId))
        .map(({ recipientId, state, activatedAt }) => ({
          recipientId, state, activatedAt,
        }))),
  };
}


// -- Signing workflow state (BACKEND-37) -------------------------------------

/** Advanceable request states, matching the repository's own predicate. */
const FAKE_ADVANCEABLE = ["sent", "partially-completed"];

/**
 * The recipient's OWN workflow row.
 *
 * Every method carries all three scope identifiers, exactly as the real one
 * does. A fake that ignored them would let a use-case bug reach another
 * recipient and still pass, which is the failure migration 024's restrictive
 * policy exists to stop.
 */
function recipientWorkflow(
  store: InMemoryStore,
  scope: {
    readonly workspaceId: WorkspaceId;
    readonly signingRequestId: SigningRequestId;
    readonly recipientId: SigningRequestRecipientId;
  },
): RecipientWorkflowRepository {
  const own = (): ActivationRow | undefined => store.activations.find(
    row => row.signingRequestId === String(scope.signingRequestId)
      && String(row.recipientId) === String(scope.recipientId));

  return {
    getState: () => Promise.resolve(own()?.state ?? null),

    markSignedFromSubmission: input => {
      const row = own();
      // Conditional, like the real UPDATE. A waiting recipient matches nothing
      // rather than skipping their turn.
      if (row === undefined || row.state !== "active") return Promise.resolve(false);
      row.state = "signed";
      row.signedAt = input.signedAt;
      row.submissionId = input.submissionId;
      return Promise.resolve(true);
    },

    markDeclined: input => {
      const row = own();
      if (row === undefined || row.state !== "active") return Promise.resolve(false);
      row.state = "declined";
      row.declinedAt = input.declinedAt;
      row.declineReason = input.reason;
      return Promise.resolve(true);
    },

    enqueueAdvance: intent => {
      // The real unique key is (request, recipient, trigger). Emulated, because
      // it is the constraint that stops a duplicate delivery activating a
      // cohort twice - and a fake that admitted the second row would pass a
      // test the database would fail.
      const clash = store.workflowIntents.some(
        row => row.signingRequestId === scope.signingRequestId
          && row.recipientId === scope.recipientId
          && row.trigger === intent.trigger);
      if (clash) return Promise.resolve(false);
      store.workflowIntents.push({
        intentId: intent.intentId,
        workspaceId: scope.workspaceId,
        signingRequestId: scope.signingRequestId,
        recipientId: scope.recipientId,
        trigger: intent.trigger,
        submissionId: intent.submissionId,
        createdAt: intent.createdAt,
        appliedAt: null,
        attempts: 0,
        lastFailureCode: null,
      });
      return Promise.resolve(true);
    },
  };
}

function scopedSigningWorkflow(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedSigningWorkflowRepository {
  const request = (signingRequestId: SigningRequestId) =>
    store.signingRequests.find(
      row => row.workspaceId === scope && row.signingRequestId === signingRequestId);

  const rowsFor = (signingRequestId: SigningRequestId) => store.activations.filter(
    row => row.signingRequestId === String(signingRequestId));

  const transition = (
    signingRequestId: SigningRequestId,
    from: readonly string[],
    patch: Partial<SigningRequestRecord>,
  ): Promise<boolean> => {
    const found = request(signingRequestId);
    if (found === undefined || !from.includes(found.state)) {
      return Promise.resolve(false);
    }
    const index = store.signingRequests.indexOf(found);
    store.signingRequests[index] = { ...found, ...patch };
    return Promise.resolve(true);
  };

  return {
    lockRequest: signingRequestId => {
      const found = request(signingRequestId);
      return Promise.resolve(found === undefined ? null : {
        state: found.state, completionReadyAt: found.completionReadyAt,
      });
    },

    listRecipientStates: signingRequestId => {
      // The join to the IMMUTABLE snapshot, as the real query does it. A state
      // row whose recipient is missing is DROPPED rather than defaulted:
      // routing must never invent a participant.
      const joined = rowsFor(signingRequestId).flatMap(row => {
        const snapshot = store.signingRequestRecipients.find(
          candidate => String(candidate.recipientId) === String(row.recipientId));
        if (snapshot === undefined) return [];
        return [{
          recipientId: row.recipientId,
          type: snapshot.type,
          isRequired: snapshot.isRequired,
          routingOrder: snapshot.routingOrder,
          state: row.state,
          activatedAt: row.activatedAt,
          signedAt: row.signedAt,
          submissionId: row.submissionId,
          declinedAt: row.declinedAt,
          declineReason: row.declineReason,
        }];
      });
      return Promise.resolve(
        [...joined].sort((a, b) => a.routingOrder - b.routingOrder
          || String(a.recipientId).localeCompare(String(b.recipientId))));
    },

    activateRecipients: input => {
      const wanted = new Set(input.recipientIds.map(String));
      let moved = 0;
      for (const row of rowsFor(input.signingRequestId)) {
        if (!wanted.has(String(row.recipientId)) || row.state !== "waiting") continue;
        row.state = "active";
        row.activatedAt = input.activatedAt;
        moved++;
      }
      return Promise.resolve(moved);
    },

    markPartiallyCompleted: signingRequestId =>
      transition(signingRequestId, ["sent"], { state: "partially-completed" }),

    markCompletionReady: input => transition(
      input.signingRequestId, FAKE_ADVANCEABLE,
      { state: "completion-ready", completionReadyAt: input.completionReadyAt }),

    // The ONE legal path into `completed`, from `completion-ready` ONLY.
    markCompleted: input => transition(
      input.signingRequestId, ["completion-ready"],
      { state: "completed", completedAt: input.completedAt }),

    markDeclined: input => transition(
      input.signingRequestId, FAKE_ADVANCEABLE,
      {
        state: "declined", terminatedAt: input.terminatedAt,
        terminationReason: "declined",
      }),

    markCancelled: input => transition(
      input.signingRequestId, FAKE_ADVANCEABLE,
      {
        state: "cancelled", terminatedAt: input.terminatedAt,
        terminationReason: "cancelled", cancellationNote: input.note,
      }),

    revokeActiveGrants: input => {
      const before = store.signingAccessGrants.length;
      store.signingAccessGrants = store.signingAccessGrants.filter(
        grant => !(grant.workspaceId === scope
          && grant.signingRequestId === input.signingRequestId));
      return Promise.resolve(before - store.signingAccessGrants.length);
    },

    revokeRecipientSessions: input => {
      const before = store.recipientSessions.length;
      store.recipientSessions = store.recipientSessions.filter(
        session => !(session.workspaceId === scope
          && session.signingRequestId === input.signingRequestId));
      return Promise.resolve(before - store.recipientSessions.length);
    },

    claimAdvanceIntent: intentId => {
      const row = store.workflowIntents.find(
        candidate => candidate.intentId === intentId
          && candidate.workspaceId === scope && candidate.appliedAt === null);
      if (row === undefined) return Promise.resolve(null);
      row.attempts++;
      return Promise.resolve(toIntentRefRow(row));
    },

    listOutstandingAdvances: signingRequestId => Promise.resolve(
      store.workflowIntents
        .filter(row => row.workspaceId === scope
          && row.signingRequestId === signingRequestId && row.appliedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(toIntentRefRow)),

    markAdvanceApplied: input => {
      const row = store.workflowIntents.find(
        candidate => candidate.intentId === input.intentId);
      if (row !== undefined) {
        row.appliedAt = input.appliedAt;
        row.lastFailureCode = null;
      }
      return Promise.resolve();
    },

    recordAdvanceFailure: input => {
      const row = store.workflowIntents.find(
        candidate => candidate.intentId === input.intentId);
      if (row !== undefined) row.lastFailureCode = input.code.slice(0, 64);
      return Promise.resolve();
    },
  };
}

function toIntentRefRow(row: WorkflowIntentRow): WorkflowAdvanceIntentRef {
  return {
    intentId: row.intentId,
    workspaceId: row.workspaceId,
    signingRequestId: row.signingRequestId,
    recipientId: row.recipientId,
    trigger: row.trigger,
    attempts: row.attempts,
  };
}

function workflowReconciliation(
  store: InMemoryStore,
): SigningWorkflowReconciliationRepository {
  return {
    listOutstanding: input => Promise.resolve(
      store.workflowIntents
        .filter(row => row.appliedAt === null && row.attempts < input.attemptsBelow)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, input.limit)
        .map(toIntentRefRow)),
  };
}


// -- Completion pipeline (BACKEND-38) ----------------------------------------

/** Mirrors `isCompletionRunClaimable`. */
const FAKE_CLAIMABLE: readonly string[] = ["pending", "waiting-retry"];

function scopedCompletion(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedCompletionRepository {
  const mine = (): CompletionRunRow[] =>
    store.completionRuns.filter(row => row.workspaceId === scope);

  const toRecord = (row: CompletionRunRow): CompletionRunRecord => ({ ...row });

  return {
    ensureRun: input => {
      // The one-per-request unique key, emulated. A fake that admitted the
      // second row would pass a test the database would fail - and this is the
      // constraint the whole trigger design rests on.
      const existing = mine().find(
        row => row.signingRequestId === input.signingRequestId);
      if (existing !== undefined) return Promise.resolve(toRecord(existing));

      const row: CompletionRunRow = {
        completionRunId: input.completionRunId,
        workspaceId: scope,
        signingRequestId: input.signingRequestId,
        state: "pending",
        pipelineVersion: input.pipelineVersion,
        attemptCount: 0,
        createdAt: input.createdAt,
        startedAt: null, lastAttemptAt: null, succeededAt: null,
        failureStep: null, failureCode: null,
      };
      store.completionRuns.push(row);
      return Promise.resolve(toRecord(row));
    },

    findRun: signingRequestId => Promise.resolve(
      mine().find(row => row.signingRequestId === signingRequestId
        ) as CompletionRunRecord | undefined ?? null),

    findRunById: runId => Promise.resolve(
      mine().find(row => row.completionRunId === runId
        ) as CompletionRunRecord | undefined ?? null),

    claimRun: input => {
      const row = mine().find(candidate => candidate.completionRunId === input.runId);
      // Conditional, like the real UPDATE: two workers handed the same job,
      // exactly one claim.
      if (row === undefined || !FAKE_CLAIMABLE.includes(row.state)) {
        return Promise.resolve(null);
      }
      row.state = "processing";
      row.attemptCount++;
      row.lastAttemptAt = input.at;
      row.startedAt = row.startedAt ?? input.at;
      row.failureStep = null;
      row.failureCode = null;
      return Promise.resolve(toRecord(row));
    },

    recordRunFailure: input => {
      const row = mine().find(candidate => candidate.completionRunId === input.runId);
      if (row === undefined || row.state !== "processing") {
        return Promise.resolve(false);
      }
      row.state = input.state;
      row.failureStep = input.step;
      row.failureCode = input.code;
      return Promise.resolve(true);
    },

    abandonStaleRuns: input => {
      let moved = 0;
      for (const row of mine()) {
        if (row.state !== "processing") continue;
        if (row.lastAttemptAt === null || row.lastAttemptAt >= input.lastAttemptBefore) {
          continue;
        }
        row.state = "waiting-retry";
        row.failureStep = "field-merge";
        row.failureCode = "attempt-abandoned";
        moved++;
      }
      return Promise.resolve(moved);
    },

    listSteps: runId => Promise.resolve(
      store.completionSteps
        .filter(row => row.workspaceId === scope && row.completionRunId === runId)
        .map(row => ({
          completionStepId: row.completionStepId,
          step: row.step,
          state: row.state,
          outputArtifactId: row.outputArtifactId,
          attemptCount: row.attemptCount,
          succeededAt: row.succeededAt,
          failureCode: row.failureCode,
        }))),

    acceptStep: input => {
      // One accepted result per logical step. A retry discovers the previous
      // attempt's output rather than replacing it.
      const clash = store.completionSteps.some(
        row => row.completionRunId === input.runId && row.step === input.step);
      if (clash) return Promise.resolve(false);
      store.completionSteps.push({
        completionStepId: input.completionStepId,
        workspaceId: scope,
        completionRunId: input.runId,
        step: input.step,
        state: "succeeded",
        outputArtifactId: input.outputArtifactId,
        attemptCount: 1,
        succeededAt: input.succeededAt,
        failureCode: null,
      });
      return Promise.resolve(true);
    },

    // No completion row can exist yet: BACKEND-41 writes the first one.
    findCompletion: signingRequestId => Promise.resolve(
      (store.completions.find(row => row.workspaceId === scope
        && row.signingRequestId === signingRequestId) ?? null) as
        CompletionRecord | null),

    recordCompletion: input => {
      // Mirrors UNIQUE (signing_request_id): a second completion converges on
      // the first rather than creating a competing record.
      const existing = store.completions.find(
        row => row.signingRequestId === input.signingRequestId);
      if (existing !== undefined) return Promise.resolve(false);
      store.completions.push({ workspaceId: scope, ...input });
      return Promise.resolve(true);
    },

    markRunSucceeded: input => {
      const run = store.completionRuns.find(
        row => row.workspaceId === scope && row.completionRunId === input.runId);
      if (run === undefined || run.state !== "processing") {
        return Promise.resolve(false);
      }
      run.state = "succeeded";
      run.succeededAt = input.succeededAt;
      run.failureStep = null;
      run.failureCode = null;
      return Promise.resolve(true);
    },
  };
}

function completionReconciliation(
  store: InMemoryStore, scope: WorkspaceId,
): CompletionReconciliationRepository {
  return {
    listReadyWithoutRun: limit => Promise.resolve(
      store.signingRequests
        .filter(request => request.workspaceId === scope
          && request.state === "completion-ready"
          && !store.completionRuns.some(
            run => run.workspaceId === scope
              && run.signingRequestId === request.signingRequestId))
        .slice(0, limit)
        .map(request => request.signingRequestId)),

    listClaimableRuns: limit => Promise.resolve(
      store.completionRuns
        .filter(row => row.workspaceId === scope && FAKE_CLAIMABLE.includes(row.state))
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(row => row.completionRunId)),
  };
}

function completionInputs(
  store: InMemoryStore, scope: WorkspaceId,
): CompletionInputRepository {
  return {
    listAcceptedFieldValues: signingRequestId => Promise.resolve(
      store.submissions
        .filter(row => row.workspaceId === scope
          && row.signingRequestId === signingRequestId)
        .flatMap(row => row.values.map(value => ({
          fieldId: String(value.fieldId),
          recipientId: row.recipientId,
        })))),

    // Joins the submission's values to the request's FIELD SNAPSHOT for
    // geometry, mirroring the real query. A fake that invented coordinates
    // would let a test pass against geometry the database could never produce.
    listRenderableFieldValues: signingRequestId => Promise.resolve(
      store.submissions
        .filter(row => row.workspaceId === scope
          && row.signingRequestId === signingRequestId)
        .flatMap(row => row.values.flatMap(value => {
          const field = store.signingRequestFields.find(
            candidate => String(candidate.fieldId) === String(value.fieldId));
          // No snapshot row means the value references a field this request
          // does not have. The real query drops it by inner join; dropping it
          // here keeps the two consistent.
          if (field === undefined) return [];

          const representation = value.representationId === null
            ? undefined
            : row.representations.find(candidate =>
              String(candidate.representationId) === String(value.representationId));

          return [{
            fieldId: String(value.fieldId),
            recipientId: row.recipientId,
            fieldType: String(field.type),
            pageNumber: field.pageNumber,
            x: field.x, y: field.y, width: field.width, height: field.height,
            value: fakeRenderableValue(value, representation),
          }];
        }))
        .sort((a, b) =>
          a.pageNumber - b.pageNumber || a.fieldId.localeCompare(b.fieldId))),

    // Mirrors the real query: only recipients WITH an accepted submission, and
    // authentication read off the SUBMISSION rather than a session lookup.
    listCertifiedParticipants: signingRequestId => Promise.resolve(
      store.submissions
        .filter(row => row.workspaceId === scope
          && row.signingRequestId === signingRequestId)
        .flatMap(row => {
          const snapshot = store.signingRequestRecipients.find(
            candidate => String(candidate.recipientId) === String(row.recipientId));
          if (snapshot === undefined) return [];
          const consent = store.ceremonyConsents.find(
            candidate => String(candidate.recipientId) === String(row.recipientId));
          const progress = store.ceremonyProgress.find(
            candidate => String(candidate.recipientId) === String(row.recipientId));
          return [{
            recipientId: String(row.recipientId),
            name: snapshot.name,
            email: snapshot.email,
            recipientType: String(snapshot.type),
            routingOrder: snapshot.routingOrder,
            orderIndex: snapshot.orderIndex,
            signedAt: row.acceptedAt,
            authenticationMethod: String(row.authenticationMethod),
            firstEnteredAt: progress?.firstEnteredAt ?? null,
            consentType: consent?.consentType ?? null,
            consentVersion: consent?.consentVersion ?? null,
            consentAcceptedAt: consent?.acceptedAt ?? null,
          }];
        })
        .sort((a, b) =>
          a.routingOrder - b.routingOrder || a.orderIndex - b.orderIndex
          || a.recipientId.localeCompare(b.recipientId))),
  };
}

/** Mirrors `toRenderableValue` in the real repository, including its refusals. */
function fakeRenderableValue(
  value: NewSigningFieldValue,
  representation: NewSigningRepresentation | undefined,
): RenderableValue {
  switch (value.valueKind) {
    case "text":
      if (value.textValue === null) throw new Error("A text field value has no text.");
      return { kind: "text", text: value.textValue };
    case "boolean":
      if (value.booleanValue === null) {
        throw new Error("A checkbox field value has no boolean.");
      }
      return { kind: "checkbox", checked: value.booleanValue };
    case "instant":
      if (value.instantValue === null) {
        throw new Error("A date field value has no instant.");
      }
      return { kind: "instant", at: value.instantValue };
    case "representation": {
      if (representation === undefined) {
        throw new Error("A representation value has no representation.");
      }
      if (representation.representationType === "TYPED_SIGNATURE_V1") {
        if (representation.typedText === null || representation.typedStyleIndex === null) {
          throw new Error("A typed signature has no text or no style.");
        }
        return {
          kind: "typed-signature",
          text: representation.typedText,
          styleIndex: representation.typedStyleIndex,
        };
      }
      if (
        representation.rasterBytes === null || representation.rasterMediaType === null
        || representation.rasterWidth === null || representation.rasterHeight === null
      ) {
        throw new Error("A drawn signature is missing its bytes or dimensions.");
      }
      return {
        kind: "raster-signature",
        bytes: Uint8Array.from(representation.rasterBytes),
        mediaType: representation.rasterMediaType,
        width: representation.rasterWidth,
        height: representation.rasterHeight,
      };
    }
  }
}

/** Sequential completion ids (BACKEND-38). */
export class SequentialCompletionIds
implements CompletionIdGenerator, EvidenceEventIdGenerator {
  private run = 1;
  private step = 1;
  private evidence = 1;
  nextCompletionRunId(): CompletionRunId {
    return `crn_${String(this.run++)}` as CompletionRunId;
  }
  nextCompletionStepId(): CompletionStepId {
    return `cst_${String(this.step++)}` as CompletionStepId;
  }

  /**
   * BACKEND-43. Every completion transition now appends evidence, so a harness
   * without this generator makes the append throw — and because the append is
   * deliberately INSIDE the owning transaction (§160), the throw rolls the whole
   * transition back and the use case reports a failure.
   *
   * That is the invariant working, but it is a confusing way to learn it: three
   * separate suites failed with "expected failed to be completed" before this
   * moved here. Supplying it once on the shared fake means a new completion
   * producer does not re-teach the same lesson.
   *
   * Sequential, not constant: a finalization appends four events, and a fixed
   * id would make three of them primary-key collisions.
   */
  nextEvidenceEventId(): EvidenceEventId {
    return `ev_${String(this.evidence++)}` as EvidenceEventId;
  }
}

/**
 * The in-memory signing-request store.
 *
 * Write-once, like the real one: there is no update method, because the
 * runtime role holds no UPDATE grant on the two snapshot tables. A use case
 * that tried to mutate a snapshot would not compile here either.
 */
function scopedSigningRequests(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedSigningRequestRepository {
  const owned = (signingRequestId: SigningRequestId) =>
    store.signingRequests.find(
      request => request.workspaceId === scope
        && request.signingRequestId === signingRequestId);

  return {
    createSnapshot: (snapshot: NewSigningRequestSnapshot) => {
      const { request, recipients, fields } = snapshot;
      if (request.workspaceId !== scope) {
        throw new FakeScopeMismatchError("SigningRequest", scope, request.workspaceId);
      }

      // The field FK, in memory: a field may only name a recipient of its own
      // request. Without this the remapping bug the whole command guards
      // against would pass here and fail only in PostgreSQL.
      const own = new Set(recipients.map(recipient => String(recipient.recipientId)));
      for (const field of fields) {
        if (!own.has(String(field.recipientId))) {
          throw new Error("field assigned to a recipient of another request");
        }
      }

      store.signingRequests.push(request);
      for (const recipient of recipients) {
        store.signingRequestRecipients.push(recipient);
        store.snapshotOwners.set(String(recipient.recipientId), request.signingRequestId);
      }
      for (const field of fields) {
        store.signingRequestFields.push(field);
        store.snapshotOwners.set(String(field.fieldId), request.signingRequestId);
      }
      return Promise.resolve();
    },

    find: (signingRequestId) => Promise.resolve(owned(signingRequestId) ?? null),

    markSentIfDraft: (input) => {
      const index = store.signingRequests.findIndex(
        request => request.workspaceId === scope
          && request.signingRequestId === input.signingRequestId
          // The condition, mirroring the adapter's WHERE clause.
          && request.state === "draft");
      const current = index === -1 ? undefined : store.signingRequests[index];
      if (current === undefined) return Promise.resolve(false);
      store.signingRequests[index] = {
        ...current, state: "sent", updatedAt: input.sentAt,
      };
      return Promise.resolve(true);
    },

    listRecipients: (signingRequestId) => Promise.resolve(
      store.signingRequestRecipients
        .filter(recipient =>
          owned(signingRequestId) !== undefined
          && store.snapshotOwners.get(String(recipient.recipientId)) === signingRequestId)
        .sort((a, b) =>
          a.orderIndex - b.orderIndex
          || String(a.recipientId).localeCompare(String(b.recipientId)))),

    listFields: (signingRequestId) => Promise.resolve(
      store.signingRequestFields
        .filter(field =>
          owned(signingRequestId) !== undefined
          && store.snapshotOwners.get(String(field.fieldId)) === signingRequestId)
        .sort((a, b) =>
          a.pageNumber - b.pageNumber
          || a.layer - b.layer
          || String(a.fieldId).localeCompare(String(b.fieldId)))),
  };
}

/**
 * The in-memory recipient store.
 *
 * Reproduces the two constraints that carry the rules, rather than leaving them
 * to the use case:
 *
 *   the preparation-local unique on the folded email, so the duplicate race
 *   fails here as well as in PostgreSQL;
 *
 *   the RESTRICT on deleting an assigned recipient, so a use case that forgot
 *   to check would not pass the unit suite and then fail in integration.
 */
function scopedRecipients(
  store: InMemoryStore, scope: WorkspaceId,
): ScopedRecipientRepository {
  const of = (preparationId: PreparationId) => store.recipients.filter(
    r => r.workspaceId === scope && r.preparationId === preparationId);

  const assignedCount = (preparationId: PreparationId, recipientId: RecipientId) =>
    store.preparationFields.filter(
      f => preparationOf(store, f) === preparationId && f.recipientId === recipientId,
    ).length;

  return {
    insert: (recipient: NewRecipient) => {
      if (recipient.workspaceId !== scope) {
        throw new FakeScopeMismatchError("Recipient", scope, recipient.workspaceId);
      }
      const clash = of(recipient.preparationId).some(
        r => r.emailKey === recipient.emailKey);
      if (clash) throw new Error("duplicate recipient email for preparation");

      store.recipients.push({
        recipientId: recipient.recipientId,
        workspaceId: recipient.workspaceId,
        preparationId: recipient.preparationId,
        sourceContactId: recipient.sourceContactId,
        name: recipient.name,
        email: recipient.email,
        emailKey: recipient.emailKey,
        organization: recipient.organization,
        type: recipient.type,
        isRequired: recipient.isRequired,
        orderIndex: recipient.orderIndex,
        routingOrder: recipient.routingOrder,
        createdAt: recipient.createdAt,
        updatedAt: recipient.createdAt,
      });
      return Promise.resolve();
    },

    find: (input) => Promise.resolve(
      of(input.preparationId).find(r => r.recipientId === input.recipientId) ?? null),

    list: (preparationId) => Promise.resolve(
      [...of(preparationId)].sort((a, b) =>
        a.orderIndex - b.orderIndex || a.recipientId.localeCompare(b.recipientId))),

    update: (input) => {
      const index = store.recipients.findIndex(
        r => r.workspaceId === scope
          && r.preparationId === input.preparationId
          && r.recipientId === input.recipientId);
      const current = index === -1 ? undefined : store.recipients[index];
      if (current === undefined) return Promise.resolve(false);

      const patch = input.patch;
      // The unique constraint applies to an update too. Without this, renaming
      // one recipient onto another address would pass here and violate in
      // PostgreSQL.
      if (patch.emailKey !== undefined) {
        const clash = of(input.preparationId).some(
          r => r.recipientId !== input.recipientId && r.emailKey === patch.emailKey);
        if (clash) throw new Error("duplicate recipient email for preparation");
      }

      store.recipients[index] = {
        ...current,
        // Each key applied only when present, mirroring the adapter: an absent
        // key means leave it, an explicit null on organization means clear it.
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.email === undefined ? {} : { email: patch.email }),
        ...(patch.emailKey === undefined ? {} : { emailKey: patch.emailKey }),
        ...(patch.organization === undefined ? {} : { organization: patch.organization }),
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(patch.isRequired === undefined ? {} : { isRequired: patch.isRequired }),
        ...(patch.orderIndex === undefined ? {} : { orderIndex: patch.orderIndex }),
        ...(patch.routingOrder === undefined ? {} : { routingOrder: patch.routingOrder }),
        updatedAt: input.now,
      };
      return Promise.resolve(true);
    },

    remove: (input) => {
      const index = store.recipients.findIndex(
        r => r.workspaceId === scope
          && r.preparationId === input.preparationId
          && r.recipientId === input.recipientId);
      if (index === -1) return Promise.resolve(false);
      // ON DELETE RESTRICT, in memory.
      if (assignedCount(input.preparationId, input.recipientId) > 0) {
        throw new Error("recipient still has assigned fields");
      }
      store.recipients.splice(index, 1);
      return Promise.resolve(true);
    },

    countAssignedFields: (input) => Promise.resolve(
      assignedCount(input.preparationId, input.recipientId)),
  };
}

/** Which preparation a fake field belongs to. The real row carries the column. */
function preparationOf(
  store: InMemoryStore, field: PreparationFieldRecord,
): PreparationId | undefined {
  return store.fieldOwners.get(field.fieldId);
}

function scopedEvidence(store: InMemoryStore, scope: WorkspaceId): ScopedEvidenceRepository {
  return {
    append: (event: EvidenceEventInput) => {
      // Migration 029's PARTIAL unique index, in memory.
      //
      // Without it every idempotency test in this codebase would pass
      // vacuously: producers rely on the database refusing a duplicate rather
      // than checking first, so a fake that accepts everything proves nothing
      // about retry safety. The integration suite that WOULD catch it needs a
      // live PostgreSQL and skips without one.
      //
      // Partial, exactly as in SQL — an event with no source is unconstrained,
      // because `document-viewed` may legitimately recur and no single durable
      // row makes any one of those views the fact.
      if (event.source !== undefined) {
        const duplicate = store.evidence.some(
          e => e.workspaceId === scope
            && e.eventType === event.eventType
            && e.source?.type === event.source?.type
            && e.source?.id === event.source?.id);
        if (duplicate) {
          throw new Error(
            `duplicate evidence event: ${event.eventType} from `
            + `${event.source.type}:${event.source.id}`);
        }
      }

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
  readonly scopes: string[] = [];
  /**
   * Shared across transactions, like the real table.
   *
   * A per-transaction instance would make every retry a fresh claim, and the
   * idempotency tests would pass against a fake that guarantees nothing.
   */
  readonly idempotency = new InMemoryIdempotencyRepository();

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
        uploads: scopedUploads(this.store, workspaceId),
        idempotency: this.idempotency,
        invitations: scopedInvitations(this.store, workspaceId),
        contacts: scopedContacts(this.store, workspaceId),
        documents: scopedDocuments(this.store, workspaceId),
        preparations: scopedPreparations(this.store, workspaceId),
        recipients: scopedRecipients(this.store, workspaceId),
        signingRequests: scopedSigningRequests(this.store, workspaceId),
        signingAccess: scopedSigningAccess(this.store, workspaceId),
        signingWorkflow: scopedSigningWorkflow(this.store, workspaceId),
        completion: scopedCompletion(this.store, workspaceId),
        completionReconciliation:
          completionReconciliation(this.store, workspaceId),
        completionInputs: completionInputs(this.store, workspaceId),
      });
      this.committed++;
      return result;
    } catch (error) {
      this.store.restore(snapshot);
      this.rolledBack++;
      throw error;
    }
  }

  async runForUser<T>(
    userId: UserId,
    operation: (uow: UserUnitOfWork) => Promise<T>,
  ): Promise<T> {
    this.scopes.push(userId);
    this.started++;
    try {
      const result = await operation({
        userId,
        memberships: userMemberships(this.store, userId),
      });
      this.committed++;
      return result;
    } catch (error) {
      // No snapshot restore: this scope cannot write. The real one cannot
      // either, because its policies are FOR SELECT.
      this.rolledBack++;
      throw error;
    }
  }

  async runForInvitationCredential<T>(
    tokenDigest: InvitationTokenDigest,
    operation: (uow: InvitationCredentialUnitOfWork) => Promise<T>,
  ): Promise<T> {
    this.scopes.push("invitation-credential");
    this.started++;
    const snapshot = this.store.snapshot();
    const store = this.store;
    try {
      const result = await operation({
        invitation: {
          // Resolves at most ONE invitation, by digest. The real one does it
          // through an RLS policy on a unique column; the fake mirrors the
          // outcome so a use case cannot be written against a broader read.
          find: () => {
            const id = store.invitationDigests.get(tokenDigest);
            if (id === undefined) return Promise.resolve(null);
            return Promise.resolve(
              store.invitations.find(i => i.invitationId === id) ?? null);
          },
        },
        enterWorkspace: (workspaceId, inner) => {
          this.scopes.push(workspaceId);
          return inner({
            workspaceId,
            workspaces: scopedWorkspaces(store, workspaceId),
            memberships: scopedMemberships(store, workspaceId),
            evidence: scopedEvidence(store, workspaceId),
            artifacts: scopedArtifacts(store, workspaceId),
            finalizations: scopedFinalizations(store, workspaceId),
            uploads: scopedUploads(store, workspaceId),
            idempotency: this.idempotency,
            invitations: scopedInvitations(store, workspaceId),
            contacts: scopedContacts(store, workspaceId),
            documents: scopedDocuments(store, workspaceId),
            preparations: scopedPreparations(store, workspaceId),
            recipients: scopedRecipients(store, workspaceId),
            signingRequests: scopedSigningRequests(store, workspaceId),
            signingAccess: scopedSigningAccess(store, workspaceId),
            signingWorkflow: scopedSigningWorkflow(store, workspaceId),
            completion: scopedCompletion(store, workspaceId),
            completionReconciliation:
              completionReconciliation(store, workspaceId),
            completionInputs: completionInputs(store, workspaceId),
          });
        },
      });
      this.committed++;
      return result;
    } catch (error) {
      // ONE transaction, so a failure anywhere — including inside
      // `enterWorkspace` — discards the whole acceptance ceremony.
      this.store.restore(snapshot);
      this.rolledBack++;
      throw error;
    }
  }

  /**
   * The signing-credential scope.
   *
   * Mirrors the adapter: the digest resolves at most one grant, and the tenant
   * transition happens on the same logical transaction. The fake assembles
   * `ResolvedSigningAccess` from the store the same way the SQL join does, so a
   * use case that read a field the real query does not select would fail here.
   */
  async runForSigningCredential<T>(
    credentialDigest: SigningAccessDigest,
    operation: (uow: SigningCredentialUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const store = this.store;
    this.started++;
    const snapshot = store.snapshot();
    try {
      return await operation({
      access: {
        findByCredentialDigest: (digest) => {
          const grant = store.signingAccessGrants.find(
            candidate => String(candidate.credentialDigest) === String(digest));
          if (grant === undefined) return Promise.resolve(null);

          const request = store.signingRequests.find(
            candidate =>
              candidate.signingRequestId === grant.signingRequestId);
          const recipient = store.signingRequestRecipients.find(
            candidate => candidate.recipientId === grant.recipientId);
          // The real query INNER JOINs both, so a missing row is no row.
          if (request === undefined || recipient === undefined) {
            return Promise.resolve(null);
          }
          const activation = store.activations.find(
            candidate =>
              candidate.signingRequestId === String(grant.signingRequestId)
              && candidate.recipientId === grant.recipientId);

          return Promise.resolve({
            grantId: grant.grantId,
            workspaceId: grant.workspaceId,
            signingRequestId: grant.signingRequestId,
            recipientId: grant.recipientId,
            grantExpiresAt: grant.expiresAt,
            grantRevokedAt: null,
            requestState: request.state,
            documentTitle: request.documentTitle,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
            activationState: activation?.state ?? null,
          } satisfies ResolvedSigningAccess);
        },
      },
      enterWorkspace: <R,>(
        workspaceId: WorkspaceId,
        inner: (uow: RecipientWorkspaceUnitOfWork) => Promise<R>,
      ) => inner({
        workspaceId,
        recipientSessions: {
          insert: (session: NewRecipientSigningSession) => {
            if (session.workspaceId !== workspaceId) {
              throw new FakeScopeMismatchError(
                "RecipientSigningSession", workspaceId, session.workspaceId);
            }
            store.recipientSessions.push(session);
            return Promise.resolve();
          },
          revoke: () => Promise.resolve(false),
        },
      }),
      });
    } catch (error) {
      store.restore(snapshot);
      this.rolledBack++;
      throw error;
    }
  }

  async runForRecipientSession<T>(
    sessionDigest: RecipientSessionDigest,
    operation: (uow: RecipientSessionUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const store = this.store;
    this.started++;
    return operation({
      session: {
        findByTokenDigest: (digest) => {
          const found = store.recipientSessions.find(
            candidate => String(candidate.tokenDigest) === String(digest));
          if (found === undefined) return Promise.resolve(null);
          return Promise.resolve({
            signingSessionId: found.signingSessionId,
            workspaceId: found.workspaceId,
            signingRequestId: found.signingRequestId,
            recipientId: found.recipientId,
            sourceGrantId: found.sourceGrantId,
            csrfTokenDigest: found.csrfTokenDigest,
            authenticationMethod: found.authenticationMethod,
            authenticatedAt: found.authenticatedAt,
            expiresAt: found.expiresAt,
            revokedAt: null,
          } satisfies ResolvedRecipientSession);
        },
      },
      enterWorkspace: <R,>(
        scope: {
          readonly workspaceId: WorkspaceId;
          readonly signingRequestId: SigningRequestId;
          readonly recipientId: SigningRequestRecipientId;
        },
        inner: (uow: RecipientCeremonyUnitOfWork) => Promise<R>,
      ) => {
        // The fake filters exactly as the real repository does. It cannot
        // prove the RLS policies - only integration can - but it CAN prove the
        // repository never returns another recipient's rows, which is the
        // property the use-case tests are about.
        const mine = <T extends {
          readonly workspaceId: string;
          readonly signingRequestId: string;
          readonly recipientId: string;
        }>(row: T): boolean =>
          row.workspaceId === scope.workspaceId
          && row.signingRequestId === scope.signingRequestId
          && row.recipientId === scope.recipientId;

        return inner({
          workspaceId: scope.workspaceId,
          signingRequestId: scope.signingRequestId,
          recipientId: scope.recipientId,
          // BACKEND-43. The SAME scoped repository the workspace realm gets,
          // including its in-memory partial unique index — so a recipient-realm
          // idempotency test is exercising the same rule PostgreSQL will.
          evidence: scopedEvidence(store, scope.workspaceId),
          ceremony: {
            getRequest: () => Promise.resolve(
              store.signingRequests.find(
                r => r.workspaceId === scope.workspaceId
                  && r.signingRequestId === scope.signingRequestId) ?? null),
            getRecipient: () => Promise.resolve(
              store.signingRequestRecipients.find(
                r => r.recipientId === scope.recipientId
                  && store.snapshotOwners.get(String(r.recipientId))
                       === scope.signingRequestId) ?? null),
            getActivationState: () => Promise.resolve(
              store.activations.find(
                a => a.recipientId === scope.recipientId
                  && a.signingRequestId === scope.signingRequestId)?.state ?? null),
            listAssignedFields: () => Promise.resolve(
              store.signingRequestFields.filter(
                f => f.recipientId === scope.recipientId
                  && store.snapshotOwners.get(String(f.fieldId))
                       === scope.signingRequestId)),
            getSourceArtifact: () => {
              const request = store.signingRequests.find(
                r => r.signingRequestId === scope.signingRequestId);
              if (request === undefined) return Promise.resolve(null);
              // Joined FROM the request, exactly as the real query is. A test
              // that adds a newer artifact to the document must not change it.
              const artifact = store.artifacts.find(
                a => a.artifactId === request.sourceArtifactId
                  && a.workspaceId === scope.workspaceId);
              if (artifact === undefined) return Promise.resolve(null);
              return Promise.resolve({
                artifactId: artifact.artifactId,
                mediaType: artifact.mediaType,
                sizeBytes: artifact.sizeBytes,
                digest: String(artifact.digest),
                pageCount: artifact.pageCount ?? null,
                storageReference: artifact.storageReference,
              });
            },
            getProgress: () => {
              const row = store.ceremonyProgress.find(mine);
              return Promise.resolve(
                row === undefined ? null : { firstEnteredAt: row.firstEnteredAt });
            },
            listConsents: () => Promise.resolve(
              store.ceremonyConsents.filter(mine).map(row => ({
                consentType: row.consentType,
                consentVersion: row.consentVersion,
                acceptedAt: row.acceptedAt,
              }))),
            recordFirstEntry: (input: {
              readonly firstEnteredAt: number; readonly createdAt: number;
            }) => {
              // `on conflict do nothing`: the first write stands.
              if (store.ceremonyProgress.some(mine)) return Promise.resolve(false);
              store.ceremonyProgress.push({
                workspaceId: scope.workspaceId,
                signingRequestId: scope.signingRequestId,
                recipientId: scope.recipientId,
                firstEnteredAt: input.firstEnteredAt,
              });
              return Promise.resolve(true);
            },
            insertConsent: (consent: NewCeremonyConsent) => {
              // The real unique constraint, emulated.
              const exists = store.ceremonyConsents.some(
                row => mine(row)
                  && row.consentType === consent.consentType
                  && row.consentVersion === consent.consentVersion);
              if (exists) return Promise.resolve(false);
              store.ceremonyConsents.push({
                workspaceId: scope.workspaceId,
                signingRequestId: scope.signingRequestId,
                recipientId: scope.recipientId,
                consentType: consent.consentType,
                consentVersion: consent.consentVersion,
                acceptedAt: consent.acceptedAt,
                signingSessionId: String(consent.signingSessionId),
                authenticationMethod: consent.authenticationMethod,
              });
              return Promise.resolve(true);
            },
          },
          submissions: {
            findAccepted: () => {
              const row = store.submissions.find(mine);
              return Promise.resolve(row === undefined ? null : {
                submissionId: row.submissionId as RecipientSubmissionId,
                acceptedAt: row.acceptedAt,
                acceptedFieldCount: row.valueCount,
              });
            },
            create: (submission: NewRecipientSubmission) => {
              // The real unique constraint: ONE accepted submission per
              // recipient. A second is a violation, never an overwrite.
              if (store.submissions.some(mine)) {
                return Promise.reject(new Error(
                  "recipient_submissions_one_per_recipient"));
              }
              store.submissions.push({
                submissionId: String(submission.submissionId),
                workspaceId: scope.workspaceId,
                signingRequestId: scope.signingRequestId,
                recipientId: scope.recipientId,
                acceptedAt: submission.acceptedAt,
                authenticationMethod: String(submission.authenticationMethod),
                valueCount: submission.values.length,
                representations: submission.representations,
                values: submission.values,
              });
              return Promise.resolve();
            },
          },
          // BACKEND-37. The recipient's own state, on the same fake
          // transaction as their submission.
          workflow: recipientWorkflow(this.store, scope),
          idempotency: this.idempotency,
        });
      },
    });
  }

  async runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
    this.scopes.push("global");
    this.started++;
    try {
      const result = await operation({
        scope: "global",
        signingWorkflowReconciliation: workflowReconciliation(this.store),
      });
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

  runForSigningCredential<T>(
    _credentialDigest: SigningAccessDigest,
    _operation: (uow: SigningCredentialUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.fail();
  }

  runForRecipientSession<T>(
    _sessionDigest: RecipientSessionDigest,
    _operation: (uow: RecipientSessionUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.fail();
  }

  runForUser<T>(
    _userId: UserId,
    _operation: (uow: UserUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.fail();
  }

  runForInvitationCredential<T>(
    _tokenDigest: InvitationTokenDigest,
    _operation: (uow: InvitationCredentialUnitOfWork) => Promise<T>,
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

/**
 * In-memory upload records, tenant-scoped like the real repository.
 *
 * Mirrors the DATABASE's constraints rather than being permissive: only a row
 * still in flight may be completed, and an accepted row must name an artifact.
 * A fake that allowed either would let a test pass against behaviour production
 * rejects.
 */
function scopedUploads(
  store: InMemoryStore, workspaceId: WorkspaceId,
): ScopedUploadRepository {
  const rows = store.uploads;
  return {
    insert(record: UploadRecord) {
      rows.set(record.uploadId, { ...record, workspaceId });
      return Promise.resolve();
    },
    find(uploadId: UploadRecord["uploadId"]) {
      const row = rows.get(uploadId);
      return Promise.resolve(
        row === undefined || row.workspaceId !== workspaceId ? null : row);
    },
    complete(input: Parameters<ScopedUploadRepository["complete"]>[0]) {
      const row = rows.get(input.uploadId);
      if (row === undefined || row.workspaceId !== workspaceId) return Promise.resolve();
      if (row.status !== "quarantined") return Promise.resolve();
      rows.set(input.uploadId, {
        ...row,
        status: input.status,
        detectedMediaType: input.detectedMediaType ?? row.detectedMediaType,
        digest: input.digest ?? row.digest,
        rejectionReason: input.rejectionReason ?? null,
        acceptedArtifactId: input.acceptedArtifactId ?? null,
        scanOutcome: input.scanOutcome ?? row.scanOutcome,
        scannedAt: input.scannedAt ?? row.scannedAt,
        completedAt: input.completedAt,
      });
      return Promise.resolve();
    },
  };
}
