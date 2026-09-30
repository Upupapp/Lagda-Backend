// Contact connections (091), with fakes: exact lookup and its one "not found",
// sending (capability, duplicates, both directions), the quiet decline and
// its window, accepting into a chosen workspace with a personal contact on
// each side, the in-app notices, and cancelling.

import { describe, it, expect, beforeEach } from "vitest";
import type { ContactId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  lookupPerson, sendConnectionRequest, listConnections, acceptConnectionRequest,
  declineConnectionRequest, cancelConnectionRequest, resolveContactAccounts, canSeePhoto,
  ContactConnectionConflictError, QUIET_WINDOW_MS,
  type ContactConnectionDependencies,
} from "./contact-connections.js";
import type {
  ContactConnectionRecord, ContactConnectionRepository, PeopleDirectory, DirectoryPerson,
} from "../common/ports/contact-connections.js";
import type { ContactRecord } from "../common/ports/contacts.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import { FakeTransactionManager, InMemoryStore } from "../test-support/fakes.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";

const AT = Date.parse("2026-09-30T09:00:00.000Z");
const WS_A = "ws_a" as WorkspaceId;   // Ana's
const WS_B = "ws_b" as WorkspaceId;   // Ben's
const WS_B2 = "ws_b2" as WorkspaceId; // Ben's second

const ANA = "usr_ana" as UserId;
const BEN = "usr_ben" as UserId;
const HIDDEN = "usr_hidden" as UserId;
const NEWCOMER = "usr_newcomer" as UserId; // member role in WS_A: no contact.create

const actor = (userId: UserId): AuthenticatedActor => ({ actorType: "user", userId, sessionId: "ses_x" as SessionId });

class FakeConnections implements ContactConnectionRepository {
  rows: ContactConnectionRecord[] = [];
  insert(c: Parameters<ContactConnectionRepository["insert"]>[0]) {
    this.rows.push({
      ...c, recipientWorkspaceId: null, requesterContactId: null, recipientContactId: null,
      updatedAt: c.createdAt, acceptedAt: null, cancelledAt: null,
    });
    return Promise.resolve();
  }
  findForParticipant(id: string, userId: UserId) {
    return Promise.resolve(this.rows.find(r => r.connectionId === id
      && (r.requesterUserId === userId || r.recipientUserId === userId)) ?? null);
  }
  listBetween(a: UserId, b: UserId) {
    return Promise.resolve(this.rows.filter(r => (r.requesterUserId === a && r.recipientUserId === b)
      || (r.requesterUserId === b && r.recipientUserId === a)).reverse());
  }
  listReceived(u: UserId) { return Promise.resolve(this.rows.filter(r => r.recipientUserId === u && r.status === "pending")); }
  listSent(u: UserId) { return Promise.resolve(this.rows.filter(r => r.requesterUserId === u && (r.status === "pending" || r.status === "declined"))); }
  private patch(id: string, ok: (r: ContactConnectionRecord) => boolean, change: Partial<ContactConnectionRecord>) {
    const i = this.rows.findIndex(r => r.connectionId === id && ok(r));
    if (i < 0) return false;
    this.rows[i] = { ...this.rows[i]!, ...change };
    return true;
  }
  markAccepted(x: { connectionId: string; recipientUserId: UserId; recipientWorkspaceId: WorkspaceId; at: number }) {
    return Promise.resolve(this.patch(x.connectionId, r => r.recipientUserId === x.recipientUserId && r.status === "pending",
      { status: "accepted", recipientWorkspaceId: x.recipientWorkspaceId, acceptedAt: x.at }));
  }
  setContacts(x: { connectionId: string; requesterContactId: ContactId | null; recipientContactId: ContactId | null }) {
    this.patch(x.connectionId, r => r.status === "accepted",
      { requesterContactId: x.requesterContactId, recipientContactId: x.recipientContactId });
    return Promise.resolve();
  }
  markDeclined(x: { connectionId: string; recipientUserId: UserId; at: number }) {
    return Promise.resolve(this.patch(x.connectionId, r => r.recipientUserId === x.recipientUserId && r.status === "pending",
      { status: "declined", declinedAt: x.at }));
  }
  markCancelled(x: { connectionId: string; requesterUserId: UserId; at: number }) {
    return Promise.resolve(this.patch(x.connectionId, r => r.requesterUserId === x.requesterUserId
      && (r.status === "pending" || r.status === "declined"), { status: "cancelled", cancelledAt: x.at }));
  }
  accountsForContacts(ws: WorkspaceId, ids: readonly string[]) {
    const out = new Map<string, { userId: UserId; workspaceId: WorkspaceId | null }>();
    for (const r of this.rows.filter(x => x.status === "accepted")) {
      if (r.requesterWorkspaceId === ws && r.requesterContactId && ids.includes(r.requesterContactId)) out.set(r.requesterContactId, { userId: r.recipientUserId, workspaceId: r.recipientWorkspaceId });
      if (r.recipientWorkspaceId === ws && r.recipientContactId && ids.includes(r.recipientContactId)) out.set(r.recipientContactId, { userId: r.requesterUserId, workspaceId: r.requesterWorkspaceId });
    }
    return Promise.resolve(out);
  }
}

class FakePeople implements PeopleDirectory {
  people = new Map<string, DirectoryPerson & { verified: boolean }>();
  hidden = new Set<string>();
  findVerifiedByEmail(e: string) {
    const p = [...this.people.values()].find(x => x.email.toLowerCase() === e && x.verified);
    return Promise.resolve(p ?? null);
  }
  findById(u: UserId) { return Promise.resolve(this.people.get(u) ?? null); }
  findManyById(ids: readonly UserId[]) {
    return Promise.resolve(new Map(ids.filter(i => this.people.has(i)).map(i => [i, this.people.get(i)!] as const)));
  }
  isDiscoverable(u: UserId) { return Promise.resolve(!this.hidden.has(u)); }
  setDiscoverable(u: UserId, d: boolean) { if (d) this.hidden.delete(u); else this.hidden.add(u); return Promise.resolve(); }
}

let store: InMemoryStore;
let connections: FakeConnections;
let people: FakePeople;
let clock: { t: number; now(): number; set(t: number): void };
let deps: ContactConnectionDependencies;
let seq = 0;

beforeEach(() => {
  store = new InMemoryStore();
  connections = new FakeConnections();
  people = new FakePeople();
  clock = { t: AT, now() { return this.t; }, set(t: number) { this.t = t; } };
  seq = 0;
  store.workspaces.set(WS_A, { workspaceId: WS_A, name: "Reyes Law Office", createdAt: AT });
  store.workspaces.set(WS_B, { workspaceId: WS_B, name: "Ben & Co", createdAt: AT });
  store.workspaces.set(WS_B2, { workspaceId: WS_B2, name: "Ben Side Project", createdAt: AT });
  for (const [userId, ws, role] of [
    [ANA, WS_A, "owner"], [NEWCOMER, WS_A, "member"], [BEN, WS_B, "owner"], [BEN, WS_B2, "member"],
  ] as const) {
    store.memberships.push({ memberId: `mem_${userId}_${ws}` as WorkspaceMemberId, workspaceId: ws, userId, role, createdAt: AT });
  }
  people.people.set(ANA, { userId: ANA, email: "ana@example.com", displayName: "Ana Reyes", jobTitle: "Partner", organization: null, verified: true });
  people.people.set(BEN, { userId: BEN, email: "Ben@Example.com", displayName: "Ben Lim", jobTitle: "Counsel", organization: "Ben & Co", verified: true });
  people.people.set(HIDDEN, { userId: HIDDEN, email: "hidden@example.com", displayName: "Hidden", jobTitle: null, organization: null, verified: true });
  people.hidden.add(HIDDEN);
  people.people.set("usr_unverified", { userId: "usr_unverified" as UserId, email: "new@example.com", displayName: "New", jobTitle: null, organization: null, verified: false });
  deps = {
    transactions: new FakeTransactionManager(store),
    clock,
    ids: {
      nextConnectionId: () => `cc_${String(++seq)}`,
      nextContactId: () => `con_${String(++seq)}` as ContactId,
    },
    connections,
    people,
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${String(++seq)}` as never,
      nextNotificationDeliveryId: () => `ndel_${String(++seq)}` as never,
    },
  };
});

const intents = () => [...store.notificationIntents.values()];
const contactsOf = (ws: WorkspaceId) => store.contacts.filter(c => c.workspaceId === ws);

describe("finding someone", () => {
  it("finds a verified, findable account by its exact address in any case", async () => {
    const result = await lookupPerson(actor(ANA), WS_A, { email: "  BEN@example.COM " }, deps);
    expect(result.person).toMatchObject({ userId: BEN, displayName: "Ben Lim", jobTitle: "Counsel", relationship: "none" });
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("gives one answer for absent, unverified and hidden accounts", async () => {
    for (const email of ["nobody@example.com", "new@example.com", "hidden@example.com"]) {
      expect((await lookupPerson(actor(ANA), WS_A, { email }, deps)).person).toBeNull();
    }
  });

  it("says when the address is already in your contacts", async () => {
    store.contacts.push(contactRecord("con_ben", WS_A, "ben@example.com"));
    const result = await lookupPerson(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    expect(result.existingContactId).toBe("con_ben");
  });

  it("refuses a workspace the caller is not in", async () => {
    await expect(lookupPerson(actor(ANA), WS_B, { email: "ben@example.com" }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

function contactRecord(id: string, ws: WorkspaceId, email: string, overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    contactId: id as ContactId, workspaceId: ws, name: id, email, emailKey: email.toLowerCase() as never,
    phone: null, organization: null, title: null, createdAt: AT, updatedAt: AT, archivedAt: null,
    scope: "workspace", ownerUserId: null, note: null, tagIds: [], ...overrides,
  };
}

describe("asking to add someone", () => {
  it("records a pending request and tells them in-app only", async () => {
    const view = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    expect(view).toMatchObject({ status: "pending", workspaceName: "Reyes Law Office", person: { userId: BEN } });
    const [intent] = intents();
    expect(intent).toMatchObject({ notificationType: "CONTACT_CONNECTION_REQUESTED", audience: { kind: "USER", userId: BEN } });
    const lookup = await lookupPerson(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    expect(lookup.person?.relationship).toBe("requested");
    const theirs = await lookupPerson(actor(BEN), WS_B, { email: "ana@example.com" }, deps);
    expect(theirs.person?.relationship).toBe("incoming");
  });

  it("needs contact.create where it is sent from", async () => {
    await expect(sendConnectionRequest(actor(NEWCOMER), WS_A, { email: "ben@example.com" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("will not ask yourself, a hidden account, or one already in your contacts", async () => {
    await expect(sendConnectionRequest(actor(ANA), WS_A, { email: "ana@example.com" }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(sendConnectionRequest(actor(ANA), WS_A, { email: "hidden@example.com" }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    store.contacts.push(contactRecord("con_ben", WS_A, "ben@example.com"));
    await expect(sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps))
      .rejects.toMatchObject({ code: "contact_connection_already_in_contacts" });
  });

  it("allows one waiting request per pair, in either direction", async () => {
    await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    await expect(sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps))
      .rejects.toMatchObject({ code: "contact_connection_already_requested" });
    await expect(sendConnectionRequest(actor(BEN), WS_B, { email: "ana@example.com" }, deps))
      .rejects.toBeInstanceOf(ContactConnectionConflictError);
  });
});

describe("declining is quiet", () => {
  it("keeps showing the sender Requested, and parks a new request without a notice, for 30 days", async () => {
    const sent = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    await declineConnectionRequest(actor(BEN), sent.connectionId, deps);
    expect((await listConnections(actor(ANA), deps)).sent.map(c => c.connectionId)).toEqual([sent.connectionId]);
    expect((await listConnections(actor(BEN), deps)).received).toEqual([]);

    await cancelConnectionRequest(actor(ANA), sent.connectionId, deps);
    const before = intents().length;
    const again = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    expect(again.status).toBe("pending");
    expect(intents()).toHaveLength(before);
    expect((await listConnections(actor(BEN), deps)).received).toEqual([]);

    clock.set(AT + QUIET_WINDOW_MS + 1);
    expect((await listConnections(actor(ANA), deps)).sent).toEqual([]);
    const later = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    expect((await listConnections(actor(BEN), deps)).received.map(c => c.connectionId)).toEqual([later.connectionId]);
  });
});

describe("accepting", () => {
  it("gives each side a personal contact in their own workspace, and tells the sender", async () => {
    const sent = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    const result = await acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_B2 }, deps);
    expect(result.workspaceId).toBe(WS_B2);

    const [bens] = contactsOf(WS_B2);
    expect(bens).toMatchObject({ name: "Ana Reyes", email: "ana@example.com", title: "Partner",
      organization: "Reyes Law Office", scope: "personal", ownerUserId: BEN });
    const [anas] = contactsOf(WS_A);
    expect(anas).toMatchObject({ name: "Ben Lim", email: "Ben@Example.com", organization: "Ben & Co", scope: "personal", ownerUserId: ANA });

    expect(intents().map(i => i.notificationType)).toEqual(["CONTACT_CONNECTION_REQUESTED", "CONTACT_CONNECTION_ACCEPTED"]);
    const accounts = await resolveContactAccounts(WS_A, [{ contactId: anas!.contactId, workspaceMember: null }], deps);
    // Ben's banner is the brand of the workspace he accepted into (none set: the default).
    expect(accounts.get(anas!.contactId)).toEqual({ userId: BEN, displayName: "Ben Lim", jobTitle: "Counsel", connected: true, brandColor: null });

    // Accepting again changes nothing and creates nothing.
    await acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_B }, deps);
    expect(store.contacts).toHaveLength(2);
  });

  it("gives each contact the brand colour of the workspace its person belongs to", async () => {
    store.branding.set(WS_A, { senderDisplayName: null, footerTagline: null, primaryColor: "#0B5E3C", logo: null, updatedAt: AT });
    store.branding.set(WS_B2, { senderDisplayName: null, footerTagline: null, primaryColor: "#7C3AED", logo: null, updatedAt: AT });
    const sent = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    await acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_B2 }, deps);
    const [anas] = contactsOf(WS_A);
    const [bens] = contactsOf(WS_B2);
    // Ana's contact for Ben wears Ben's workspace; Ben's for Ana wears Ana's.
    expect((await resolveContactAccounts(WS_A, [{ contactId: anas!.contactId, workspaceMember: null }], deps)).get(anas!.contactId)?.brandColor).toBe("#7C3AED");
    expect((await resolveContactAccounts(WS_B2, [{ contactId: bens!.contactId, workspaceMember: null }], deps)).get(bens!.contactId)?.brandColor).toBe("#0B5E3C");
    // A workspace member wears this workspace's own brand.
    const member = await resolveContactAccounts(WS_A, [{ contactId: "con_member", workspaceMember: { userId: ANA } }], deps);
    expect(member.get("con_member")?.brandColor).toBe("#0B5E3C");
  });

  it("links an address already in the address book instead of duplicating it", async () => {
    store.contacts.push(contactRecord("con_existing", WS_B, "ana@example.com", { scope: "personal", ownerUserId: BEN }));
    const sent = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    const result = await acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_B }, deps);
    expect(result.contactId).toBe("con_existing");
    expect(contactsOf(WS_B)).toHaveLength(1);
  });

  it("is only for the recipient, only while pending, and only into their own workspace", async () => {
    const sent = await sendConnectionRequest(actor(ANA), WS_A, { email: "ben@example.com" }, deps);
    await expect(acceptConnectionRequest(actor(ANA), sent.connectionId, { workspaceId: WS_A }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_A }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await declineConnectionRequest(actor(BEN), sent.connectionId, deps);
    await expect(acceptConnectionRequest(actor(BEN), sent.connectionId, { workspaceId: WS_B }, deps))
      .rejects.toMatchObject({ code: "contact_connection_not_pending" });
  });
});

describe("photos", () => {
  it("are visible for yourself, a findable account, or someone you have a request with", async () => {
    expect(await canSeePhoto(ANA, ANA, deps)).toBe(true);
    expect(await canSeePhoto(ANA, BEN, deps)).toBe(true);
    expect(await canSeePhoto(ANA, HIDDEN, deps)).toBe(false);
  });
});
