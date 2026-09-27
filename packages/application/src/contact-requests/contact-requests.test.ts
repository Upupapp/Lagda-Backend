// Contact requests (086), with fakes: member vs external delivery, members-only
// preparation, no email for members, feed intents, the "Others" and "sent"
// lists, completion, decline, cancel and authorization.

import { describe, it, expect, beforeEach } from "vitest";
import type {
  ContactId, DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  createContactRequest, getContactRequest, completeContactRequest,
  declineContactRequest, cancelContactRequest, listContactRequestsForContact,
  listMyReceivedContactRequests, listMySentContactRequests,
  ContactRequestMembersOnlyError, ContactRequestRecipientCannotActError,
  type ContactRequestDependencies,
} from "./contact-requests.js";
import { getContact, listContacts } from "../contacts/contacts.js";
import type { ContactRecord } from "../common/ports/contacts.js";
import type { ContactRequestId } from "../common/ports/contact-requests.js";
import {
  ApplicationValidationError, ResourceConflictError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertNormalized } from "../auth/email-identity.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import { FixedClock, FakeTransactionManager, InMemoryStore, SequentialContactIds } from "../test-support/fakes.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const WS = "ws_cr" as WorkspaceId;
const OTHER_WS = "ws_other" as WorkspaceId;

const SENDER = "usr_sender" as UserId;
const COLLEAGUE = "usr_colleague" as UserId;   // sender role: may upload and prepare
const NEWCOMER = "usr_newcomer" as UserId;     // member role: may do neither
const REVIEWER = "usr_reviewer" as UserId;     // cannot send requests

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let deps: ContactRequestDependencies;
let seq = 0;

function contact(id: string, email: string, overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    contactId: id as ContactId, workspaceId: WS, name: `Name ${id}`, email,
    emailKey: email.toLowerCase() as never, phone: null, organization: null, title: null,
    createdAt: AT, updatedAt: AT, archivedAt: null, scope: "workspace", ownerUserId: null,
    note: null, tagIds: [], ...overrides,
  };
}

function seedDocument(documentId: string, createdBy: UserId, workspaceId = WS): void {
  store.documents.push({
    documentId: documentId as DocumentId, workspaceId, title: `Doc ${documentId}`,
    originalFilename: null, createdByUserId: createdBy, folderId: null,
    createdAt: AT, updatedAt: AT,
  });
}

beforeEach(() => {
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  seq = 0;
  store.workspaces.set(WS, { workspaceId: WS, name: "Acme Legal", createdAt: AT });
  store.workspaces.set(OTHER_WS, { workspaceId: OTHER_WS, name: "Other", createdAt: AT });
  for (const [userId, role, email] of [
    [SENDER, "sender", "sender@example.com"],
    [COLLEAGUE, "sender", "colleague@example.com"],
    [NEWCOMER, "member", "newcomer@example.com"],
    [REVIEWER, "reviewer", "reviewer@example.com"],
  ] as const) {
    store.accountEmails.set(assertNormalized(email), userId);
    store.memberships.push({
      memberId: `mem_${userId}` as WorkspaceMemberId, workspaceId: WS, userId, role, createdAt: AT,
    });
  }
  store.contacts.push(
    contact("con_colleague", "Colleague@Example.com"),
    contact("con_newcomer", "newcomer@example.com"),
    contact("con_external", "maria@outside.example"),
    contact("con_archived", "old@outside.example", { archivedAt: AT }),
    contact("con_private", "private@outside.example", { scope: "personal", ownerUserId: COLLEAGUE }),
  );
  seedDocument("doc_1", SENDER);
  deps = {
    transactions,
    clock: new FixedClock(AT),
    ids: { nextContactRequestId: () => `cr_${++seq}` as ContactRequestId },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${++seq}` as never,
      nextNotificationDeliveryId: () => `ndel_${++seq}` as never,
    },
  };
});

const intents = () => [...store.notificationIntents.values()];
const deliveryOf = (intentId: string) =>
  [...store.notificationDeliveries.values()].find(d => d.notificationIntentId === intentId);

describe("contacts carry workspaceMember at read time", () => {
  it("names the member a contact's address belongs to, and null for anyone else", async () => {
    const contactDeps = { transactions, clock: new FixedClock(AT), ids: new SequentialContactIds() };
    const colleague = await getContact(actor(SENDER), WS, "con_colleague" as ContactId, contactDeps);
    expect(colleague.workspaceMember).toEqual({ userId: COLLEAGUE, displayName: COLLEAGUE });
    const external = await getContact(actor(SENDER), WS, "con_external" as ContactId, contactDeps);
    expect(external.workspaceMember).toBeNull();

    const list = await listContacts(actor(SENDER), WS, {}, contactDeps);
    const byId = new Map(list.items.map(item => [item.contactId, item.workspaceMember]));
    expect(byId.get("con_newcomer" as ContactId)).toEqual({ userId: NEWCOMER, displayName: NEWCOMER });
    expect(byId.get("con_external" as ContactId)).toBeNull();
  });

  it("stops matching once the member leaves", async () => {
    const contactDeps = { transactions, clock: new FixedClock(AT), ids: new SequentialContactIds() };
    const index = store.memberships.findIndex(m => m.userId === COLLEAGUE);
    store.memberships.splice(index, 1);
    const colleague = await getContact(actor(SENDER), WS, "con_colleague" as ContactId, contactDeps);
    expect(colleague.workspaceMember).toBeNull();
  });
});

describe("creating a request", () => {
  it("delivers to a member IN-APP: a feed intent whose email is suppressed", async () => {
    const view = await createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_colleague", title: "2025 audited statements",
      message: "The signed PDF, please", dueAt: AT + 86_400_000,
    }, deps);
    expect(view).toMatchObject({
      kind: "upload", status: "pending", delivery: "in-app",
      recipient: { userId: COLLEAGUE }, requestedBy: { userId: SENDER },
      contact: { contactId: "con_colleague", email: "Colleague@Example.com" },
      workspaceName: "Acme Legal", dueAt: AT + 86_400_000,
    });
    const [intent] = intents();
    expect(intent).toMatchObject({
      notificationType: "CONTACT_REQUEST_RECEIVED",
      audience: { kind: "USER", userId: COLLEAGUE },
      source: { kind: "CONTACT_REQUEST", sourceId: view.requestId },
      templateInput: { requestTitle: "2025 audited statements", requestKind: "upload" },
    });
    // No email for a member.
    expect(deliveryOf(intent!.notificationIntentId)).toMatchObject({
      state: "SUPPRESSED", failureCode: "IN_APP_ONLY",
    });
  });

  it("emails an external contact through the CONTACT_REQUEST audience", async () => {
    const view = await createContactRequest(actor(SENDER), WS, {
      kind: "signed-document", contactId: "con_external", title: "Signed NDA", documentId: "doc_1",
    }, deps);
    expect(view).toMatchObject({ delivery: "email", recipient: null, documentTitle: "Doc doc_1" });
    const [intent] = intents();
    expect(intent).toMatchObject({
      notificationType: "CONTACT_REQUEST_EMAILED",
      audience: { kind: "CONTACT_REQUEST", contactRequestId: view.requestId },
      templateInput: {
        requestKind: "signed-document", documentTitle: "Doc doc_1",
        requesterEmail: "sender@example.com",
      },
    });
    expect(deliveryOf(intent!.notificationIntentId)).toMatchObject({
      state: "PENDING", destination: "maria@outside.example",
    });
  });

  it("refuses preparation for an external contact with a clear 422", async () => {
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "preparation", contactId: "con_external", title: "Prepare the lease", documentId: "doc_1",
    }, deps)).rejects.toBeInstanceOf(ContactRequestMembersOnlyError);
    expect(store.contactRequests).toHaveLength(0);
    expect(intents()).toHaveLength(0);
  });

  it("assigns preparation to a member who can prepare, and refuses one who cannot", async () => {
    const view = await createContactRequest(actor(SENDER), WS, {
      kind: "preparation", contactId: "con_colleague", title: "Prepare the lease", documentId: "doc_1",
    }, deps);
    expect(view).toMatchObject({ kind: "preparation", delivery: "in-app", documentId: "doc_1" });

    const refused = createContactRequest(actor(SENDER), WS, {
      kind: "preparation", contactId: "con_newcomer", title: "Prepare", documentId: "doc_1",
    }, deps);
    await expect(refused).rejects.toBeInstanceOf(ContactRequestRecipientCannotActError);
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_newcomer", title: "Upload",
    }, deps)).rejects.toMatchObject({ code: "contact_request_recipient_cannot_act" });
  });

  it("a newcomer granted assign-signers may be asked", async () => {
    const index = store.memberships.findIndex(m => m.userId === NEWCOMER);
    store.memberships[index] = { ...store.memberships[index]!, canAssignSigners: true };
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_newcomer", title: "Upload",
    }, deps)).resolves.toMatchObject({ delivery: "in-app" });
  });

  it("validates kind, title, documents and due date", async () => {
    const bad = [
      { kind: "other", contactId: "con_external", title: "x" },
      { kind: "upload", contactId: "con_external", title: "  " },
      { kind: "upload", contactId: "con_external", title: "x", documentId: "doc_1" },
      { kind: "preparation", contactId: "con_colleague", title: "x" },
      { kind: "upload", contactId: "con_external", title: "x", dueAt: AT - 1 },
      { kind: "upload", contactId: "con_external", title: "x", dueAt: Number.NaN },
    ];
    for (const input of bad) {
      await expect(createContactRequest(actor(SENDER), WS, input, deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "signed-document", contactId: "con_external", title: "x", documentId: "doc_missing",
    }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses an archived contact, someone else's personal contact, and yourself", async () => {
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_archived", title: "x",
    }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_private", title: "x",
    }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    store.contacts.push(contact("con_me", "sender@example.com"));
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_me", title: "x",
    }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("requires upload-request.create: a reviewer and a non-member are refused as not found", async () => {
    await expect(createContactRequest(actor(REVIEWER), WS, {
      kind: "upload", contactId: "con_external", title: "x",
    }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(createContactRequest(actor(SENDER), OTHER_WS, {
      kind: "upload", contactId: "con_external", title: "x",
    }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(store.contactRequests).toHaveLength(0);
  });
});

describe("the recipient's side", () => {
  async function asked(kind: "upload" | "signed-document" | "preparation" = "upload") {
    return createContactRequest(actor(SENDER), WS, {
      kind, contactId: "con_colleague", title: "Please",
      ...(kind === "upload" ? {} : { documentId: "doc_1" }),
    }, deps);
  }

  it("lists it under Others (GET /me/contact-requests), pending first", async () => {
    const first = await asked();
    const second = await asked("signed-document");
    await declineContactRequest(actor(COLLEAGUE), WS, first.requestId, {}, deps);
    const mine = await listMyReceivedContactRequests(COLLEAGUE, deps);
    expect(mine.map(r => [r.requestId, r.status])).toEqual([
      [second.requestId, "pending"], [first.requestId, "declined"],
    ]);
    expect(await listMyReceivedContactRequests(SENDER, deps)).toEqual([]);
    expect(await listMyReceivedContactRequests(COLLEAGUE, deps, { status: "pending" }))
      .toHaveLength(1);
  });

  it("completes an upload with a document the recipient uploaded, and tells the sender in-app", async () => {
    const request = await asked();
    seedDocument("doc_answer", COLLEAGUE);
    const done = await completeContactRequest(actor(COLLEAGUE), WS, request.requestId,
      { documentId: "doc_answer" }, deps);
    expect(done).toMatchObject({ status: "completed", responseDocumentId: "doc_answer" });
    const notice = intents().find(i => i.notificationType === "CONTACT_REQUEST_COMPLETED");
    expect(notice).toMatchObject({ audience: { kind: "USER", userId: SENDER } });
    expect(deliveryOf(notice!.notificationIntentId)).toMatchObject({ failureCode: "IN_APP_ONLY" });
  });

  it("refuses completion with someone else's document, with none, or twice", async () => {
    const request = await asked();
    await expect(completeContactRequest(actor(COLLEAGUE), WS, request.requestId,
      { documentId: "doc_1" }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(completeContactRequest(actor(COLLEAGUE), WS, request.requestId,
      {}, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    seedDocument("doc_answer", COLLEAGUE);
    await completeContactRequest(actor(COLLEAGUE), WS, request.requestId, { documentId: "doc_answer" }, deps);
    await expect(completeContactRequest(actor(COLLEAGUE), WS, request.requestId,
      { documentId: "doc_answer" }, deps)).rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("completes a preparation without a document", async () => {
    const request = await asked("preparation");
    await expect(completeContactRequest(actor(COLLEAGUE), WS, request.requestId,
      { documentId: "doc_1" }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(completeContactRequest(actor(COLLEAGUE), WS, request.requestId, {}, deps))
      .resolves.toMatchObject({ status: "completed", responseDocumentId: null });
  });

  it("declines with a reason, and tells the sender", async () => {
    const request = await asked();
    const declined = await declineContactRequest(actor(COLLEAGUE), WS, request.requestId,
      { reason: "Not mine to give" }, deps);
    expect(declined).toMatchObject({ status: "declined", declineReason: "Not mine to give" });
    const notice = intents().find(i => i.notificationType === "CONTACT_REQUEST_DECLINED");
    expect(notice).toMatchObject({
      audience: { kind: "USER", userId: SENDER }, templateInput: { reason: "Not mine to give" },
    });
  });

  it("only the recipient answers an in-app request", async () => {
    const request = await asked();
    seedDocument("doc_s", SENDER);
    await expect(completeContactRequest(actor(SENDER), WS, request.requestId,
      { documentId: "doc_s" }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(declineContactRequest(actor(SENDER), WS, request.requestId, {}, deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    // A member who is neither side, and cannot send requests, cannot even see it.
    await expect(getContactRequest(actor(REVIEWER), WS, request.requestId, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getContactRequest(actor(COLLEAGUE), WS, request.requestId, deps))
      .resolves.toMatchObject({ requestId: request.requestId });
  });
});

describe("the sender's side", () => {
  it("lists what they sent across workspaces, and on the contact", async () => {
    const a = await createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_external", title: "A",
    }, deps);
    const b = await createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_colleague", title: "B",
    }, deps);
    const sent = await listMySentContactRequests(SENDER, deps);
    expect(sent.map(r => r.requestId).sort()).toEqual([a.requestId, b.requestId].sort());
    const onContact = await listContactRequestsForContact(actor(SENDER), WS, "con_external", deps);
    expect(onContact.map(r => [r.requestId, r.status])).toEqual([[a.requestId, "pending"]]);
    await expect(listContactRequestsForContact(actor(REVIEWER), WS, "con_external", deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("records an emailed request's answer, and cancels", async () => {
    const emailed = await createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_external", title: "Permit",
    }, deps);
    seedDocument("doc_received", SENDER);
    await expect(completeContactRequest(actor(COLLEAGUE), WS, emailed.requestId,
      { documentId: "doc_received" }, deps)).rejects.toBeInstanceOf(ApplicationValidationError);
    const done = await completeContactRequest(actor(SENDER), WS, emailed.requestId,
      { documentId: "doc_received" }, deps);
    expect(done.status).toBe("completed");
    // Nothing to tell the sender about their own act.
    expect(intents().some(i => i.notificationType === "CONTACT_REQUEST_COMPLETED")).toBe(false);

    const other = await createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_colleague", title: "B",
    }, deps);
    await expect(cancelContactRequest(actor(COLLEAGUE), WS, other.requestId, deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(cancelContactRequest(actor(SENDER), WS, other.requestId, deps))
      .resolves.toMatchObject({ status: "cancelled" });
    await expect(declineContactRequest(actor(COLLEAGUE), WS, other.requestId, {}, deps))
      .rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("rolls back the request when its notification cannot be written", async () => {
    deps = { ...deps, templates: { ...deps.templates, validateInput: () => { throw new Error("boom"); } } };
    await expect(createContactRequest(actor(SENDER), WS, {
      kind: "upload", contactId: "con_external", title: "x",
    }, deps)).rejects.toThrow("boom");
    expect(store.contactRequests).toHaveLength(0);
  });
});
