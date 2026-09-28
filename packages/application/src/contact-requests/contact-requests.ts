// Contact requests (086): asking a contact for a signed copy, an upload, or
// (members only) a document's preparation.
//
// ── Delivery ───────────────────────────────────────────────────────────────
//
// The contact's address is matched against the CURRENT member directory at
// creation (see `contact-membership.ts`):
//
//   member    -> NO email. The request is in their Documents ("Others",
//                `GET /me/contact-requests`) and their notification feed
//                (`/me/notifications`, CONTACT_REQUEST_RECEIVED — an intent
//                whose email delivery is suppressed as IN_APP_ONLY).
//   external  -> an email (CONTACT_REQUEST_EMAILED), as upload requests do.
//
// `preparation` is refused for an external contact: preparing a document is
// workspace work and needs a workspace account.
//
// ── Capabilities ───────────────────────────────────────────────────────────
//
// Sending needs `upload-request.create` — the capability 078 split out so the
// "Request documents from others" privilege grants exactly this. A member
// recipient must be ABLE to answer, checked when the request is made so no
// request is stored that its recipient cannot complete (067's rule): the
// upload kinds need `document.create` (the ordinary upload path), preparation
// needs `document.prepare`. The privileges model grants per member, not per
// document, so there is no narrower grant to hand out here.
//
// ── The notification is written in the request's own transaction ─────────
//
// Same reasoning as 067: a request with no notice is a silent assignment, and
// the logical-key index makes the pair idempotent.

import type { WorkspaceId, DocumentId, ContactId, UserId } from "@lagda/contracts";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type {
  ContactRequestIdGenerator, ContactRequestRecord, ContactRequestKind,
  ContactRequestStatus, ContactRequestDelivery,
} from "../common/ports/contact-requests.js";
import { CONTACT_REQUEST_KINDS } from "../common/ports/contact-requests.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import { authorize } from "../signing-requests/signing-requests.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError, ResourceConflictError,
} from "../common/errors/index.js";
import { accessCapabilities } from "../workspaces/workspace-access.js";
import {
  memberDirectoryByEmail, memberForAddress, memberHolds,
  type ResolvedWorkspaceMember,
} from "./contact-membership.js";

const MAX_TITLE = 200;
const MAX_MESSAGE = 2000;
const MAX_REASON = 500;
const MAX_DISPLAY_NAME = 200;
const UNKNOWN_PERSON = "A colleague";
const UNKNOWN_WORKSPACE = "your LAGDA workspace";

function bounded(value: string | null | undefined, fallback: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ── Errors ────────────────────────────────────────────────────────────────

/** 422 `contact_request_members_only`: preparation asked of a non-member. */
export class ContactRequestMembersOnlyError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "contact_request_members_only";
  readonly details = [{
    field: "contactId", code: "members_only",
    message: "Only a member of this workspace can be assigned to prepare a document.",
  }];

  constructor() {
    super("Preparation can only be assigned to a member of this workspace. "
      + "Invite this contact first, or ask them for an upload instead.");
  }
}

/** 422 `contact_request_recipient_cannot_act`: the member lacks the capability to answer. */
export class ContactRequestRecipientCannotActError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "contact_request_recipient_cannot_act";
  readonly details: readonly { field: string; code: string; message: string }[];

  constructor(needed: "document.create" | "document.prepare") {
    const what = needed === "document.prepare" ? "prepare documents" : "upload documents";
    super(`This member cannot ${what} in this workspace yet. `
      + "Give them a role or privilege that allows it, then send the request again.");
    this.details = [{ field: "contactId", code: `missing_${needed.replace(".", "_")}`, message: this.message }];
  }
}

// ── Views ─────────────────────────────────────────────────────────────────

export interface ContactRequestView {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly kind: ContactRequestKind;
  readonly status: ContactRequestStatus;
  readonly title: string;
  readonly message: string | null;
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly dueAt: number | null;
  readonly contact: { readonly contactId: string; readonly name: string; readonly email: string };
  readonly delivery: ContactRequestDelivery;
  readonly recipient: { readonly userId: string; readonly displayName: string } | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string };
  readonly responseDocumentId: string | null;
  readonly declineReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly declinedAt: number | null;
  readonly cancelledAt: number | null;
}

async function present(
  uow: WorkspaceUnitOfWork,
  records: readonly ContactRequestRecord[],
): Promise<ContactRequestView[]> {
  if (records.length === 0) return [];
  const workspace = await uow.workspaces.find();
  const names = new Map<string, string>();
  const titles = new Map<string, string | null>();
  const nameOf = async (userId: string): Promise<string> => {
    const known = names.get(userId);
    if (known !== undefined) return known;
    const name = bounded(await uow.actorProfiles.displayNameOf(userId as UserId), UNKNOWN_PERSON, MAX_DISPLAY_NAME);
    names.set(userId, name);
    return name;
  };
  const titleOf = async (documentId: string | null): Promise<string | null> => {
    if (documentId === null) return null;
    if (titles.has(documentId)) return titles.get(documentId) ?? null;
    const document = await uow.documents.findById(documentId as DocumentId);
    titles.set(documentId, document?.title ?? null);
    return document?.title ?? null;
  };

  const views: ContactRequestView[] = [];
  for (const record of records) {
    views.push({
      requestId: record.requestId,
      workspaceId: record.workspaceId,
      workspaceName: bounded(workspace?.name, UNKNOWN_WORKSPACE, MAX_DISPLAY_NAME),
      kind: record.kind,
      status: record.status,
      title: record.title,
      message: record.message,
      documentId: record.documentId,
      documentTitle: await titleOf(record.documentId),
      dueAt: record.dueAt,
      contact: {
        contactId: record.contactId, name: record.recipientName, email: record.recipientEmail,
      },
      delivery: record.delivery,
      recipient: record.recipientUserId === null
        ? null
        : { userId: record.recipientUserId, displayName: await nameOf(record.recipientUserId) },
      requestedBy: {
        userId: record.requestedByUserId, displayName: await nameOf(record.requestedByUserId),
      },
      responseDocumentId: record.responseDocumentId,
      declineReason: record.declineReason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      declinedAt: record.declinedAt,
      cancelledAt: record.cancelledAt,
    });
  }
  return views;
}

async function presentOne(uow: WorkspaceUnitOfWork, record: ContactRequestRecord): Promise<ContactRequestView> {
  const [view] = await present(uow, [record]);
  if (view === undefined) throw new ResourceNotFoundError("ContactRequest");
  return view;
}

// ── Dependencies ──────────────────────────────────────────────────────────

export interface ContactRequestDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: ContactRequestIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
}

function notifier(uow: WorkspaceUnitOfWork, deps: ContactRequestDependencies) {
  return createNotificationIntent({
    notifications: uow.notifications,
    templates: deps.templates,
    ids: deps.notificationIds,
    clock: deps.clock,
  });
}

// ── Create ────────────────────────────────────────────────────────────────

export interface CreateContactRequestInput {
  readonly kind: string;
  readonly contactId: string;
  readonly title: string;
  readonly message?: string | null;
  readonly documentId?: string | null;
  /** Epoch milliseconds. */
  readonly dueAt?: number | null;
}

function validateCreate(input: CreateContactRequestInput, now: number): {
  kind: ContactRequestKind; title: string; message: string | null;
  documentId: DocumentId | null; dueAt: number | null;
} {
  const issues: string[] = [];
  const kind = (CONTACT_REQUEST_KINDS as readonly string[]).includes(input.kind)
    ? input.kind as ContactRequestKind : null;
  if (kind === null) issues.push(`kind: must be one of ${CONTACT_REQUEST_KINDS.join(", ")}`);
  const title = input.title.trim();
  if (title === "") issues.push("title: is required");
  if (title.length > MAX_TITLE) issues.push(`title: must be ${String(MAX_TITLE)} characters or fewer`);
  const message = (input.message ?? "").trim();
  if (message.length > MAX_MESSAGE) issues.push(`message: must be ${String(MAX_MESSAGE)} characters or fewer`);
  const documentId = (input.documentId ?? "").trim();
  if (kind === "preparation" && documentId === "") {
    issues.push("documentId: is required for a preparation request");
  }
  if (kind === "upload" && documentId !== "") {
    issues.push("documentId: an upload request asks for a document that does not exist yet");
  }
  const dueAt = input.dueAt ?? null;
  if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt <= now)) {
    issues.push("dueAt: must be in the future");
  }
  if (issues.length > 0 || kind === null) {
    throw new ApplicationValidationError("This request could not be created.", issues);
  }
  return {
    kind, title, message: message === "" ? null : message,
    documentId: documentId === "" ? null : documentId as DocumentId, dueAt,
  };
}

export async function createContactRequest(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: CreateContactRequestInput,
  deps: ContactRequestDependencies,
): Promise<ContactRequestView> {
  const now = deps.clock.now();
  const fields = validateCreate(input, now);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "upload-request.create");

    const contact = await uow.contacts.findById(input.contactId as ContactId);
    // Somebody else's personal contact is the same "not found" (074).
    if (contact === null
      || ((contact.scope ?? "workspace") === "personal" && contact.ownerUserId !== actor.userId)) {
      throw new ResourceNotFoundError("Contact");
    }
    if (contact.archivedAt !== null) {
      throw new ApplicationValidationError("This request could not be created.",
        ["contactId: an archived contact cannot be sent a request; restore it first"]);
    }

    let documentTitle: string | null = null;
    if (fields.documentId !== null) {
      const document = await uow.documents.findById(fields.documentId);
      if (document === null) throw new ResourceNotFoundError("Document");
      documentTitle = document.title;
    }

    const directory = await memberDirectoryByEmail(uow);
    const member = memberForAddress(directory, contact.email);

    if (member === null && fields.kind === "preparation") {
      throw new ContactRequestMembersOnlyError();
    }
    if (member !== null) {
      if (member.userId === actor.userId) {
        throw new ApplicationValidationError("This request could not be created.",
          ["contactId: you cannot send a request to yourself"]);
      }
      const needed = fields.kind === "preparation" ? "document.prepare" : "document.create";
      if (!memberHolds(member, needed)) throw new ContactRequestRecipientCannotActError(needed);
    }

    const requestId = deps.ids.nextContactRequestId();
    const delivery: ContactRequestDelivery = member === null ? "email" : "in-app";
    await uow.contactRequests.insert({
      requestId,
      workspaceId,
      kind: fields.kind,
      contactId: contact.contactId,
      recipientName: contact.name,
      recipientEmail: contact.email,
      delivery,
      recipientUserId: member?.userId ?? null,
      title: fields.title,
      message: fields.message,
      documentId: fields.documentId,
      dueAt: fields.dueAt,
      requestedByUserId: actor.userId,
      createdAt: now,
    });

    const [requesterName, workspace] = await Promise.all([
      uow.actorProfiles.displayNameOf(actor.userId),
      uow.workspaces.find(),
    ]);
    const common = {
      requestTitle: fields.title,
      requestKind: fields.kind,
      requesterDisplayName: bounded(requesterName, UNKNOWN_PERSON, MAX_DISPLAY_NAME),
      workspaceName: bounded(workspace?.name, UNKNOWN_WORKSPACE, MAX_DISPLAY_NAME),
      ...(fields.message === null ? {} : { message: fields.message }),
      ...(documentTitle === null ? {} : { documentTitle: bounded(documentTitle, "a document", 300) }),
      ...(fields.dueAt === null ? {} : { dueAt: new Date(fields.dueAt).toISOString() }),
    };

    if (member !== null) {
      await notifier(uow, deps)({
        notificationType: "CONTACT_REQUEST_RECEIVED",
        sourceId: requestId,
        scope: { kind: "WORKSPACE", workspaceId },
        audience: { kind: "USER", userId: member.userId },
        // Never sent: the policy suppresses the email as IN_APP_ONLY.
        destination: member.email,
        templateInput: {
          recipientName: bounded(member.displayName, "there", MAX_DISPLAY_NAME), ...common,
        },
      }, uow);
    } else {
      const requester = directory.size === 0 ? null
        : [...directory.values()].find(m => m.userId === actor.userId) ?? null;
      await notifier(uow, deps)({
        notificationType: "CONTACT_REQUEST_EMAILED",
        sourceId: requestId,
        scope: { kind: "WORKSPACE", workspaceId },
        audience: { kind: "CONTACT_REQUEST", contactRequestId: requestId },
        // The contact's own address, snapshotted on the request row.
        destination: contact.email,
        templateInput: {
          recipientName: bounded(contact.name, "there", MAX_DISPLAY_NAME),
          ...common,
          ...(requester === null ? {} : { requesterEmail: requester.email }),
        },
      }, uow);
    }

    const created = await uow.contactRequests.find(requestId);
    if (created === null) throw new ResourceNotFoundError("ContactRequest");
    return presentOne(uow, created);
  });
}

// ── Read ──────────────────────────────────────────────────────────────────

/** A request is visible to its requester, its recipient, and senders of requests. */
async function visibleRequest(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, requestId: string,
): Promise<{ record: ContactRequestRecord; canManage: boolean }> {
  const access = await authorize(uow, actor, "workspace.view");
  const record = await uow.contactRequests.find(requestId);
  if (record === null) throw new ResourceNotFoundError("ContactRequest");
  const canManage = accessCapabilities(access).includes("upload-request.create");
  if (record.requestedByUserId !== actor.userId
    && record.recipientUserId !== actor.userId && !canManage) {
    throw new ResourceNotFoundError("ContactRequest");
  }
  return { record, canManage };
}

export async function getContactRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  deps: Pick<ContactRequestDependencies, "transactions">,
): Promise<ContactRequestView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const { record } = await visibleRequest(uow, actor, requestId);
    return presentOne(uow, record);
  });
}

/** The requests sent to one contact — its status on the contact page. */
export async function listContactRequestsForContact(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, contactId: string,
  deps: Pick<ContactRequestDependencies, "transactions">,
): Promise<readonly ContactRequestView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "upload-request.create");
    const contact = await uow.contacts.findById(contactId as ContactId);
    if (contact === null
      || ((contact.scope ?? "workspace") === "personal" && contact.ownerUserId !== actor.userId)) {
      throw new ResourceNotFoundError("Contact");
    }
    return present(uow, await uow.contactRequests.list({ contactId: contact.contactId }));
  });
}

/** Pending first, then newest first. */
function inboxOrder(a: ContactRequestView, b: ContactRequestView): number {
  const pa = a.status === "pending" ? 0 : 1;
  const pb = b.status === "pending" ? 0 : 1;
  return pa - pb || b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId);
}

async function acrossMyWorkspaces(
  userId: UserId,
  deps: Pick<ContactRequestDependencies, "transactions">,
  filter: (uow: WorkspaceUnitOfWork) => Promise<readonly ContactRequestRecord[]>,
): Promise<ContactRequestView[]> {
  const workspaces = await deps.transactions.runForUser(userId, uow => uow.memberships.listWorkspaces());
  const all: ContactRequestView[] = [];
  for (const workspace of workspaces) {
    const views = await deps.transactions.runForWorkspace(
      workspace.workspaceId, async uow => {
        // Still a member NOW, read inside the transaction.
        if (await uow.memberships.findByUser(userId) === null) return [];
        return present(uow, await filter(uow));
      });
    all.push(...views);
  }
  return all.sort(inboxOrder);
}

/** "Others" in Documents: what has been asked of ME, from every workspace. */
export async function listMyReceivedContactRequests(
  userId: UserId,
  deps: Pick<ContactRequestDependencies, "transactions">,
  filter: { readonly status?: ContactRequestStatus } = {},
): Promise<readonly ContactRequestView[]> {
  return acrossMyWorkspaces(userId, deps, uow => uow.contactRequests.list({
    recipientUserId: userId, ...(filter.status === undefined ? {} : { status: filter.status }),
  }));
}

/** "Requests you sent", from every workspace. */
export async function listMySentContactRequests(
  userId: UserId,
  deps: Pick<ContactRequestDependencies, "transactions">,
  filter: { readonly status?: ContactRequestStatus } = {},
): Promise<readonly ContactRequestView[]> {
  return acrossMyWorkspaces(userId, deps, uow => uow.contactRequests.list({
    requestedByUserId: userId, ...(filter.status === undefined ? {} : { status: filter.status }),
  }));
}

// ── Answer ────────────────────────────────────────────────────────────────

function mustBePending(record: ContactRequestRecord, verb: string): void {
  if (record.status !== "pending") {
    throw new ResourceConflictError(`This request is already ${record.status} and cannot be ${verb}.`);
  }
}

async function notifyRequester(
  uow: WorkspaceUnitOfWork,
  deps: ContactRequestDependencies,
  record: ContactRequestRecord,
  type: "CONTACT_REQUEST_COMPLETED" | "CONTACT_REQUEST_DECLINED",
  actorUserId: UserId,
): Promise<void> {
  // Nothing to tell someone who recorded the outcome themselves, and nobody
  // to tell once the requester has left the workspace.
  if (record.requestedByUserId === actorUserId) return;
  const directory = await memberDirectoryByEmail(uow);
  let requester: ResolvedWorkspaceMember | null = null;
  for (const member of directory.values()) {
    if (member.userId === record.requestedByUserId) requester = member;
  }
  if (requester === null) return;
  const [actorName, workspace] = await Promise.all([
    uow.actorProfiles.displayNameOf(actorUserId),
    uow.workspaces.find(),
  ]);
  await notifier(uow, deps)({
    notificationType: type,
    sourceId: record.requestId,
    scope: { kind: "WORKSPACE", workspaceId: record.workspaceId },
    audience: { kind: "USER", userId: requester.userId },
    destination: requester.email,
    templateInput: {
      recipientName: bounded(requester.displayName, "there", MAX_DISPLAY_NAME),
      responderDisplayName: bounded(actorName, UNKNOWN_PERSON, MAX_DISPLAY_NAME),
      requestTitle: record.title,
      requestKind: record.kind,
      workspaceName: bounded(workspace?.name, UNKNOWN_WORKSPACE, MAX_DISPLAY_NAME),
      ...(type === "CONTACT_REQUEST_DECLINED" && record.declineReason !== null
        ? { reason: record.declineReason } : {}),
    },
  }, uow);
}

export interface CompleteContactRequestInput {
  /** The uploaded document answering an upload or signed-document request. */
  readonly documentId?: string | null;
}

/**
 * Completes a pending request.
 *
 *   in-app  only the RECIPIENT. Upload kinds name the document they uploaded
 *           through the ordinary create/upload path (it must be theirs);
 *           preparation needs `document.prepare` still held.
 *   email   only the REQUESTER, recording what the contact sent them — an
 *           upload kind names the document the requester uploaded.
 */
export async function completeContactRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  input: CompleteContactRequestInput, deps: ContactRequestDependencies,
): Promise<ContactRequestView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const { record, canManage } = await visibleRequest(uow, actor, requestId);

    if (record.delivery === "in-app") {
      if (record.recipientUserId !== actor.userId) {
        throw new ApplicationValidationError("This request could not be completed.",
          ["actor: only the member it was sent to can complete it"]);
      }
    } else if (record.requestedByUserId !== actor.userId || !canManage) {
      throw new ApplicationValidationError("This request could not be completed.",
        ["actor: an emailed request is completed by the person who sent it"]);
    }
    mustBePending(record, "completed");

    const documentId = (input.documentId ?? "").trim();
    let responseDocumentId: DocumentId | null = null;
    if (record.kind === "preparation") {
      if (documentId !== "") {
        throw new ApplicationValidationError("This request could not be completed.",
          ["documentId: a preparation request is completed without a document"]);
      }
      await authorize(uow, actor, "document.prepare");
    } else {
      if (documentId === "") {
        throw new ApplicationValidationError("This request could not be completed.",
          ["documentId: name the uploaded document that answers this request"]);
      }
      const document = await uow.documents.findById(documentId as DocumentId);
      if (document === null) throw new ResourceNotFoundError("Document");
      if (record.delivery === "in-app" && document.createdByUserId !== actor.userId) {
        throw new ApplicationValidationError("This request could not be completed.",
          ["documentId: answer with a document you uploaded"]);
      }
      responseDocumentId = document.documentId;
    }

    const applied = await uow.contactRequests.markCompleted(requestId, {
      byUserId: actor.userId, responseDocumentId, at: deps.clock.now(),
    });
    if (!applied) throw new ResourceConflictError("This request is no longer pending.");

    const updated = await uow.contactRequests.find(requestId);
    if (updated === null) throw new ResourceNotFoundError("ContactRequest");
    await notifyRequester(uow, deps, updated, "CONTACT_REQUEST_COMPLETED", actor.userId);
    return presentOne(uow, updated);
  });
}

export async function declineContactRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  input: { readonly reason?: string | null }, deps: ContactRequestDependencies,
): Promise<ContactRequestView> {
  const reason = (input.reason ?? "").trim();
  if (reason === "") {
    throw new ApplicationValidationError("Add a reason for rejecting this request.",
      ["reason: required"]);
  }
  if (reason.length > MAX_REASON) {
    throw new ApplicationValidationError("This request could not be declined.",
      [`reason: must be ${String(MAX_REASON)} characters or fewer`]);
  }
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const { record } = await visibleRequest(uow, actor, requestId);
    if (record.recipientUserId !== actor.userId) {
      throw new ApplicationValidationError("This request could not be declined.",
        ["actor: only the member it was sent to can decline it"]);
    }
    mustBePending(record, "declined");
    const applied = await uow.contactRequests.markDeclined(requestId, {
      reason: reason === "" ? null : reason, at: deps.clock.now(),
    });
    if (!applied) throw new ResourceConflictError("This request is no longer pending.");
    const updated = await uow.contactRequests.find(requestId);
    if (updated === null) throw new ResourceNotFoundError("ContactRequest");
    await notifyRequester(uow, deps, updated, "CONTACT_REQUEST_DECLINED", actor.userId);
    return presentOne(uow, updated);
  });
}

export async function cancelContactRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  deps: ContactRequestDependencies,
): Promise<ContactRequestView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const { record } = await visibleRequest(uow, actor, requestId);
    if (record.requestedByUserId !== actor.userId) {
      throw new ApplicationValidationError("This request could not be cancelled.",
        ["actor: only the person who sent it can cancel it"]);
    }
    mustBePending(record, "cancelled");
    const applied = await uow.contactRequests.markCancelled(requestId, { at: deps.clock.now() });
    if (!applied) throw new ResourceConflictError("This request is no longer pending.");
    const updated = await uow.contactRequests.find(requestId);
    if (updated === null) throw new ResourceNotFoundError("ContactRequest");
    return presentOne(uow, updated);
  });
}
