// 087. Document sharing with fakes: owner shares (create, edit, edit-email,
// remove), the recipient's Shared with me (every transition), access
// requests (every transition), the caller-only relation, Shared by me, the
// in-app-only notices and the activity log.

import { describe, it, expect, beforeEach } from "vitest";
import type { DocumentId, UserId, VerificationId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  listDocumentShares, createDocumentShare, updateDocumentShare, removeDocumentShare,
  listAccessRequests, approveAccessRequest, rejectAccessRequest, withdrawAccessRequestRejection,
  deleteAccessRequest, removeAccessRequestAccess, listSharedByMe,
  listSharedWithMe, actOnSharedDocument, getSharedDocumentDetails, openSharedDocument,
  getSharedDocumentLogo, getMyDocumentAccess, requestDocumentAccess,
  DocumentNotCompletedError, DocumentShareExistsError, DocumentShareRecipientHasAccessError,
  SharingStateConflictError, AccountEmailUnverifiedError, DocumentAccessRequestRefusedError,
  type DocumentSharingDependencies, type SharingAccount,
} from "./document-sharing.js";
import type { DocumentAccessRequestId, DocumentShareId } from "../common/ports/document-sharing.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import { FakeTransactionManager, InMemoryStore } from "../test-support/fakes.js";
import { createInMemoryObjectStorage } from "../test-support/in-memory-object-storage.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";
import { toStorageObjectKey } from "../common/ports/storage.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const WS = "ws_share" as WorkspaceId;
const OTHER_WS = "ws_elsewhere" as WorkspaceId;
const VID = "LAGDA-VER-2026-A7bK9mQ2xZ" as VerificationId;
const OTHER_VID = "LAGDA-VER-2026-Zz9Yy8Xx7W" as VerificationId;

const SENDER = "usr_sender" as UserId;     // sent the signing request: the document's owner
const ADMIN = "usr_admin" as UserId;       // administrator: document.share.manage
const COLLEAGUE = "usr_colleague" as UserId; // another sender: no authority over it
const JUAN = "usr_juan" as UserId;         // an outsider with a verified account
const MARIA = "usr_maria" as UserId;       // a participant
const ANA = "usr_ana" as UserId;           // an outsider whose address is NOT verified
const NOBODY = "usr_nobody" as UserId;     // an outsider with no relation at all

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const ACCOUNTS: Record<string, SharingAccount> = {
  [SENDER]: { email: "sender@example.com", normalizedEmail: "sender@example.com", emailVerified: true, displayName: "Sam Sender" },
  [ADMIN]: { email: "admin@example.com", normalizedEmail: "admin@example.com", emailVerified: true, displayName: "Ada Admin" },
  [COLLEAGUE]: { email: "colleague@example.com", normalizedEmail: "colleague@example.com", emailVerified: true, displayName: "Cole" },
  [JUAN]: { email: "Juan@Example.com", normalizedEmail: "juan@example.com", emailVerified: true, displayName: "Juan Cruz" },
  [MARIA]: { email: "maria@example.com", normalizedEmail: "maria@example.com", emailVerified: true, displayName: "Maria Santos" },
  [ANA]: { email: "ana@example.com", normalizedEmail: "ana@example.com", emailVerified: false, displayName: "Ana Reyes" },
  [NOBODY]: { email: "nobody@example.com", normalizedEmail: "nobody@example.com", emailVerified: true, displayName: "No Body" },
};

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let deps: DocumentSharingDependencies;
let seq = 0;
let now = AT;

const PDF = new TextEncoder().encode("%PDF-1.7 sealed");

beforeEach(async () => {
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  seq = 0;
  now = AT;
  store.workspaces.set(WS, { workspaceId: WS, name: "Reyes Legal", createdAt: AT });
  store.workspaces.set(OTHER_WS, { workspaceId: OTHER_WS, name: "Elsewhere", createdAt: AT });
  for (const [userId, role] of [
    [SENDER, "sender"], [ADMIN, "administrator"], [COLLEAGUE, "sender"],
  ] as const) {
    store.accountEmails.set(ACCOUNTS[userId]!.normalizedEmail, userId);
    store.memberships.push({
      memberId: `mem_${userId}` as WorkspaceMemberId, workspaceId: WS, userId, role, createdAt: AT,
    });
  }
  store.memberships.push({
    memberId: "mem_other" as WorkspaceMemberId, workspaceId: OTHER_WS, userId: JUAN, role: "owner", createdAt: AT,
  });
  for (const userId of [JUAN, MARIA, NOBODY, SENDER, ADMIN, COLLEAGUE]) {
    const account = ACCOUNTS[userId]!;
    store.verifiedAccounts.set(account.normalizedEmail, { userId, displayName: account.displayName });
  }
  store.documents.push(
    { documentId: "doc_done" as DocumentId, workspaceId: WS, title: "Office Lease", originalFilename: null,
      createdByUserId: SENDER, folderId: null, createdAt: AT, updatedAt: AT },
    { documentId: "doc_draft" as DocumentId, workspaceId: WS, title: "Draft", originalFilename: null,
      createdByUserId: SENDER, folderId: null, createdAt: AT, updatedAt: AT },
  );
  store.completedDocuments.push({
    record: {
      workspaceId: WS, documentId: "doc_done" as DocumentId, signingRequestId: "txn_1",
      verificationId: VID, documentTitle: "Office Lease", completedAt: AT - 1000,
      ownerUserId: SENDER, participantCount: 2,
    },
    participantEmails: ["maria@example.com", "sender@example.com"],
    projection: {
      documentTitle: "Office Lease", completedAt: AT - 1000, sealedDigest: "b".repeat(64),
      participants: [
        { requestRecipientId: "srr_m", name: "Maria Santos", email: "maria@example.com",
          recipientType: "signer", routingOrder: 1, orderIndex: 0 },
        { requestRecipientId: "srr_s", name: "Sam Sender", email: "sender@example.com",
          recipientType: "signer", routingOrder: 2, orderIndex: 0 },
      ],
      events: [
        { eventType: "signature-completed", recipientId: "srr_m", occurredAt: AT - 3000 },
        { eventType: "signature-completed", recipientId: "srr_s", occurredAt: AT - 2000 },
        { eventType: "transaction-completed", recipientId: null, occurredAt: AT - 1000 },
      ],
    },
    documentRef: { storageReference: "ws_share/doc_done/sealed.pdf", mediaType: "application/pdf", sizeBytes: PDF.byteLength },
  });
  const storage = createInMemoryObjectStorage();
  await storage.putObject({
    ref: { zone: "artifacts", key: toStorageObjectKey("ws_share/doc_done/sealed.pdf") },
    content: { kind: "bytes", bytes: PDF }, mediaType: "application/pdf",
  });
  deps = {
    transactions,
    clock: { now: () => now },
    ids: {
      nextDocumentShareId: () => `dsh_${++seq}` as DocumentShareId,
      nextDocumentAccessRequestId: () => `dar_${++seq}` as DocumentAccessRequestId,
    },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${++seq}` as never,
      nextNotificationDeliveryId: () => `ndel_${++seq}` as never,
    },
    storage,
    currentAccount: userId => Promise.resolve(ACCOUNTS[userId] ?? null),
  };
  // The owner workspace's branding, which recipients see.
  await transactions.runForWorkspace(WS, async uow => {
    await uow.branding.saveSettings({ senderDisplayName: null, footerTagline: null, primaryColor: "#123ABC" }, AT);
    await uow.branding.saveLogo({ bytes: new Uint8Array([137, 80]), width: 10, height: 10, digest: "c".repeat(64) }, AT);
  });
});

const intents = () => [...store.notificationIntents.values()];
const deliveryOf = (intentId: string) =>
  [...store.notificationDeliveries.values()].find(d => d.notificationIntentId === intentId);
const actions = () => store.activity.map(a => a.action);

const share = (email = "juan@example.com", fullName: string | null = "Juan Cruz", by = SENDER) =>
  createDocumentShare(actor(by), WS, "doc_done", { email, fullName }, deps);

describe("owner: sharing a completed document", () => {
  it("creates a PENDING share, logs it, and tells an existing verified account in-app only", async () => {
    const created = await share("Juan@Example.com");
    expect(created).toMatchObject({
      status: "pending", email: "Juan@Example.com", fullName: "Juan Cruz", verificationId: VID,
      sharedBy: { userId: SENDER }, recipient: null, recipientDeleted: false,
    });
    const [intent] = intents();
    expect(intent).toMatchObject({
      notificationType: "DOCUMENT_SHARE_RECEIVED",
      audience: { kind: "USER", userId: JUAN },
      scope: { kind: "WORKSPACE", workspaceId: WS },
      templateInput: {
        recipientName: "Juan Cruz", documentTitle: "Office Lease", workspaceName: "Reyes Legal",
        verificationId: VID,
      },
    });
    expect(deliveryOf(intent!.notificationIntentId)).toMatchObject({ state: "SUPPRESSED", failureCode: "IN_APP_ONLY" });
    expect(actions()).toContain("document_share.created");
  });

  it("an address with no account simply waits: no notice at all", async () => {
    await share("stranger@example.com", null);
    expect(intents()).toHaveLength(0);
    const listed = await listDocumentShares(actor(SENDER), WS, "doc_done", deps);
    expect(listed.shares.map(s => s.email)).toEqual(["stranger@example.com"]);
    expect(listed.document).toMatchObject({ verificationId: VID, owner: { userId: SENDER }, participantCount: 2 });
  });

  it("refuses a participant, a duplicate live share and yourself", async () => {
    await expect(share("MARIA@example.com")).rejects.toBeInstanceOf(DocumentShareRecipientHasAccessError);
    await share();
    await expect(share(" juan@EXAMPLE.com ")).rejects.toBeInstanceOf(DocumentShareExistsError);
    await expect(createDocumentShare(actor(ADMIN), WS, "doc_done", { email: "admin@example.com" }, deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    await expect(share("not-an-email")).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("only a COMPLETED document can be shared", async () => {
    await expect(createDocumentShare(actor(SENDER), WS, "doc_draft", { email: "juan@example.com" }, deps))
      .rejects.toBeInstanceOf(DocumentNotCompletedError);
    await expect(createDocumentShare(actor(SENDER), WS, "doc_nowhere", { email: "juan@example.com" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("the sender and an administrator may share; another sender and a non-member may not", async () => {
    await expect(share("juan@example.com", null, COLLEAGUE)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(share("juan@example.com", null, JUAN)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(share("juan@example.com", null, ADMIN)).resolves.toMatchObject({ sharedBy: { userId: ADMIN } });
    await expect(listDocumentShares(actor(COLLEAGUE), WS, "doc_done", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("renames in place, and an email change ends the old share and starts a new pending one", async () => {
    const first = await share();
    const renamed = await updateDocumentShare(actor(SENDER), WS, "doc_done", first.shareId, { fullName: "J. Cruz" }, deps);
    expect(renamed).toMatchObject({ share: { shareId: first.shareId, fullName: "J. Cruz", status: "pending" }, previous: null });

    const moved = await updateDocumentShare(actor(SENDER), WS, "doc_done", first.shareId,
      { email: "nobody@example.com" }, deps);
    expect(moved.previous).toMatchObject({ shareId: first.shareId, status: "removed", removedBy: "email-changed" });
    expect(moved.share).toMatchObject({
      email: "nobody@example.com", fullName: "J. Cruz", status: "pending", replacesShareId: first.shareId,
    });
    expect(moved.share.shareId).not.toBe(first.shareId);
    // The new address's account is told; the old one keeps only its first notice.
    expect(intents().map(i => [i.notificationType, (i.audience as { userId: string }).userId])).toEqual([
      ["DOCUMENT_SHARE_RECEIVED", JUAN], ["DOCUMENT_SHARE_RECEIVED", NOBODY],
    ]);
    expect(await listSharedWithMe(JUAN, "pending", deps)).toEqual([]);
    expect(actions().filter(a => a === "document_share.updated")).toHaveLength(2);
  });

  it("an email change to a participant rolls back entirely", async () => {
    const first = await share();
    await expect(updateDocumentShare(actor(SENDER), WS, "doc_done", first.shareId,
      { email: "maria@example.com" }, deps)).rejects.toBeInstanceOf(DocumentShareRecipientHasAccessError);
    const listed = await listDocumentShares(actor(SENDER), WS, "doc_done", deps);
    expect(listed.shares.map(s => s.status)).toEqual(["pending"]);
  });

  it("the owner removes a share; a removed share cannot change again", async () => {
    const first = await share();
    const removed = await removeDocumentShare(actor(SENDER), WS, "doc_done", first.shareId, deps);
    expect(removed).toMatchObject({ status: "removed", removedBy: "owner" });
    await expect(removeDocumentShare(actor(SENDER), WS, "doc_done", first.shareId, deps))
      .rejects.toBeInstanceOf(SharingStateConflictError);
    await expect(updateDocumentShare(actor(SENDER), WS, "doc_done", first.shareId, { fullName: "x" }, deps))
      .rejects.toBeInstanceOf(SharingStateConflictError);
    // The address may be shared with again.
    await expect(share()).resolves.toMatchObject({ status: "pending" });
  });
});

describe("recipient: Shared with me", () => {
  it("lists a share by the VERIFIED address only, with the owner workspace's branding", async () => {
    const created = await share();
    const [item] = await listSharedWithMe(JUAN, "pending", deps);
    expect(item).toMatchObject({
      id: created.shareId, kind: "share", status: "pending", verificationId: VID,
      // The fake has no account names; the fallback shows.
      documentTitle: "Office Lease", owner: { displayName: "A LAGDA user" }, fullName: "Juan Cruz",
      progress: { participants: 2, completed: 2 },
      branding: { displayName: "Reyes Legal", primaryColor: "#123ABC", logo: { version: "c".repeat(64) } },
      actions: ["accept", "reject"],
    });
    // Nobody else sees it, and an unverified address sees no shares at all.
    expect(await listSharedWithMe(NOBODY, "pending", deps)).toEqual([]);
    await createDocumentShare(actor(SENDER), WS, "doc_done", { email: "ana@example.com" }, deps);
    expect(await listSharedWithMe(ANA, "pending", deps)).toEqual([]);
    expect(await listSharedWithMe(JUAN, "accepted", deps)).toEqual([]);
  });

  it("accept -> accepted, the sharer told in-app, and the document opens", async () => {
    const created = await share();
    await expect(getSharedDocumentDetails(JUAN, created.shareId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    const accepted = await actOnSharedDocument(JUAN, created.shareId, "accept", deps);
    expect(accepted).toMatchObject({ status: "accepted", actions: ["open", "remove-access"] });
    const notice = intents().find(i => i.notificationType === "DOCUMENT_SHARE_ACCEPTED");
    expect(notice).toMatchObject({
      audience: { kind: "USER", userId: SENDER },
      templateInput: { responderDisplayName: "Juan Cruz", answer: "accepted" },
    });
    expect(deliveryOf(notice!.notificationIntentId)).toMatchObject({ failureCode: "IN_APP_ONLY" });

    const details = await getSharedDocumentDetails(JUAN, created.shareId, deps);
    expect(details.participants.map(p => p.maskedEmail)).toEqual(["m•••@example.com", "s•••@example.com"]);
    const pdf = await openSharedDocument(JUAN, created.shareId, deps);
    expect(pdf).toMatchObject({ mediaType: "application/pdf", sizeBytes: PDF.byteLength });
    expect(actions()).toContain("document_share.accepted");
    // Another account cannot open it by id.
    await expect(openSharedDocument(NOBODY, created.shareId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reject -> rejected; withdraw -> pending; delete hides it; each once", async () => {
    const created = await share();
    await actOnSharedDocument(JUAN, created.shareId, "reject", deps);
    expect(intents().some(i => i.notificationType === "DOCUMENT_SHARE_REJECTED")).toBe(true);
    const [rejected] = await listSharedWithMe(JUAN, "rejected", deps);
    expect(rejected).toMatchObject({ status: "rejected", actions: ["withdraw-rejection", "delete"] });
    await expect(actOnSharedDocument(JUAN, created.shareId, "accept", deps)).rejects.toBeInstanceOf(SharingStateConflictError);

    await actOnSharedDocument(JUAN, created.shareId, "withdraw-rejection", deps);
    expect((await listSharedWithMe(JUAN, "pending", deps)).map(i => i.id)).toEqual([created.shareId]);

    await actOnSharedDocument(JUAN, created.shareId, "reject", deps);
    await actOnSharedDocument(JUAN, created.shareId, "delete", deps);
    expect(await listSharedWithMe(JUAN, "rejected", deps)).toEqual([]);
    await expect(actOnSharedDocument(JUAN, created.shareId, "withdraw-rejection", deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    // The owner keeps the history, flagged.
    const listed = await listDocumentShares(actor(SENDER), WS, "doc_done", deps);
    expect(listed.shares[0]).toMatchObject({ status: "rejected", recipientDeleted: true });
    expect(actions()).toEqual(expect.arrayContaining([
      "document_share.rejected", "document_share.rejection_withdrawn", "document_share.deleted",
    ]));
  });

  it("remove-access ends an accepted share", async () => {
    const created = await share();
    await actOnSharedDocument(JUAN, created.shareId, "accept", deps);
    expect(await actOnSharedDocument(JUAN, created.shareId, "remove-access", deps)).toBeNull();
    expect(await listSharedWithMe(JUAN, "accepted", deps)).toEqual([]);
    const listed = await listDocumentShares(actor(SENDER), WS, "doc_done", deps);
    expect(listed.shares[0]).toMatchObject({ status: "removed", removedBy: "recipient" });
  });

  it("serves the owner workspace's logo to a recipient of a visible share only", async () => {
    const created = await share();
    const logo = await getSharedDocumentLogo(JUAN, created.shareId, deps);
    expect(logo).toMatchObject({ mediaType: "image/png", digest: "c".repeat(64) });
    await expect(getSharedDocumentLogo(NOBODY, created.shareId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("access requests", () => {
  const ask = (userId: UserId, note: string | null = "I am the tenant") =>
    requestDocumentAccess(userId, VID, { note }, deps);

  it("needs a verified address and a completed reference", async () => {
    await expect(ask(ANA)).rejects.toBeInstanceOf(AccountEmailUnverifiedError);
    await expect(requestDocumentAccess(JUAN, OTHER_VID, {}, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(requestDocumentAccess(JUAN, "garbage", {}, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(ask(JUAN, "x".repeat(501))).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("creates a pending request, logs it, and tells the OWNER only, in-app", async () => {
    const request = await ask(JUAN);
    expect(request).toMatchObject({ status: "pending", verificationId: VID, note: "I am the tenant" });
    expect(intents().map(i => [i.notificationType, (i.audience as { userId: string }).userId]))
      .toEqual([["DOCUMENT_ACCESS_REQUESTED", SENDER]]);
    expect(intents()[0]).toMatchObject({
      templateInput: { requesterDisplayName: "Juan Cruz", requesterEmail: "juan@example.com", note: "I am the tenant" },
    });
    expect(actions()).toContain("access_request.submitted");
    await expect(ask(JUAN)).rejects.toMatchObject({ code: "document_access_request_pending" });
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({
      relation: "request-pending", requestId: request.requestId, canRequestAccess: false,
    });
  });

  it("refuses somebody who already has access or a pending share", async () => {
    await expect(ask(MARIA)).rejects.toMatchObject({ code: "document_access_already_granted" });
    await expect(ask(SENDER)).rejects.toMatchObject({ code: "document_access_already_granted" });
    await expect(ask(ADMIN)).rejects.toMatchObject({ code: "document_access_already_granted" });
    await share();
    await expect(ask(JUAN)).rejects.toBeInstanceOf(DocumentAccessRequestRefusedError);
    await expect(ask(JUAN)).rejects.toMatchObject({ code: "document_share_pending" });
  });

  it("approve -> the requester sees it as Accepted and can open it; the owner can remove it", async () => {
    const request = await ask(JUAN);
    const approved = await approveAccessRequest(actor(SENDER), WS, request.requestId, deps);
    expect(approved).toMatchObject({ status: "approved", decidedBy: { userId: SENDER } });
    expect(intents().find(i => i.notificationType === "DOCUMENT_ACCESS_APPROVED"))
      .toMatchObject({ audience: { kind: "USER", userId: JUAN }, templateInput: { decision: "approved" } });

    const [item] = await listSharedWithMe(JUAN, "accepted", deps);
    expect(item).toMatchObject({ id: request.requestId, kind: "access-request", status: "accepted", note: "I am the tenant" });
    await expect(openSharedDocument(JUAN, request.requestId, deps)).resolves.toMatchObject({ mediaType: "application/pdf" });
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "shared-accepted", requestId: request.requestId });

    await removeAccessRequestAccess(actor(ADMIN), WS, request.requestId, deps);
    await expect(openSharedDocument(JUAN, request.requestId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reject -> withdraw-rejection -> reject -> delete, and a deleted rejection may be asked again", async () => {
    const request = await ask(JUAN);
    await rejectAccessRequest(actor(SENDER), WS, request.requestId, deps);
    expect(intents().some(i => i.notificationType === "DOCUMENT_ACCESS_REJECTED")).toBe(true);
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "request-rejected" });
    await expect(ask(JUAN)).rejects.toMatchObject({ code: "document_access_request_rejected" });
    await expect(approveAccessRequest(actor(SENDER), WS, request.requestId, deps))
      .rejects.toBeInstanceOf(SharingStateConflictError);

    await withdrawAccessRequestRejection(actor(SENDER), WS, request.requestId, deps);
    expect((await listAccessRequests(actor(SENDER), WS, { status: "pending" }, deps)).map(r => r.requestId))
      .toEqual([request.requestId]);
    await rejectAccessRequest(actor(SENDER), WS, request.requestId, deps);
    await deleteAccessRequest(actor(SENDER), WS, request.requestId, deps);
    expect(await listAccessRequests(actor(SENDER), WS, {}, deps)).toEqual([]);
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "none", canRequestAccess: true });
    await expect(ask(JUAN)).resolves.toMatchObject({ status: "pending" });
    expect(actions()).toEqual(expect.arrayContaining([
      "access_request.rejected", "access_request.rejection_withdrawn", "access_request.deleted",
    ]));
  });

  it("the owner and administrators see requests; another sender sees none and cannot decide", async () => {
    const request = await ask(JUAN);
    expect(await listAccessRequests(actor(SENDER), WS, {}, deps)).toHaveLength(1);
    expect(await listAccessRequests(actor(ADMIN), WS, {}, deps)).toHaveLength(1);
    expect(await listAccessRequests(actor(COLLEAGUE), WS, {}, deps)).toEqual([]);
    await expect(approveAccessRequest(actor(COLLEAGUE), WS, request.requestId, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("the requester removes their own approved access", async () => {
    const request = await ask(JUAN);
    await approveAccessRequest(actor(SENDER), WS, request.requestId, deps);
    expect(await actOnSharedDocument(JUAN, request.requestId, "remove-access", deps)).toBeNull();
    await expect(actOnSharedDocument(JUAN, request.requestId, "accept", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "none" });
  });
});

describe("my-access: about the caller only", () => {
  it("names owner, admin, participant, shared and none", async () => {
    expect(await getMyDocumentAccess(SENDER, VID, deps)).toMatchObject({ relation: "owner" });
    expect(await getMyDocumentAccess(ADMIN, VID, deps)).toMatchObject({ relation: "admin" });
    expect(await getMyDocumentAccess(MARIA, VID, deps)).toMatchObject({ relation: "participant" });
    expect(await getMyDocumentAccess(COLLEAGUE, VID, deps)).toMatchObject({ relation: "none", canRequestAccess: true });
    expect(await getMyDocumentAccess(ANA, VID, deps)).toMatchObject({ relation: "none", canRequestAccess: false });
    const created = await share();
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "shared-pending", shareId: created.shareId });
    await actOnSharedDocument(JUAN, created.shareId, "reject", deps);
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "shared-rejected" });
    await actOnSharedDocument(JUAN, created.shareId, "withdraw-rejection", deps);
    await actOnSharedDocument(JUAN, created.shareId, "accept", deps);
    expect(await getMyDocumentAccess(JUAN, VID, deps)).toMatchObject({ relation: "shared-accepted" });
    // An unknown or malformed reference is simply none.
    expect(await getMyDocumentAccess(JUAN, OTHER_VID, deps)).toMatchObject({ relation: "none", canRequestAccess: false });
    expect(await getMyDocumentAccess(JUAN, "nope", deps)).toMatchObject({ relation: "none" });
  });
});

describe("Shared by me", () => {
  it("lists documents with an accepted share or approved request, with counts", async () => {
    const first = await share();
    await share("nobody@example.com", null);
    expect(await listSharedByMe(actor(SENDER), WS, {}, deps)).toEqual([]);
    await actOnSharedDocument(JUAN, first.shareId, "accept", deps);
    const request = await requestDocumentAccess(COLLEAGUE, VID, {}, deps);
    await approveAccessRequest(actor(ADMIN), WS, request.requestId, deps);

    const [item] = await listSharedByMe(actor(SENDER), WS, {}, deps);
    expect(item).toMatchObject({
      document: { verificationId: VID, documentTitle: "Office Lease" },
      acceptedShares: 1, pendingShares: 1, rejectedShares: 0, approvedRequests: 1, pendingRequests: 0,
    });
    // Mine means documents I sent; the workspace-wide view is for administrators.
    expect(await listSharedByMe(actor(ADMIN), WS, {}, deps)).toEqual([]);
    expect(await listSharedByMe(actor(ADMIN), WS, { scope: "workspace" }, deps)).toHaveLength(1);
    await expect(listSharedByMe(actor(COLLEAGUE), WS, { scope: "workspace" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("a failure rolls the whole transition back", () => {
  it("leaves no share and no notice when the notice cannot be created", async () => {
    deps = { ...deps, templates: { ...deps.templates, validateInput: () => { throw new Error("boom"); } } };
    await expect(share()).rejects.toThrow("boom");
    expect(store.documentShares).toEqual([]);
    expect(intents()).toEqual([]);
    now = AT;
  });
});
