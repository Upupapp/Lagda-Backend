// Contact connections (091): find someone by their exact email, ask to add
// them, and on their acceptance give each side a personal contact for the
// other.
//
// ── What a lookup reveals, and to whom ────────────────────────────────────
//
// Only an EXACT, verified address finds anyone — no partial matches, no
// suggestions — and only an account that has not turned discovery off. "Not
// found" is one answer whether the account does not exist, is unverified, or
// is hidden, so a lookup cannot tell them apart. What comes back is a name, a
// title, an organisation and the relationship: never the account's address
// (the caller typed it) and never anything else about the account. The route
// rate-limits lookups per account.
//
// ── Declining is quiet ────────────────────────────────────────────────────
//
// A declined request stays "Requested" to its sender for QUIET_WINDOW_MS, and
// a new request in that window is recorded as already declined, without a
// notice. Nobody is ever told they were turned down.
//
// ── Two workspaces, two transactions ──────────────────────────────────────
//
// The requester's contact lives in the workspace they sent from; the
// recipient's in the one they chose when accepting. Each is written inside its
// own workspace's tenant transaction — there is no transaction that may write
// both. Acceptance is claimed first (pending → accepted on the account-owned
// row), then each contact is written, then both ids are recorded. Accepting
// again completes any side a failure left missing, so the operation converges.
//
// ── Why accepting needs only membership ───────────────────────────────────
//
// The contact written is PERSONAL: only its owner sees it, it names someone
// who agreed to it, and it grants nothing to anybody. A New Comer without
// `contact.create` may still accept a request into their own address book —
// refusing would leave a request nobody in that workspace could ever answer.
// SENDING needs `contact.create` in the workspace sent from, as any contact does.

import type { UserId, WorkspaceId, ContactId } from "@lagda/contracts";
import {
  validateContactEmail, CONTACT_ORGANIZATION_MAX_LENGTH, CONTACT_TITLE_MAX_LENGTH,
  type ContactEmailKey,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork, ContactIdGenerator, ContactRecord,
} from "../common/ports/index.js";
import type {
  ContactConnectionRepository, ContactConnectionRecord, ContactConnectionIdGenerator,
  PeopleDirectory, DirectoryPerson,
} from "../common/ports/contact-connections.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  requireWorkspaceAccess, resolveWorkspaceAccess, assertCapability,
} from "../workspaces/workspace-access.js";
import { normalizeEmail } from "../auth/email-identity.js";

/** How long a declined request keeps looking like "Requested" to its sender. */
export const QUIET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME = 200;
const UNKNOWN_PERSON = "A LAGDA user";

export interface ContactConnectionDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: ContactConnectionIdGenerator & ContactIdGenerator;
  readonly connections: ContactConnectionRepository;
  readonly people: PeopleDirectory;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
}

/** 409 with a reason a client can act on. */
export class ContactConnectionConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code: string;
  readonly details: readonly { field: string; code: string; message: string }[];

  constructor(reason: "already_in_contacts" | "already_requested" | "request_waiting_for_you" | "not_pending", message: string) {
    super(message);
    this.code = `contact_connection_${reason}`;
    this.details = [{ field: "email", code: reason, message }];
  }
}

function bounded(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function normalized(email: string): string {
  const result = normalizeEmail(email);
  if (result.outcome !== "ok") throw new ApplicationValidationError("Enter a valid email address.", ["email"]);
  return result.normalized;
}

function emailKeyOf(email: string): ContactEmailKey | null {
  const result = validateContactEmail(email);
  return result.ok ? result.key : null;
}

const visibleTo = (record: ContactRecord, userId: string) =>
  (record.scope ?? "workspace") === "workspace" || record.ownerUserId === userId;

/** An ACTIVE contact this person can see, holding this address, in the transaction's workspace. */
async function visibleContactWithEmail(uow: WorkspaceUnitOfWork, email: string, userId: string): Promise<ContactRecord | null> {
  const key = emailKeyOf(email);
  if (key === null) return null;
  const candidates = await uow.contacts.findDuplicateCandidates({ emailKey: key, excludeContactId: null });
  return candidates.find(c => visibleTo(c, userId)) ?? null;
}

function notifier(uow: WorkspaceUnitOfWork, deps: ContactConnectionDependencies) {
  return createNotificationIntent({
    notifications: uow.notifications,
    templates: deps.templates,
    ids: deps.notificationIds,
    clock: deps.clock,
  });
}

// ── Views ─────────────────────────────────────────────────────────────────

export interface PersonView {
  readonly userId: UserId;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly organization: string | null;
}

const personView = (p: DirectoryPerson): PersonView => ({
  userId: p.userId, displayName: p.displayName, jobTitle: p.jobTitle, organization: p.organization,
});

export type Relationship = "self" | "none" | "requested" | "incoming";

export interface LookupResult {
  readonly person: (PersonView & { readonly relationship: Relationship; readonly connectionId: string | null }) | null;
  /** An active contact the caller can already see with this address, in this workspace. */
  readonly existingContactId: ContactId | null;
}

export interface ConnectionView {
  readonly connectionId: string;
  readonly person: PersonView;
  /** Received: the workspace the request came from. Sent: the one it was sent from. */
  readonly workspaceName: string;
  /** Always "pending" to its sender while it is quietly declined. */
  readonly status: "pending";
  readonly createdAt: number;
}

/** A request between these two whose sender still sees "Requested". */
function liveFrom(rows: readonly ContactConnectionRecord[], requester: string, now: number): ContactConnectionRecord | null {
  return rows.find(r => r.requesterUserId === requester && (
    r.status === "pending"
    || (r.status === "declined" && r.declinedAt !== null && now - r.declinedAt < QUIET_WINDOW_MS)
  )) ?? null;
}

// ── Lookup ────────────────────────────────────────────────────────────────

export async function lookupPerson(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, input: { readonly email: string },
  deps: ContactConnectionDependencies,
): Promise<LookupResult> {
  const email = normalized(input.email);
  await requireWorkspaceAccess(actor.userId, workspaceId, deps);
  const existing = await deps.transactions.runForWorkspace(workspaceId,
    uow => visibleContactWithEmail(uow, email, actor.userId));
  const existingContactId = existing?.contactId ?? null;

  const found = await deps.people.findVerifiedByEmail(email);
  if (found === null) return { person: null, existingContactId };
  if (found.userId === actor.userId) {
    return { person: { ...personView(found), relationship: "self", connectionId: null }, existingContactId };
  }
  if (!(await deps.people.isDiscoverable(found.userId))) return { person: null, existingContactId };

  const now = deps.clock.now();
  const rows = await deps.connections.listBetween(actor.userId, found.userId);
  const mine = liveFrom(rows, actor.userId, now);
  const theirs = rows.find(r => r.requesterUserId === found.userId && r.status === "pending") ?? null;
  const relationship: Relationship = mine !== null ? "requested" : theirs !== null ? "incoming" : "none";
  return {
    person: { ...personView(found), relationship, connectionId: (mine ?? theirs)?.connectionId ?? null },
    existingContactId,
  };
}

// ── Send ──────────────────────────────────────────────────────────────────

export async function sendConnectionRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, input: { readonly email: string },
  deps: ContactConnectionDependencies,
): Promise<ConnectionView> {
  const email = normalized(input.email);
  const access = await requireWorkspaceAccess(actor.userId, workspaceId, deps);
  assertCapability(access, "contact.create");

  const person = await deps.people.findVerifiedByEmail(email);
  // One answer for absent, unverified, hidden, and yourself.
  if (person === null || person.userId === actor.userId || !(await deps.people.isDiscoverable(person.userId))) {
    throw new ResourceNotFoundError("Person");
  }

  const { workspaceName, existing } = await deps.transactions.runForWorkspace(workspaceId, async uow => ({
    workspaceName: (await uow.workspaces.find())?.name ?? "a LAGDA workspace",
    existing: await visibleContactWithEmail(uow, person.email, actor.userId),
  }));
  if (existing !== null) {
    throw new ContactConnectionConflictError("already_in_contacts", `${person.displayName} is already in your contacts.`);
  }

  const now = deps.clock.now();
  const rows = await deps.connections.listBetween(actor.userId, person.userId);
  const view = (connectionId: string, createdAt: number): ConnectionView => ({
    connectionId, person: personView(person), workspaceName, status: "pending", createdAt,
  });

  const mine = liveFrom(rows, actor.userId, now);
  if (mine !== null && mine.status === "pending") {
    throw new ContactConnectionConflictError("already_requested", `You already asked ${person.displayName}.`);
  }
  if (rows.some(r => r.requesterUserId === person.userId && r.status === "pending")) {
    throw new ContactConnectionConflictError("request_waiting_for_you",
      `${person.displayName} already asked to add you. Accept their request instead.`);
  }

  // Inside a quiet window: recorded as already declined, and nobody is told.
  const quiet = rows.find(r => r.requesterUserId === actor.userId && r.declinedAt !== null
    && now - r.declinedAt < QUIET_WINDOW_MS) ?? null;
  const connectionId = deps.ids.nextConnectionId();
  await deps.connections.insert({
    connectionId,
    requesterUserId: actor.userId,
    requesterWorkspaceId: workspaceId,
    requesterWorkspaceName: bounded(workspaceName, MAX_NAME) ?? "a LAGDA workspace",
    recipientUserId: person.userId,
    status: quiet === null ? "pending" : "declined",
    declinedAt: quiet?.declinedAt ?? null,
    createdAt: now,
  });
  if (quiet !== null) return view(connectionId, now);

  await deps.transactions.runForWorkspace(workspaceId, async uow => {
    const requesterName = await uow.actorProfiles.displayNameOf(actor.userId);
    await notifier(uow, deps)({
      notificationType: "CONTACT_CONNECTION_REQUESTED",
      sourceId: connectionId,
      scope: { kind: "WORKSPACE", workspaceId },
      audience: { kind: "USER", userId: person.userId },
      // Never sent: the policy suppresses the email as IN_APP_ONLY.
      destination: person.email,
      templateInput: {
        recipientName: bounded(person.displayName, MAX_NAME) ?? "there",
        requesterDisplayName: bounded(requesterName, MAX_NAME) ?? UNKNOWN_PERSON,
        workspaceName: bounded(workspaceName, MAX_NAME) ?? "a LAGDA workspace",
        connectionId,
      },
    }, uow);
  });
  return view(connectionId, now);
}

// ── Lists ─────────────────────────────────────────────────────────────────

export async function listConnections(
  actor: AuthenticatedActor, deps: ContactConnectionDependencies,
): Promise<{ readonly received: readonly ConnectionView[]; readonly sent: readonly ConnectionView[] }> {
  const now = deps.clock.now();
  const [received, sentRows] = await Promise.all([
    deps.connections.listReceived(actor.userId),
    deps.connections.listSent(actor.userId),
  ]);
  const sent = sentRows.filter(r => r.status === "pending"
    || (r.status === "declined" && r.declinedAt !== null && now - r.declinedAt < QUIET_WINDOW_MS));
  const people = await deps.people.findManyById([
    ...received.map(r => r.requesterUserId), ...sent.map(r => r.recipientUserId),
  ]);
  const toView = (r: ContactConnectionRecord, other: UserId): ConnectionView | null => {
    const person = people.get(other);
    return person === undefined ? null : {
      connectionId: r.connectionId, person: personView(person),
      workspaceName: r.requesterWorkspaceName, status: "pending", createdAt: r.createdAt,
    };
  };
  return {
    received: received.map(r => toView(r, r.requesterUserId)).filter((v): v is ConnectionView => v !== null),
    sent: sent.map(r => toView(r, r.recipientUserId)).filter((v): v is ConnectionView => v !== null),
  };
}

// ── Accept ────────────────────────────────────────────────────────────────

/** The existing contact for this person, or a new personal one for its owner. */
async function contactFor(
  uow: WorkspaceUnitOfWork, deps: ContactConnectionDependencies, workspaceId: WorkspaceId,
  owner: UserId, person: DirectoryPerson, fallbackOrganization: string | null,
): Promise<ContactId | null> {
  const existing = await visibleContactWithEmail(uow, person.email, owner);
  if (existing !== null) return existing.contactId;
  const key = emailKeyOf(person.email);
  if (key === null) return null;
  const contactId = deps.ids.nextContactId();
  await uow.contacts.insert({
    contactId,
    workspaceId,
    name: bounded(person.displayName, MAX_NAME) ?? person.email,
    email: person.email,
    emailKey: key,
    phone: null,
    organization: bounded(person.organization ?? fallbackOrganization, CONTACT_ORGANIZATION_MAX_LENGTH),
    title: bounded(person.jobTitle, CONTACT_TITLE_MAX_LENGTH),
    createdAt: deps.clock.now(),
    scope: "personal",
    ownerUserId: owner,
    note: null,
    tagIds: [],
  });
  return contactId;
}

export async function acceptConnectionRequest(
  actor: AuthenticatedActor, connectionId: string, input: { readonly workspaceId: WorkspaceId },
  deps: ContactConnectionDependencies,
): Promise<{ readonly contactId: ContactId | null; readonly workspaceId: WorkspaceId }> {
  let row = await deps.connections.findForParticipant(connectionId, actor.userId);
  if (row === null || row.recipientUserId !== actor.userId) throw new ResourceNotFoundError("Contact request");
  // Accepting again only completes an acceptance a failure left unfinished.
  if (row.status === "accepted") {
    if (row.recipientContactId !== null && row.recipientWorkspaceId !== null) {
      return { contactId: row.recipientContactId, workspaceId: row.recipientWorkspaceId };
    }
  } else if (row.status !== "pending") {
    throw new ContactConnectionConflictError("not_pending", "This request is no longer waiting for an answer.");
  }

  const workspaceId = row.status === "accepted" && row.recipientWorkspaceId !== null ? row.recipientWorkspaceId : input.workspaceId;
  await requireWorkspaceAccess(actor.userId, workspaceId, deps);
  const now = deps.clock.now();
  if (row.status === "pending") {
    const claimed = await deps.connections.markAccepted({
      connectionId, recipientUserId: actor.userId, recipientWorkspaceId: workspaceId, at: now,
    });
    if (!claimed) throw new ContactConnectionConflictError("not_pending", "This request is no longer waiting for an answer.");
    row = { ...row, status: "accepted", recipientWorkspaceId: workspaceId, acceptedAt: now };
  }

  const [requester, me] = await Promise.all([
    deps.people.findById(row.requesterUserId), deps.people.findById(actor.userId),
  ]);
  if (requester === null || me === null) throw new ResourceNotFoundError("Contact request");

  const recipientContactId = row.recipientContactId ?? await deps.transactions.runForWorkspace(workspaceId,
    uow => contactFor(uow, deps, workspaceId, actor.userId, requester, row.requesterWorkspaceName));

  // The requester's side, while they are still a member where they sent from.
  let requesterContactId = row.requesterContactId;
  const requesterWorkspace = row.requesterWorkspaceId;
  if (requesterContactId === null && await resolveWorkspaceAccess(row.requesterUserId, requesterWorkspace, deps) !== null) {
    const requesterUserId = row.requesterUserId;
    requesterContactId = await deps.transactions.runForWorkspace(requesterWorkspace, async uow => {
      const id = await contactFor(uow, deps, requesterWorkspace, requesterUserId, me, null);
      await notifier(uow, deps)({
        notificationType: "CONTACT_CONNECTION_ACCEPTED",
        sourceId: connectionId,
        scope: { kind: "WORKSPACE", workspaceId: requesterWorkspace },
        audience: { kind: "USER", userId: requesterUserId },
        destination: requester.email,
        templateInput: {
          recipientName: bounded(requester.displayName, MAX_NAME) ?? "there",
          responderDisplayName: bounded(me.displayName, MAX_NAME) ?? UNKNOWN_PERSON,
          connectionId,
          ...(id === null ? {} : { contactId: id }),
        },
      }, uow);
      return id;
    });
  }

  await deps.connections.setContacts({ connectionId, requesterContactId, recipientContactId, at: deps.clock.now() });
  return { contactId: recipientContactId, workspaceId };
}

// ── Decline, cancel ───────────────────────────────────────────────────────

export async function declineConnectionRequest(
  actor: AuthenticatedActor, connectionId: string, deps: ContactConnectionDependencies,
): Promise<void> {
  const ok = await deps.connections.markDeclined({ connectionId, recipientUserId: actor.userId, at: deps.clock.now() });
  if (!ok) throw new ResourceNotFoundError("Contact request");
}

export async function cancelConnectionRequest(
  actor: AuthenticatedActor, connectionId: string, deps: ContactConnectionDependencies,
): Promise<void> {
  const ok = await deps.connections.markCancelled({ connectionId, requesterUserId: actor.userId, at: deps.clock.now() });
  if (!ok) throw new ResourceNotFoundError("Contact request");
}

// ── Discovery ─────────────────────────────────────────────────────────────

export async function getDiscovery(actor: AuthenticatedActor, deps: ContactConnectionDependencies): Promise<{ discoverableByEmail: boolean }> {
  return { discoverableByEmail: await deps.people.isDiscoverable(actor.userId) };
}

export async function setDiscovery(
  actor: AuthenticatedActor, input: { readonly discoverableByEmail: boolean }, deps: ContactConnectionDependencies,
): Promise<{ discoverableByEmail: boolean }> {
  await deps.people.setDiscoverable(actor.userId, input.discoverableByEmail, deps.clock.now());
  return { discoverableByEmail: input.discoverableByEmail };
}

// ── The account behind a contact ──────────────────────────────────────────

export interface ContactAccount {
  readonly userId: UserId;
  readonly displayName: string;
  readonly jobTitle: string | null;
  /** Through an accepted request, rather than only a shared workspace. */
  readonly connected: boolean;
  /**
   * The brand colour (`#RRGGBB`) of the workspace this person belongs to —
   * the one they took part in the request from, or this workspace for a
   * member — for their banner. Null means the LAGDA default.
   */
  readonly brandColor: string | null;
}

/**
 * For contacts the caller has ALREADY been allowed to read: the account each
 * stands for — through an accepted request that recorded it, or else the
 * current workspace member holding its address — with the account's live
 * name and title. Contacts with neither are absent.
 */
export async function resolveContactAccounts(
  workspaceId: WorkspaceId,
  contacts: readonly { readonly contactId: string; readonly workspaceMember: { readonly userId: string } | null }[],
  deps: Pick<ContactConnectionDependencies, "connections" | "people" | "transactions">,
): Promise<ReadonlyMap<string, ContactAccount>> {
  const out = new Map<string, ContactAccount>();
  if (contacts.length === 0) return out;
  const linked = await deps.connections.accountsForContacts(workspaceId, contacts.map(c => c.contactId));
  const userIdOf = new Map<string, { userId: UserId; connected: boolean; brandWorkspace: WorkspaceId | null }>();
  for (const c of contacts) {
    const viaConnection = linked.get(c.contactId);
    if (viaConnection !== undefined) {
      userIdOf.set(c.contactId, { userId: viaConnection.userId, connected: true, brandWorkspace: viaConnection.workspaceId });
    } else if (c.workspaceMember !== null) {
      userIdOf.set(c.contactId, { userId: c.workspaceMember.userId as UserId, connected: false, brandWorkspace: workspaceId });
    }
  }
  const people = await deps.people.findManyById([...new Set([...userIdOf.values()].map(v => v.userId))]);
  // One branding read per workspace involved. Only the colour leaves, and only
  // for accounts behind contacts the caller was already allowed to read.
  const colours = new Map<string, string | null>();
  for (const ws of new Set([...userIdOf.values()].map(v => v.brandWorkspace).filter((w): w is WorkspaceId => w !== null))) {
    try {
      colours.set(ws, await deps.transactions.runForWorkspace(ws, async uow => (await uow.branding.find())?.primaryColor ?? null));
    } catch {
      colours.set(ws, null);
    }
  }
  for (const [contactId, { userId, connected, brandWorkspace }] of userIdOf) {
    const person = people.get(userId);
    if (person !== undefined) {
      out.set(contactId, {
        userId, displayName: person.displayName, jobTitle: person.jobTitle, connected,
        brandColor: brandWorkspace === null ? null : colours.get(brandWorkspace) ?? null,
      });
    }
  }
  return out;
}

/** Whether `viewer` may see `target`'s photo outside a contact: themselves, a findable account, or anyone they have a request with. */
export async function canSeePhoto(viewer: UserId, target: UserId, deps: Pick<ContactConnectionDependencies, "connections" | "people">): Promise<boolean> {
  if (viewer === target) return true;
  if (await deps.people.isDiscoverable(target)) return true;
  return (await deps.connections.listBetween(viewer, target)).length > 0;
}
