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
import type { UploadRecord, ScopedUploadRepository } from "../common/ports/upload.js";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork, GlobalUnitOfWork, UserUnitOfWork,
  ScopedWorkspaceRepository, ScopedMembershipRepository,
  UserMembershipQueryRepository, UserWorkspaceMembershipRecord,
  WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRecord, WorkspaceMembershipRecord,
  ScopedEvidenceRepository, ScopedArtifactRepository, ScopedFinalizationRepository,
  EvidenceEventInput, EvidenceEventRecord, ArtifactRecord, ArtifactId,
  FinalizationInput, SealRecord,
} from "../common/ports/index.js";
import { InMemoryIdempotencyRepository } from "./idempotency-fake.js";
import type {
  ScopedInvitationRepository, InvitationCredentialUnitOfWork,
  InvitationTokenDigest, WorkspaceInvitationRecord, NewWorkspaceInvitation,
} from "../common/ports/invitations.js";
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
  ScopedSigningAccessRepository, NewSigningAccessGrant, NewDeliveryIntent,
  RecipientActivationRecord, SigningAccessGrantId, DeliveryIntentId,
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
export class SequentialSigningAccessIds implements SigningAccessIdGenerator {
  private grant = 1;
  private intent = 1;
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
export class SequentialSigningRequestIds implements SigningRequestIdGenerator {
  private request = 1;
  private recipient = 1;
  private field = 1;
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
  readonly activations: (RecipientActivationRecord & { signingRequestId: string })[];
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
  activations: (RecipientActivationRecord & { signingRequestId: string })[] = [];
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
      activations: [...this.activations],
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
    this.activations = [...snapshot.activations];
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
          ...activation, signingRequestId: String(input.signingRequestId),
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
