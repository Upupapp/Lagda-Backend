// Messages from the public website (095), with fakes: what a visitor may
// send, that the inbox account is told (and nobody else, and never with the
// message in the notice), and that only that account can read them.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId } from "@lagda/contracts";
import {
  submitPublicInquiry, listPublicInquiries, getPublicInquiry, readsPublicInquiries,
  type PublicInquiryDependencies, type PublicInquiryInput,
} from "./public-inquiries.js";
import type {
  PublicInquiryInboxAccount, PublicInquiryKind, PublicInquiryRecord,
  PublicInquiryRepository, PublicInquiryUnitOfWork,
} from "../common/ports/public-inquiries.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import { InMemoryStore, fakeNotifications } from "../test-support/fakes.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";
import { policyFor } from "../notifications/policy.js";
import { notificationPreferenceCategoryOf } from "../notifications/preferences.js";

const AT = Date.parse("2026-10-02T09:00:00.000Z");
const BOSS = "usr_boss" as UserId; // the inbox account
const ANA = "usr_ana" as UserId;   // somebody else
const actor = (userId: UserId): AuthenticatedActor => ({ actorType: "user", userId, sessionId: "ses_x" as SessionId });

class FakeInquiries implements PublicInquiryRepository {
  rows: PublicInquiryRecord[] = [];
  accounts = new Map<string, PublicInquiryInboxAccount>();
  noticeUsers: UserId[] = [];
  constructor(private readonly store: InMemoryStore) {}

  insert(i: PublicInquiryRecord) { this.rows.push(i); return Promise.resolve(); }
  find(id: string) { return Promise.resolve(this.rows.find(r => r.inquiryId === id) ?? null); }
  list({ kind, limit }: { kind: PublicInquiryKind | null; limit: number }) {
    return Promise.resolve(this.rows.filter(r => kind === null || r.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit));
  }
  countByKind() {
    const counts: Record<PublicInquiryKind, number> = { demo: 0, contact: 0, waitlist: 0 };
    for (const r of this.rows) counts[r.kind] += 1;
    return Promise.resolve(counts);
  }
  account(u: UserId) { return Promise.resolve(this.accounts.get(u) ?? null); }
  accountByNormalizedEmail(e: string) {
    return Promise.resolve([...this.accounts.values()].find(a => a.email.toLowerCase() === e) ?? null);
  }
  async transact<T>(noticeUserId: UserId, op: (uow: PublicInquiryUnitOfWork) => Promise<T>): Promise<T> {
    const before = [...this.rows];
    this.noticeUsers.push(noticeUserId);
    try {
      return await op({
        insert: i => { this.rows.push(i); return Promise.resolve(); },
        notifications: fakeNotifications(this.store),
        transaction: null,
      });
    } catch (error) {
      this.rows = before;
      throw error;
    }
  }
}

let store: InMemoryStore;
let inquiries: FakeInquiries;
let clock: { t: number; now(): number };
let deps: PublicInquiryDependencies;
let seq = 0;

beforeEach(() => {
  store = new InMemoryStore();
  inquiries = new FakeInquiries(store);
  clock = { t: AT, now() { return this.t; } };
  seq = 0;
  inquiries.accounts.set(BOSS, { userId: BOSS, email: "Boss@Example.com", displayName: "Chris Cortes" });
  inquiries.accounts.set(ANA, { userId: ANA, email: "ana@example.com", displayName: "Ana Reyes" });
  deps = {
    clock,
    inquiries,
    ids: { nextPublicInquiryId: () => `pin_${String(++seq)}` },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${String(++seq)}` as never,
      nextNotificationDeliveryId: () => `ndel_${String(++seq)}` as never,
    },
    inboxEmail: "boss@example.com",
  };
});

const intents = () => [...store.notificationIntents.values()];

const contact: PublicInquiryInput = {
  kind: "contact", name: "  Maria   Santos ", email: "maria@example.ph", topic: "Sales",
  subject: "Pricing for a law office", message: "We are twelve lawyers.\r\n\r\n\r\n\r\nHow does Business work?",
  consent: true,
};
const demo: PublicInquiryInput = {
  kind: "demo", name: "Jose Cruz", email: "jose@example.ph", organization: "Cruz & Partners",
  topic: "esignature", consent: true,
};
const waitlist: PublicInquiryInput = {
  kind: "waitlist", name: "Lea Ramos", email: "lea@example.ph", topic: "notary", consent: true,
};

describe("a visitor sending a message", () => {
  it("stores it, cleaned up, and gives back a receipt", async () => {
    const receipt = await submitPublicInquiry(contact, deps);
    expect(receipt).toEqual({ inquiryId: "pin_1", kind: "contact", receivedAt: AT });
    expect(inquiries.rows).toEqual([{
      inquiryId: "pin_1", kind: "contact", name: "Maria Santos", email: "maria@example.ph",
      organization: null, role: null, organizationSize: null, industry: null, phone: null,
      topic: "Sales", subject: "Pricing for a law office",
      message: "We are twelve lawyers.\n\nHow does Business work?", createdAt: AT,
    }]);
  });

  it("tells the inbox account, by email and in-app, and nobody else", async () => {
    await submitPublicInquiry(contact, deps);
    const [notice, ...rest] = intents();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      notificationType: "PUBLIC_INQUIRY_RECEIVED",
      scope: { kind: "GLOBAL_USER", userId: BOSS },
      audience: { kind: "USER", userId: BOSS },
      source: { kind: "PUBLIC_INQUIRY", sourceId: "pin_1" },
    });
    // One email, to the inbox account's own address. The visitor gets none.
    expect([...store.notificationDeliveries.values()].map(d => [d.channel, d.destination]))
      .toEqual([["EMAIL", "Boss@Example.com"]]);
    // The notice row is written as the inbox account's own.
    expect(inquiries.noticeUsers).toEqual([BOSS]);
    expect(policyFor("PUBLIC_INQUIRY_RECEIVED")).toMatchObject({
      channel: "EMAIL", scopeKind: "GLOBAL_USER", audienceKind: "USER", sourceKind: "PUBLIC_INQUIRY",
    });
    // Emailed AND listed in-app: not marked in-app only.
    expect(policyFor("PUBLIC_INQUIRY_RECEIVED")).not.toHaveProperty("inAppOnly");
    // The operator's inbox cannot be muted by a preference category.
    expect(notificationPreferenceCategoryOf("PUBLIC_INQUIRY_RECEIVED")).toBeNull();
  });

  it("puts who wrote in the notice, never what they wrote", async () => {
    await submitPublicInquiry(contact, deps);
    const frozen = JSON.stringify(intents()[0]);
    expect(frozen).toContain("Maria Santos");
    expect(frozen).toContain("maria@example.ph");
    expect(frozen).toContain("Contact message");
    expect(frozen).not.toContain("twelve lawyers");
    expect(frozen).not.toContain("Pricing for a law office");
  });

  it("renders an email that links to the message inside LAGDA and carries no message text", () => {
    const template = ALL_TEMPLATES.find(t => t.key === "public-inquiry-received");
    expect(template).toBeDefined();
    const rendered = template!.render(
      {
        recipientName: "Chris Cortes", kindLabel: "eNotary waitlist",
        senderName: "<b>Lea</b> Ramos", senderEmail: "lea@example.ph", inquiryId: "pin_9",
      },
      { buildPath: (path: string) => `https://app.example.com${path}` } as never,
    );
    expect(rendered.subject).toBe("eNotary waitlist from <b>Lea</b> Ramos");
    expect(rendered.textBody).toContain("https://app.example.com/app/inquiries/pin_9");
    // Visitor text is escaped in HTML.
    expect(rendered.htmlBody).toContain("&lt;b&gt;Lea&lt;/b&gt; Ramos");
    expect(rendered.htmlBody).not.toContain("<b>Lea</b>");
  });

  it("makes one notice per message", async () => {
    await submitPublicInquiry(contact, deps);
    await submitPublicInquiry(demo, deps);
    await submitPublicInquiry(waitlist, deps);
    expect(intents().map(i => i.source)).toEqual([
      { kind: "PUBLIC_INQUIRY", sourceId: "pin_1" },
      { kind: "PUBLIC_INQUIRY", sourceId: "pin_4" },
      { kind: "PUBLIC_INQUIRY", sourceId: "pin_7" },
    ]);
  });

  it("still stores the message when no inbox account exists, and tells nobody", async () => {
    await submitPublicInquiry(demo, { ...deps, inboxEmail: null });
    await submitPublicInquiry(waitlist, { ...deps, inboxEmail: "nobody@example.com" });
    expect(inquiries.rows.map(r => r.kind)).toEqual(["demo", "waitlist"]);
    expect(intents()).toEqual([]);
  });

  it("keeps nothing when the notice cannot be written", async () => {
    const broken = { ...deps, templates: createTemplateRegistry([]) };
    await expect(submitPublicInquiry(contact, broken)).rejects.toBeDefined();
    expect(inquiries.rows).toEqual([]);
  });

  it.each([
    ["an unknown kind", { ...contact, kind: "newsletter" }, "kind"],
    ["no consent", { ...contact, consent: false }, "consent"],
    ["a blank name", { ...contact, name: "   " }, "name"],
    ["a bad address", { ...contact, email: "maria(at)example" }, "email"],
    ["a contact message with no category", { ...contact, topic: undefined }, "topic"],
    ["a contact message with no subject", { ...contact, subject: " " }, "subject"],
    ["a contact message that is too short", { ...contact, message: "Hi" }, "message"],
    ["a demo request with no organization", { ...demo, organization: undefined }, "organization"],
    ["a demo request with no interest", { ...demo, topic: undefined }, "topic"],
    ["a waitlist sign-up that does not say who is asking", { ...waitlist, topic: "" }, "topic"],
    ["a message that is too long", { ...contact, message: "x".repeat(4001) }, "message"],
  ])("refuses %s", async (_label, input, field) => {
    const attempt = submitPublicInquiry(input, deps);
    await expect(attempt).rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(attempt).rejects.toMatchObject({ issues: [field] });
    expect(inquiries.rows).toEqual([]);
    expect(intents()).toEqual([]);
  });
});

describe("reading the inbox", () => {
  beforeEach(async () => {
    await submitPublicInquiry(contact, deps);
    clock.t += 1000;
    await submitPublicInquiry(demo, deps);
    clock.t += 1000;
    await submitPublicInquiry(waitlist, deps);
  });

  it("lists every message for the inbox account, newest first, with counts", async () => {
    const inbox = await listPublicInquiries(actor(BOSS), {}, deps);
    expect(inbox.inquiries.map(i => i.kind)).toEqual(["waitlist", "demo", "contact"]);
    expect(inbox.counts).toEqual({ demo: 1, contact: 1, waitlist: 1 });
  });

  it("filters by kind", async () => {
    const inbox = await listPublicInquiries(actor(BOSS), { kind: "waitlist" }, deps);
    expect(inbox.inquiries.map(i => i.name)).toEqual(["Lea Ramos"]);
    await expect(listPublicInquiries(actor(BOSS), { kind: "spam" }, deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("opens one message", async () => {
    const one = await getPublicInquiry(actor(BOSS), "pin_1", deps);
    expect(one.message).toBe("We are twelve lawyers.\n\nHow does Business work?");
    await expect(getPublicInquiry(actor(BOSS), "pin_404", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("does not exist for any other account", async () => {
    expect(await readsPublicInquiries(actor(BOSS), deps)).toBe(true);
    expect(await readsPublicInquiries(actor(ANA), deps)).toBe(false);
    await expect(listPublicInquiries(actor(ANA), {}, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getPublicInquiry(actor(ANA), "pin_1", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("does not exist for anyone when no inbox is configured", async () => {
    const closed = { ...deps, inboxEmail: null };
    expect(await readsPublicInquiries(actor(BOSS), closed)).toBe(false);
    await expect(listPublicInquiries(actor(BOSS), {}, closed)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
