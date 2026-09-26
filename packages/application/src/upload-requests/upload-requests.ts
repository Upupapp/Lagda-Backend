// Asking a member to supply a document (067).
//
// ── The one flow where the workspace does not have the file ───────────────
//
// Everywhere else in this product the sender holds a document and needs
// signatures on it. Here they hold nothing and are asking somebody else to
// provide it: "send me your signed contract", "upload the permit".
//
// ── Contact in, member out ────────────────────────────────────────────────
//
// A requester picks a CONTACT, because that is the address book they think
// in. What gets stored as the assignee is a USER, resolved from that
// contact's address at creation time, because fulfilling the request means
// writing a document into the workspace and workspace writes are authorized
// by membership.
//
// That resolution can fail, and when it does this REFUSES rather than
// storing a request nobody can act on. A contact is an address-book entry
// that has verified nothing (migration 015); addressing work to one whose
// address matches no member would produce a request that is permanently
// unfulfillable and a notification to somebody who cannot sign in to act on
// it. The refusal names the problem so the requester can invite them first.
//
// ── Why the notification is created in the same transaction ───────────────
//
// `createNotificationIntent` writes a row; the request writes a row. Both
// belong to the same decision — "this person has been asked for this" — and
// a request that exists with no notification is a silent assignment nobody
// hears about. The unique index on (source_kind, source_id, notification_type)
// makes the pairing idempotent, so a retry cannot produce two emails.

import type { WorkspaceId, DocumentId, ContactId } from "@lagda/contracts";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager } from "../common/ports/index.js";
import type {
  UploadRequestId, UploadRequestIdGenerator, UploadRequestRecord,
  UploadRequestStatus,
} from "../common/ports/upload-requests.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import { authorize } from "../signing-requests/signing-requests.js";
import {
  ApplicationValidationError, ResourceNotFoundError, ResourceConflictError,
} from "../common/errors/index.js";
import { normalizeEmail } from "../auth/email-identity.js";

/** The template model's own bounds. Enforced here so a value that would fail
 *  schema validation inside the transaction is refused up front, with a
 *  message naming the field rather than the schema. */
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_DISPLAY_NAME = 200;

/** Shown when a profile or workspace row cannot be read. Not fatal — a
 *  missing display name must not prevent somebody being asked for a file. */
const UNKNOWN_PERSON = "there";
const UNKNOWN_WORKSPACE = "your LAGDA workspace";

function bounded(value: string | null, fallback: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface UploadRequestDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: UploadRequestIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
}

export interface CreateUploadRequestInput {
  /** What is being asked for, in the requester's words. */
  readonly title: string;
  readonly note?: string;
  /** The address-book entry the requester picked. Resolved to a member. */
  readonly contactId: string;
}

/** Raised when the picked contact's address belongs to nobody in this
 *  workspace. Its own class rather than a generic validation error because
 *  the caller's next step is specific: invite them, then ask again. */
export class UploadRequestAssigneeNotAMemberError extends ApplicationValidationError {
  constructor(email: string) {
    super(
      "That contact cannot be assigned an upload yet.",
      [`assignee: ${email} has no LAGDA account in this workspace. `
        + "Invite them first, then assign the upload."],
    );
    this.name = "UploadRequestAssigneeNotAMemberError";
  }
}

export async function createUploadRequest(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: CreateUploadRequestInput,
  deps: UploadRequestDependencies,
): Promise<UploadRequestRecord> {
  const title = input.title.trim();
  if (title === "") {
    throw new ApplicationValidationError(
      "This request could not be created.", ["title: is required"]);
  }
  if (title.length > MAX_TITLE) {
    throw new ApplicationValidationError(
      "This request could not be created.",
      [`title: must be ${String(MAX_TITLE)} characters or fewer`]);
  }
  const note = (input.note ?? "").trim();
  if (note.length > MAX_NOTE) {
    throw new ApplicationValidationError(
      "This request could not be created.",
      [`note: must be ${String(MAX_NOTE)} characters or fewer`]);
  }

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    // Asking somebody for a document (078): its own capability, so the
    // "Request documents from others" privilege can grant it on its own.
    await authorize(uow, actor, "upload-request.create");

    const contact = await uow.contacts.findById(input.contactId as ContactId);
    if (contact === null) throw new ResourceNotFoundError("Contact");

    // Contact -> member. See this file's header for why a failure here is a
    // refusal rather than a stored request with an unreachable assignee.
    //
    // A contact's address is workspace-supplied and was never verified, so it
    // can be malformed — that is indistinguishable here from "belongs to no
    // member", and both produce the same refusal.
    const normalized = normalizeEmail(contact.email);
    if (normalized.outcome !== "ok") {
      throw new UploadRequestAssigneeNotAMemberError(contact.email);
    }
    const membership = await uow.memberships.findByNormalizedEmail(
      normalized.normalized);
    if (membership === null) {
      throw new UploadRequestAssigneeNotAMemberError(contact.email);
    }

    const now = deps.clock.now();
    const requestId = deps.ids.nextUploadRequestId();

    await uow.uploadRequests.insert({
      requestId,
      workspaceId,
      title,
      note: note === "" ? null : note,
      requestedByUserId: actor.userId,
      assigneeUserId: membership.userId,
      // Provenance only — never consulted when deciding who may fulfil.
      assigneeContactId: contact.contactId,
      createdAt: now,
    });

    const [requesterName, workspace] = await Promise.all([
      uow.actorProfiles.displayNameOf(actor.userId),
      uow.workspaces.find(),
    ]);

    await createNotificationIntent({
      notifications: uow.notifications,
      templates: deps.templates,
      ids: deps.notificationIds,
      clock: deps.clock,
    })({
      notificationType: "DOCUMENT_UPLOAD_REQUESTED",
      // The REQUEST is the source: one request, one notification, and the
      // unique index makes that the guarantee rather than a convention.
      sourceId: requestId,
      scope: { kind: "WORKSPACE", workspaceId },
      // The assignee's ACCOUNT, as an identity rather than an address (S21).
      audience: { kind: "USER", userId: membership.userId },
      // The contact's address — the same one that just resolved to this
      // member, so the mail goes where the requester expected it to.
      destination: contact.email,
      templateInput: {
        recipientName: bounded(contact.name, UNKNOWN_PERSON, MAX_DISPLAY_NAME),
        requestTitle: title,
        requesterDisplayName: bounded(requesterName, UNKNOWN_PERSON, MAX_DISPLAY_NAME),
        workspaceName: bounded(workspace?.name ?? null, UNKNOWN_WORKSPACE, MAX_DISPLAY_NAME),
        ...(note === "" ? {} : { note }),
      },
      // No `secretRef`. The assignee is a member who signs in as themselves.
    }, uow);

    const created = await uow.uploadRequests.find(requestId);
    if (created === null) throw new ResourceNotFoundError("UploadRequest");
    return created;
  });
}

export interface ListUploadRequestsFilter {
  /** `true` narrows to what is being asked of the CALLER — their own queue,
   *  which is where the notification sends them. */
  readonly assignedToMe?: boolean;
  readonly status?: UploadRequestStatus;
}

export async function listUploadRequests(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  filter: ListUploadRequestsFilter,
  deps: UploadRequestDependencies,
): Promise<readonly UploadRequestRecord[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    // Reading the workspace's requests takes the ordinary read capability —
    // an assignee who may not prepare documents must still see what has been
    // asked of them.
    await authorize(uow, actor, "document.view");
    return uow.uploadRequests.list({
      ...(filter.assignedToMe === true ? { assigneeUserId: actor.userId } : {}),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    });
  });
}

export async function cancelUploadRequest(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  requestId: string,
  deps: UploadRequestDependencies,
): Promise<UploadRequestRecord> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "document.prepare");

    const existing = await uow.uploadRequests.find(requestId);
    if (existing === null) throw new ResourceNotFoundError("UploadRequest");

    const cancelled = await uow.uploadRequests.markCancelled(
      requestId, { at: deps.clock.now() });
    if (!cancelled) {
      // Already fulfilled or already cancelled. Not a 404 — the request is
      // right there — and not silent, because the caller asked for a state
      // change that did not happen.
      throw new ResourceConflictError(
        `This request is already ${existing.status} and cannot be cancelled.`);
    }

    const updated = await uow.uploadRequests.find(requestId);
    if (updated === null) throw new ResourceNotFoundError("UploadRequest");
    return updated;
  });
}

/**
 * Answers a request with a document that has ALREADY been uploaded.
 *
 * Takes a `documentId` rather than bytes for the same reason
 * `attachWorkflowTemplateDocument` does: the upload path — create, upload,
 * scan, promote — already exists and is the only one that knows how to admit
 * bytes safely. Adding a second entry point that accepted a file here would
 * be a second upload path with its own quarantine story.
 */
export async function fulfilUploadRequest(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  requestId: string,
  input: { readonly documentId: DocumentId },
  deps: UploadRequestDependencies,
): Promise<UploadRequestRecord> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    // The ASSIGNEE is doing the uploading, and uploading is what this
    // capability governs.
    await authorize(uow, actor, "document.prepare");

    const existing = await uow.uploadRequests.find(requestId);
    if (existing === null) throw new ResourceNotFoundError("UploadRequest");

    // Only the person it was asked of may answer it. A workspace colleague
    // uploading on their behalf would make the record say something untrue
    // about who supplied the document.
    if (existing.assigneeUserId !== actor.userId) {
      throw new ApplicationValidationError(
        "This request could not be fulfilled.",
        ["assignee: only the person this was assigned to can fulfil it"]);
    }

    // The document must exist in THIS workspace. There is no foreign key —
    // migration 067's header records why — so this is the check that keeps
    // the reference honest.
    const document = await uow.documents.findById(input.documentId);
    if (document === null) throw new ResourceNotFoundError("Document");

    const fulfilled = await uow.uploadRequests.markFulfilled(
      requestId, { documentId: input.documentId, at: deps.clock.now() });
    if (!fulfilled) {
      throw new ResourceConflictError(
        `This request is already ${existing.status} and cannot be fulfilled.`);
    }

    const updated = await uow.uploadRequests.find(requestId);
    if (updated === null) throw new ResourceNotFoundError("UploadRequest");
    return updated;
  });
}

export type { UploadRequestRecord, UploadRequestId };
