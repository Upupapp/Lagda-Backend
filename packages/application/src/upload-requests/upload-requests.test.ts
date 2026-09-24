// Asking a member to supply a document (067).
//
// The claims that carry weight here:
//
//   CONTACT IN, MEMBER OUT. A requester picks an address-book entry; what
//   gets stored is the USER that entry's address resolves to. A contact whose
//   address belongs to nobody in the workspace is REFUSED — storing it would
//   create a request nobody can act on and mail somebody who cannot sign in.
//
//   THE REQUEST AND ITS NOTIFICATION ARE ONE DECISION. A stored request with
//   no notification is a silent assignment; both are written in the same
//   transaction, and a refusal writes neither.
//
//   THE TRANSITIONS ARE GUARDED. Only the assignee may fulfil, only a pending
//   request may be fulfilled or cancelled, and a second attempt conflicts
//   rather than overwriting the first answer.

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceMemberId, DocumentId, ContactId,
} from "@lagda/contracts";
import {
  createUploadRequest, listUploadRequests, cancelUploadRequest,
  fulfilUploadRequest, UploadRequestAssigneeNotAMemberError,
  type UploadRequestDependencies,
} from "./upload-requests.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ResourceNotFoundError, ResourceConflictError, ApplicationValidationError,
} from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ContactRecord } from "../common/ports/contacts.js";
import type { UploadRequestId } from "../common/ports/upload-requests.js";
import type {
  NotificationIntentId, NotificationDeliveryId,
} from "../common/ports/notifications.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-24T09:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const ASSIGNEE = "usr_assignee" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

/** A contact whose address DOES belong to a member. */
const MEMBER_CONTACT = "cnt_member" as ContactId;
/** A contact whose address belongs to nobody — the refusal case. */
const OUTSIDER_CONTACT = "cnt_outsider" as ContactId;

const DOC = "doc_uploaded" as DocumentId;

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: UploadRequestDependencies;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  // The assignee: a real member whose ACCOUNT carries the address the
  // contact below names. Both halves matter — `findByNormalizedEmail` joins
  // the account email to the membership, and either missing means "not a
  // member".
  store.memberships.push({
    memberId: "mem_assignee" as WorkspaceMemberId,
    workspaceId: created.workspaceId,
    userId: ASSIGNEE, role: "sender", createdAt: AT + 1000,
  });
  store.accountEmails.set("maria@acme.test", ASSIGNEE);

  store.contacts.push({
    contactId: MEMBER_CONTACT, workspaceId: created.workspaceId,
    name: "Maria Santos", email: "maria@acme.test",
    emailKey: "maria@acme.test" as ContactRecord["emailKey"],
    phone: null, organization: null, title: null,
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });
  // Same workspace, but nobody holds this address.
  store.contacts.push({
    contactId: OUTSIDER_CONTACT, workspaceId: created.workspaceId,
    name: "External Auditor", email: "auditor@elsewhere.test",
    emailKey: "auditor@elsewhere.test" as ContactRecord["emailKey"],
    phone: null, organization: null, title: null,
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });

  // The document an assignee uploads through the ordinary path before
  // answering the request — this use case never admits bytes itself.
  store.documents.push({
    documentId: DOC, workspaceId: created.workspaceId, title: "Signed contract",
    originalFilename: "contract.pdf", createdByUserId: ASSIGNEE,
    createdAt: AT, updatedAt: AT, folderId: null,
  });

  let requestCounter = 0;
  const deps: UploadRequestDependencies = {
    transactions, clock,
    ids: { nextUploadRequestId: () => `ur_${String(++requestCounter)}` as UploadRequestId },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${String(requestCounter)}` as NotificationIntentId,
      nextNotificationDeliveryId: () => `ndel_${String(requestCounter)}` as NotificationDeliveryId,
    },
  };

  return { store, workspaceId: created.workspaceId, deps };
}

describe("creating an upload request", () => {
  it("stores the resolved MEMBER, keeping the contact only as provenance", async () => {
    const h = await harness();

    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", note: "The 2026 one, PDF please.", contactId: MEMBER_CONTACT },
      h.deps);

    expect(request.assigneeUserId).toBe(ASSIGNEE);
    expect(request.assigneeContactId).toBe(MEMBER_CONTACT);
    expect(request.requestedByUserId).toBe(OWNER);
    expect(request.status).toBe("pending");
    // A pending request answers nothing yet — the CHECK biconditional in 067
    // enforces the same thing in the database.
    expect(request.documentId).toBeNull();
    expect(request.note).toBe("The 2026 one, PDF please.");
  });

  it("notifies the assignee in the SAME transaction", async () => {
    const h = await harness();

    await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT },
      h.deps);

    const intents = [...h.store.notificationIntents.values()];
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.notificationType).toBe("DOCUMENT_UPLOAD_REQUESTED");
    // Addressed to the ACCOUNT, delivered to the address the requester picked.
    expect(intent.audience).toEqual({ kind: "USER", userId: ASSIGNEE });
    // Carries no credential: the assignee signs in as themselves.
    expect(intent.secretRef ?? null).toBeNull();
    // What the assignee will actually read — the requester's own words,
    // frozen into the intent rather than re-read at send time.
    expect(intent.templateInput).toMatchObject({
      recipientName: "Maria Santos",
      requestTitle: "Your signed contract",
    });

    // The ADDRESS lives on the delivery, not the intent: it is a snapshot
    // frozen at creation and never re-read from the contact at send time.
    const deliveries = [...h.store.notificationDeliveries.values()];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.destination).toBe("maria@acme.test");
  });

  it("REFUSES a contact whose address belongs to no member, writing nothing", async () => {
    const h = await harness();

    await expect(createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "The audit letter", contactId: OUTSIDER_CONTACT },
      h.deps,
    )).rejects.toBeInstanceOf(UploadRequestAssigneeNotAMemberError);

    // Neither half of the decision happened.
    expect(h.store.uploadRequests).toHaveLength(0);
    expect(h.store.notificationIntents.size).toBe(0);
  });

  it("404s a contact that does not exist", async () => {
    const h = await harness();
    await expect(createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Anything", contactId: "cnt_missing" },
      h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses a blank title before touching anything", async () => {
    const h = await harness();
    await expect(createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "   ", contactId: MEMBER_CONTACT },
      h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
    expect(h.store.uploadRequests).toHaveLength(0);
  });
});

describe("listing", () => {
  it("narrows to what is being asked of the caller", async () => {
    const h = await harness();
    await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "For Maria", contactId: MEMBER_CONTACT }, h.deps);

    const mine = await listUploadRequests(
      actor(ASSIGNEE), h.workspaceId, { assignedToMe: true }, h.deps);
    expect(mine).toHaveLength(1);

    // The OWNER asked for it; nothing is being asked of them.
    const theirs = await listUploadRequests(
      actor(OWNER), h.workspaceId, { assignedToMe: true }, h.deps);
    expect(theirs).toHaveLength(0);
  });
});

describe("fulfilling", () => {
  it("records the document that answered it", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT }, h.deps);

    const fulfilled = await fulfilUploadRequest(
      actor(ASSIGNEE), h.workspaceId, request.requestId, { documentId: DOC }, h.deps);

    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.documentId).toBe(DOC);
    expect(fulfilled.fulfilledAt).toBe(AT);
  });

  it("refuses anyone other than the assignee", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT }, h.deps);

    // The requester cannot answer their own request on the assignee's
    // behalf — the record would then say something untrue about who
    // supplied the document.
    await expect(fulfilUploadRequest(
      actor(OWNER), h.workspaceId, request.requestId, { documentId: DOC }, h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("CONFLICTS on a second fulfilment rather than overwriting the first", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT }, h.deps);

    await fulfilUploadRequest(
      actor(ASSIGNEE), h.workspaceId, request.requestId, { documentId: DOC }, h.deps);

    await expect(fulfilUploadRequest(
      actor(ASSIGNEE), h.workspaceId, request.requestId, { documentId: DOC }, h.deps,
    )).rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("404s a document that is not in this workspace", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT }, h.deps);

    await expect(fulfilUploadRequest(
      actor(ASSIGNEE), h.workspaceId, request.requestId,
      { documentId: "doc_elsewhere" as DocumentId }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("cancelling", () => {
  it("cancels a pending request", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Never mind", contactId: MEMBER_CONTACT }, h.deps);

    const cancelled = await cancelUploadRequest(
      actor(OWNER), h.workspaceId, request.requestId, h.deps);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe(AT);
  });

  it("CONFLICTS on a request that was already fulfilled", async () => {
    const h = await harness();
    const request = await createUploadRequest(
      actor(OWNER), h.workspaceId,
      { title: "Your signed contract", contactId: MEMBER_CONTACT }, h.deps);
    await fulfilUploadRequest(
      actor(ASSIGNEE), h.workspaceId, request.requestId, { documentId: DOC }, h.deps);

    await expect(cancelUploadRequest(
      actor(OWNER), h.workspaceId, request.requestId, h.deps,
    )).rejects.toBeInstanceOf(ResourceConflictError);
  });
});
