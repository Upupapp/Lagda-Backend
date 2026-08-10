// Contact use cases, tested with fakes.
//
// Three groups of test carry most of the weight, and they are the three claims
// BACKEND-28 makes that would be expensive to be wrong about:
//
//   1. A contact is never an identity. Creating one with a LAGDA user's exact
//      email creates no account, no membership and no invitation.
//   2. Tenancy holds. Another workspace's contact is indistinguishable from a
//      contact that does not exist.
//   3. Duplicates are WARNED about, never refused — and the warning is accurate.

import { describe, it, expect } from "vitest";
import type { ContactId, UserId, WorkspaceId } from "@lagda/contracts";
import { WORKSPACE_ROLES } from "@lagda/contracts";
import {
  createContact, listContacts, getContact, updateContact,
  archiveContact, restoreContact,
  type ContactDependencies,
} from "./contacts.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertNormalized } from "../auth/email-identity.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { WorkspaceMemberId, WorkspaceRole } from "@lagda/contracts";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds, SequentialContactIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const SENDER = "usr_sender" as UserId;
const TEMPLATE_ADMIN = "usr_template" as UserId;
const MEMBER = "usr_member" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly transactions: FakeTransactionManager;
  readonly deps: ContactDependencies;
  readonly workspaceId: WorkspaceId;
}

const VALID = {
  name: "Maria Santos",
  email: "maria.santos@ayalaland.com.ph",
  phone: "+63 917 123 4567",
  organization: "Ayala Land",
  title: "General Counsel",
};

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  for (const [userId, address] of [
    [OWNER, "owner@example.com"], [ADMIN, "admin@example.com"],
    [SENDER, "sender@example.com"], [TEMPLATE_ADMIN, "template@example.com"],
    [MEMBER, "member@example.com"], [REVIEWER, "reviewer@example.com"],
    [AUDITOR, "auditor@example.com"], [OUTSIDER, "outsider@example.com"],
  ] as const) {
    store.accountEmails.set(assertNormalized(address), userId);
  }

  const created = await new CreateWorkspace({
    transactions,
    clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  for (const [key, userId, role] of [
    ["admin", ADMIN, "administrator"],
    ["sender", SENDER, "sender"],
    ["template", TEMPLATE_ADMIN, "template_administrator"],
    ["member", MEMBER, "member"],
    ["reviewer", REVIEWER, "reviewer"],
    ["auditor", AUDITOR, "auditor"],
  ] as const) {
    store.memberships.push({
      memberId: `mem_${key}` as WorkspaceMemberId,
      workspaceId: created.workspaceId,
      userId,
      role,
      createdAt: AT + 1000,
    });
  }

  return {
    store, transactions, workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialContactIds() },
  };
}

// ── The identity boundary ────────────────────────────────────────────────────

describe("a contact is not an identity", () => {
  it("creates NO user, membership or invitation", async () => {
    const h = await harness();
    const membershipsBefore = h.store.memberships.length;

    await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);

    expect(h.store.memberships).toHaveLength(membershipsBefore);
    expect(h.store.invitations).toHaveLength(0);
    expect(h.store.invitationDigests.size).toBe(0);
    expect(h.store.contacts).toHaveLength(1);
  });

  it("creates nothing extra even when the email IS a LAGDA account", async () => {
    // The case worth stating. `member@example.com` is a real user in a real
    // membership of this very workspace. Adding them to the address book must
    // not link, notify, promote or otherwise touch that account.
    const h = await harness();
    const membershipsBefore = [...h.store.memberships];

    const result = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "A Colleague", email: "member@example.com" },
      h.deps);

    expect(result.contact.email).toBe("member@example.com");
    expect(h.store.memberships).toEqual(membershipsBefore);
    expect(h.store.invitations).toHaveLength(0);
    // And no duplicate warning either: the account is not a contact.
    expect(result.duplicates).toHaveLength(0);
  });

  it("never exposes the comparison key", async () => {
    const h = await harness();
    const result = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    // `emailKey` is internal. A client that received it would eventually
    // compare it to a user's normalized email and conclude something.
    expect(Object.keys(result.contact)).not.toContain("emailKey");
    expect(Object.keys(result.contact)).not.toContain("workspaceId");
  });
});

// ── Creation ─────────────────────────────────────────────────────────────────

describe("createContact", () => {
  it("stores the display email exactly as typed", async () => {
    const h = await harness();
    const result = await createContact(
      actor(OWNER), h.workspaceId,
      { ...VALID, email: "Maria.Santos@AyalaLand.com.ph" }, h.deps);

    // Case preserved on the way out. A contact card that rewrote someone's
    // business card would be noticed and resented.
    expect(result.contact.email).toBe("Maria.Santos@AyalaLand.com.ph");
    // And folded internally, so duplicate detection works across cases.
    expect(h.store.contacts[0]?.emailKey).toBe("maria.santos@ayalaland.com.ph");
  });

  it("trims the outside of a name and leaves the inside alone", async () => {
    const h = await harness();
    const result = await createContact(
      actor(OWNER), h.workspaceId, { ...VALID, name: "  Reyes  &  Co.  " }, h.deps);
    expect(result.contact.name).toBe("Reyes  &  Co.");
  });

  it("stores optional fields as null when omitted or blank", async () => {
    const h = await harness();
    const result = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "Solo", email: "solo@example.com", phone: "   ", organization: null },
      h.deps);

    expect(result.contact.phone).toBeNull();
    expect(result.contact.organization).toBeNull();
    expect(result.contact.title).toBeNull();
  });

  it("accepts non-ASCII names", async () => {
    const h = await harness();
    for (const name of ["José Ramírez", "株式会社トヨタ", "Ñoño Dela Cruz"]) {
      const result = await createContact(
        actor(OWNER), h.workspaceId, { name, email: "x@example.com" }, h.deps);
      expect(result.contact.name).toBe(name);
    }
  });

  it("reports ALL validation problems at once", async () => {
    const h = await harness();
    const failure = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "", email: "not-an-email", title: "x".repeat(500) },
      h.deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationValidationError);
    const issues = (failure as ApplicationValidationError).issues;
    expect(issues).toContain("name: empty");
    expect(issues).toContain("email: malformed");
    expect(issues).toContain("title: too-long");
  });

  it("rejects a name containing control or format characters", async () => {
    const h = await harness();
    const hostile = [
      // Cc: NUL and newline. A contact name containing one breaks a log
      // line, a CSV export and a PDF recipient block.
      "Maria\u0000Santos",
      "Maria\nSantos",
      // Cf: a zero-width joiner and a right-to-left override. The second is
      // the one that matters here — it can make a rendered recipient name
      // read as a different person than the one stored, on a document
      // somebody is about to sign.
      "Maria\u200dSantos",
      "Maria\u202eSantos",
    ];
    for (const name of hostile) {
      await expect(createContact(
        actor(OWNER), h.workspaceId, { name, email: "x@example.com" }, h.deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
    expect(h.store.contacts).toHaveLength(0);
  });

  it("does not leak the value into the validation message", async () => {
    const h = await harness();
    const failure = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "ok", email: "juan.dela.cruz@example.com".repeat(20) }, h.deps)
      .catch((error: unknown) => error) as ApplicationValidationError;

    expect(failure.message).not.toContain("juan.dela.cruz");
    expect(failure.issues.join(" ")).not.toContain("juan.dela.cruz");
  });
});

// ── Duplicates ───────────────────────────────────────────────────────────────

describe("duplicate policy: warn, never refuse", () => {
  it("creates the second contact and reports the first", async () => {
    const h = await harness();
    const first = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "Legal Desk", email: "legal@example.com", organization: "Acme" },
      h.deps);

    const second = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "Legal Team PH", email: "legal@example.com" }, h.deps);

    // BOTH exist. A shared inbox is legitimately several business contacts.
    expect(h.store.contacts).toHaveLength(2);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]?.contactId).toBe(first.contact.contactId);
    expect(second.duplicates[0]?.organization).toBe("Acme");
  });

  it("matches across case and surrounding whitespace", async () => {
    const h = await harness();
    await createContact(
      actor(OWNER), h.workspaceId,
      { name: "First", email: "Legal@Example.com" }, h.deps);

    const second = await createContact(
      actor(OWNER), h.workspaceId,
      { name: "Second", email: "  legal@example.com  " }, h.deps);
    expect(second.duplicates).toHaveLength(1);
  });

  it("does NOT treat a plus-tag as the same address", async () => {
    // Deliberate. `billing+ph@` and `billing+sg@` are two mailboxes someone set
    // up on purpose, and folding them would report two real contacts as one.
    const h = await harness();
    await createContact(actor(OWNER), h.workspaceId,
      { name: "PH", email: "billing+ph@acme.com" }, h.deps);
    const second = await createContact(actor(OWNER), h.workspaceId,
      { name: "SG", email: "billing+sg@acme.com" }, h.deps);
    expect(second.duplicates).toHaveLength(0);
  });

  it("ignores ARCHIVED contacts", async () => {
    const h = await harness();
    const first = await createContact(actor(OWNER), h.workspaceId,
      { name: "Old", email: "legal@example.com" }, h.deps);
    await archiveContact(actor(OWNER), h.workspaceId, first.contact.contactId, h.deps);

    const second = await createContact(actor(OWNER), h.workspaceId,
      { name: "New", email: "legal@example.com" }, h.deps);
    // Warning about a record nobody can select is noise.
    expect(second.duplicates).toHaveLength(0);
  });

  it("does not report a contact as its own duplicate on update", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    const updated = await updateContact(
      actor(OWNER), h.workspaceId, created.contact.contactId,
      { ...VALID, title: "Chief Legal Officer" }, h.deps);
    expect(updated.duplicates).toHaveLength(0);
  });

  it("warns when an update moves a contact onto an address in use", async () => {
    const h = await harness();
    const other = await createContact(actor(OWNER), h.workspaceId,
      { name: "Legal Desk", email: "legal@example.com" }, h.deps);
    const mine = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);

    const updated = await updateContact(
      actor(OWNER), h.workspaceId, mine.contact.contactId,
      { ...VALID, email: "legal@example.com" }, h.deps);

    expect(updated.contact.email).toBe("legal@example.com");
    expect(updated.duplicates.map(d => d.contactId)).toEqual([other.contact.contactId]);
  });

  it("does not report duplicates from ANOTHER workspace", async () => {
    const h = await harness();
    const other = await harness();
    await createContact(actor(OWNER), other.workspaceId,
      { name: "Elsewhere", email: "legal@example.com" }, other.deps);

    const created = await createContact(actor(OWNER), h.workspaceId,
      { name: "Here", email: "legal@example.com" }, h.deps);
    expect(created.duplicates).toHaveLength(0);
  });
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("capability enforcement", () => {
  const ALLOWED = [OWNER, ADMIN, TEMPLATE_ADMIN, SENDER];
  const REFUSED = [MEMBER, REVIEWER, AUDITOR];

  it("permits the four roles the product grants manage_contacts", async () => {
    for (const userId of ALLOWED) {
      const h = await harness();
      const created = await createContact(actor(userId), h.workspaceId, VALID, h.deps);
      expect(created.contact.name).toBe(VALID.name);
      await expect(listContacts(actor(userId), h.workspaceId, {}, h.deps))
        .resolves.toMatchObject({ total: 1 });
    }
  });

  it("REFUSES member, reviewer and auditor — including reading", async () => {
    for (const userId of REFUSED) {
      const h = await harness();
      await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);

      // Read is refused too. `manage_contacts` is also the navigation gate, so
      // these roles cannot reach the address book at all.
      await expect(listContacts(actor(userId), h.workspaceId, {}, h.deps))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(createContact(actor(userId), h.workspaceId, VALID, h.deps))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    }
  });

  it("REFUSES a non-member with the same hidden 404", async () => {
    const h = await harness();
    await expect(listContacts(actor(OUTSIDER), h.workspaceId, {}, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("covers every role in the vocabulary", () => {
    // So a role added later cannot be silently untested.
    const covered = new Set<WorkspaceRole>(["owner", "administrator",
      "template_administrator", "sender", "member", "reviewer", "auditor"]);
    expect([...WORKSPACE_ROLES].sort()).toEqual([...covered].sort());
  });

  it("re-reads the actor's role INSIDE the transaction", async () => {
    const h = await harness();
    // Demoted between requests. The next write must fail on the CURRENT role,
    // not on one cached from an earlier resolution.
    const index = h.store.memberships.findIndex(m => m.userId === ADMIN);
    const existing = h.store.memberships[index];
    if (existing === undefined) throw new Error("fixture");
    h.store.memberships[index] = { ...existing, role: "reviewer" };

    await expect(createContact(actor(ADMIN), h.workspaceId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Tenancy ──────────────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("cannot read another workspace's contact by id", async () => {
    const h = await harness();
    const other = await harness();
    const theirs = await createContact(actor(OWNER), other.workspaceId, VALID, other.deps);

    // Same id, this workspace's scope. Indistinguishable from absent.
    await expect(getContact(actor(OWNER), h.workspaceId, theirs.contact.contactId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("cannot update or archive another workspace's contact", async () => {
    const h = await harness();
    const other = await harness();
    const theirs = await createContact(actor(OWNER), other.workspaceId, VALID, other.deps);

    await expect(updateContact(
      actor(OWNER), h.workspaceId, theirs.contact.contactId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(archiveContact(
      actor(OWNER), h.workspaceId, theirs.contact.contactId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    // And it is untouched.
    const still = await getContact(
      actor(OWNER), other.workspaceId, theirs.contact.contactId, other.deps);
    expect(still.state).toBe("active");
    expect(still.name).toBe(VALID.name);
  });

  it("lists only this workspace's contacts", async () => {
    const h = await harness();
    const other = await harness();
    await createContact(actor(OWNER), h.workspaceId, { name: "Mine", email: "a@x.com" }, h.deps);
    await createContact(
      actor(OWNER), other.workspaceId, { name: "Theirs", email: "b@x.com" }, other.deps);

    const listed = await listContacts(actor(OWNER), h.workspaceId, {}, h.deps);
    expect(listed.items.map(c => c.name)).toEqual(["Mine"]);
  });
});

// ── Listing ──────────────────────────────────────────────────────────────────

describe("listContacts", () => {
  async function seeded(): Promise<Harness> {
    const h = await harness();
    for (const [name, email, organization] of [
      ["Ana Cruz", "ana@ayalaland.com.ph", "Ayala Land"],
      ["Ben Reyes", "ben@sm.com.ph", "SM Prime"],
      ["Carlos Uy", "carlos@ayalaland.com.ph", null],
    ] as const) {
      await createContact(actor(OWNER), h.workspaceId,
        { name, email, organization }, h.deps);
    }
    return h;
  }

  it("defaults to active contacts, 20 per page, newest activity first", async () => {
    const h = await seeded();
    const listed = await listContacts(actor(OWNER), h.workspaceId, {}, h.deps);
    expect(listed.perPage).toBe(20);
    expect(listed.page).toBe(1);
    expect(listed.total).toBe(3);
    expect(listed.hasNextPage).toBe(false);
  });

  it("searches name, email, organization and title", async () => {
    const h = await seeded();
    const byOrg = await listContacts(
      actor(OWNER), h.workspaceId, { search: "ayala" }, h.deps);
    // Two by organization/email — Ana (both) and Carlos (email only).
    expect(byOrg.total).toBe(2);

    const byName = await listContacts(
      actor(OWNER), h.workspaceId, { search: "reyes" }, h.deps);
    expect(byName.items.map(c => c.name)).toEqual(["Ben Reyes"]);
  });

  it("treats a blank search as no search", async () => {
    const h = await seeded();
    const listed = await listContacts(
      actor(OWNER), h.workspaceId, { search: "   " }, h.deps);
    expect(listed.total).toBe(3);
  });

  it("rejects an over-long search term", async () => {
    const h = await seeded();
    await expect(listContacts(
      actor(OWNER), h.workspaceId, { search: "x".repeat(500) }, h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("sorts by name ascending on request", async () => {
    const h = await seeded();
    const listed = await listContacts(
      actor(OWNER), h.workspaceId, { sort: "name", direction: "asc" }, h.deps);
    expect(listed.items.map(c => c.name)).toEqual(["Ana Cruz", "Ben Reyes", "Carlos Uy"]);
  });

  it("puts a null organization LAST in both directions", async () => {
    const h = await seeded();
    for (const direction of ["asc", "desc"] as const) {
      const listed = await listContacts(
        actor(OWNER), h.workspaceId, { sort: "organization", direction }, h.deps);
      expect(listed.items[2]?.organization).toBeNull();
    }
  });

  it("paginates with a stable total", async () => {
    const h = await seeded();
    const page1 = await listContacts(
      actor(OWNER), h.workspaceId,
      { sort: "name", direction: "asc", page: 1, perPage: 2 }, h.deps);
    expect(page1.items.map(c => c.name)).toEqual(["Ana Cruz", "Ben Reyes"]);
    expect(page1.total).toBe(3);
    expect(page1.hasNextPage).toBe(true);

    const page2 = await listContacts(
      actor(OWNER), h.workspaceId,
      { sort: "name", direction: "asc", page: 2, perPage: 2 }, h.deps);
    expect(page2.items.map(c => c.name)).toEqual(["Carlos Uy"]);
    expect(page2.hasNextPage).toBe(false);
  });

  it("returns an empty page past the end, not an error", async () => {
    const h = await seeded();
    const listed = await listContacts(
      actor(OWNER), h.workspaceId, { page: 99, perPage: 20 }, h.deps);
    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(3);
  });

  it("excludes archived contacts from the active book", async () => {
    const h = await seeded();
    const first = await listContacts(actor(OWNER), h.workspaceId, {}, h.deps);
    const target = first.items[0];
    if (target === undefined) throw new Error("fixture");
    await archiveContact(actor(OWNER), h.workspaceId, target.contactId, h.deps);

    const active = await listContacts(actor(OWNER), h.workspaceId, {}, h.deps);
    expect(active.total).toBe(2);

    const archived = await listContacts(
      actor(OWNER), h.workspaceId, { state: "archived" }, h.deps);
    expect(archived.items.map(c => c.contactId)).toEqual([target.contactId]);
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("updateContact", () => {
  it("replaces every editable field and clears the omitted ones", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);

    const updated = await updateContact(
      actor(OWNER), h.workspaceId, created.contact.contactId,
      { name: "Maria Santos-Cruz", email: VALID.email }, h.deps);

    expect(updated.contact.name).toBe("Maria Santos-Cruz");
    // PUT semantics: the fields the client did not send are cleared, which is
    // what a full replacement means and is unambiguous.
    expect(updated.contact.phone).toBeNull();
    expect(updated.contact.organization).toBeNull();
    expect(updated.contact.title).toBeNull();
  });

  it("cannot change the contact id or the workspace", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    const updated = await updateContact(
      actor(OWNER), h.workspaceId, created.contact.contactId,
      { ...VALID, name: "Renamed" }, h.deps);

    expect(updated.contact.contactId).toBe(created.contact.contactId);
    expect(h.store.contacts[0]?.workspaceId).toBe(h.workspaceId);
    expect(h.store.contacts[0]?.createdAt).toBe(created.contact.createdAt);
  });

  it("REFUSES to edit an archived contact", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    await archiveContact(actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);

    await expect(updateContact(
      actor(OWNER), h.workspaceId, created.contact.contactId,
      { ...VALID, name: "Sneaky" }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    // Unchanged, and still archived.
    const still = await getContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);
    expect(still.name).toBe(VALID.name);
    expect(still.state).toBe("archived");
  });

  it("validates before it writes", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    await expect(updateContact(
      actor(OWNER), h.workspaceId, created.contact.contactId,
      { name: "", email: "nope" }, h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);

    const still = await getContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);
    expect(still.name).toBe(VALID.name);
  });
});

// ── Archive and restore ──────────────────────────────────────────────────────

describe("archive and restore", () => {
  it("archives reversibly, without deleting the row", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);

    const archived = await archiveContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);
    expect(archived.state).toBe("archived");
    expect(archived.archivedAt).toBe(AT);
    // The row survives. There is no delete anywhere in this domain.
    expect(h.store.contacts).toHaveLength(1);

    const restored = await restoreContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);
    expect(restored.state).toBe("active");
    expect(restored.archivedAt).toBeNull();
  });

  it("refuses to archive twice", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    await archiveContact(actor(OWNER), h.workspaceId, created.contact.contactId, h.deps);
    await expect(archiveContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses to restore an active contact", async () => {
    const h = await harness();
    const created = await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    await expect(restoreContact(
      actor(OWNER), h.workspaceId, created.contact.contactId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses an unknown id", async () => {
    const h = await harness();
    await expect(archiveContact(
      actor(OWNER), h.workspaceId, "con_nope" as ContactId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Transactionality ─────────────────────────────────────────────────────────

describe("transaction behaviour", () => {
  it("rolls back everything when the write fails", async () => {
    const h = await harness();
    // A validation failure occurs before the transaction; force a failure
    // INSIDE one by aiming at a contact that vanishes mid-flight is not
    // expressible with fakes, so this asserts the simpler guarantee: a
    // rejected mutation leaves no partial row behind.
    await expect(updateContact(
      actor(OWNER), h.workspaceId, "con_missing" as ContactId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.contacts).toHaveLength(0);
    expect(h.transactions.rolledBack).toBeGreaterThan(0);
  });

  it("uses ONE transaction per operation", async () => {
    const h = await harness();
    const before = h.transactions.started;
    await createContact(actor(OWNER), h.workspaceId, VALID, h.deps);
    expect(h.transactions.started - before).toBe(1);
  });
});
