// 087. Sharing completed documents, and asking their owners for access.
//
// ── Three audiences ────────────────────────────────────────────────────────
//
//   OWNER side   the member who sent the signing request, or a holder of
//                `document.share.manage` (workspace owners/administrators).
//                Shares a completed document with an address; decides the
//                access requests for it; sees "Shared by me".
//   RECIPIENT    a signed-in account. Its "Shared with me" lists shares made
//                to its VERIFIED address and the access requests it made, in
//                any workspace, each carrying the owner workspace's branding.
//                Accepted shares and approved requests open the document.
//   REQUESTER    a signed-in account holding a verification ID asks the owner
//                for access, and reads its own relation to the document.
//
// ── Nothing is emailed ─────────────────────────────────────────────────────
//
// Every notice here is an in-app USER intent whose email is suppressed as
// IN_APP_ONLY (086's pattern). A share to an address with no account yet
// simply waits: it appears once an account with that verified address exists.
//
// ── Nobody else is disclosed ───────────────────────────────────────────────
//
// A recipient sees their own shares and requests and nothing about anyone
// else's; the relation endpoint answers only about the caller. An owner sees
// the addresses they themselves shared with, and never whether an address
// has a LAGDA account.

import type { UserId, WorkspaceId, DocumentId, VerificationId } from "@lagda/contracts";
import { validateRecipientEmail, hasCapability, privilegeCapabilities } from "@lagda/core";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type {
  CompletedDocumentRecord, DocumentShareRecord, DocumentAccessRequestRecord,
  DocumentSharingIdGenerator, DocumentShareStatus, DocumentAccessRequestStatus,
  SharingRecipientUnitOfWork,
} from "../common/ports/document-sharing.js";
import {
  DOCUMENT_SHARE_NAME_MAX_LENGTH, DOCUMENT_ACCESS_REQUEST_NOTE_MAX_LENGTH,
} from "../common/ports/document-sharing.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator, NotificationType,
  NotificationTemplateInput,
} from "../common/ports/notifications.js";
import type { ObjectStorage } from "../common/ports/storage.js";
import { toStorageObjectKey } from "../common/ports/storage.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { privilegesOf } from "../workspaces/workspace-access.js";
import { recordActivity } from "../workspaces/activity.js";
import type { WorkspaceActivityAction, WorkspaceActivityDetails } from "../common/ports/workspace-activity.js";
import { parseVerificationId } from "../verification/public-verification.js";
import {
  presentVerificationDetails, VerificationDocumentUnavailableError,
  type VerificationDetailsView, type VerificationDocumentStream,
} from "../verification/verification-access.js";

const UNKNOWN_PERSON = "A LAGDA user";
const UNKNOWN_WORKSPACE = "a LAGDA workspace";
const MAX_DISPLAY = 200;

function bounded(value: string | null | undefined, fallback: string, max = MAX_DISPLAY): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ── Errors ────────────────────────────────────────────────────────────────

/** 409 `document_not_completed`: only a completed, sealed document can be shared. */
export class DocumentNotCompletedError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_not_completed";
  constructor() {
    super("Only a completed document can be shared. Share it once every participant has finished.");
  }
}

/** 409 `document_share_exists`: this address already has a live share of the document. */
export class DocumentShareExistsError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_share_exists";
  constructor() {
    super("This document is already shared with that email address.");
  }
}

/** 409 `document_share_recipient_has_access`: a participant already has access. */
export class DocumentShareRecipientHasAccessError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_share_recipient_has_access";
  constructor() {
    super("That email address is a participant of this document and already has access.");
  }
}

/** 409 `sharing_state_conflict`: the share or request is not in a state that allows this. */
export class SharingStateConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "sharing_state_conflict";
  constructor(message: string) {
    super(message);
  }
}

/** 403 `account_email_unverified`: requesting access needs a verified address. */
export class AccountEmailUnverifiedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "account_email_unverified";
  constructor() {
    super("Verify your account email address before asking for access to a document.");
  }
}

/** 409 on a request that cannot be made; `code` says why, about the caller only. */
export class DocumentAccessRequestRefusedError extends ApplicationError {
  readonly category = "conflict" as const;
  constructor(
    readonly code:
      | "document_access_already_granted" | "document_share_pending" | "document_share_rejected"
      | "document_access_request_pending" | "document_access_request_rejected",
    message: string,
  ) {
    super(message);
  }
}

// ── Dependencies ──────────────────────────────────────────────────────────

/** The signed-in account's CURRENT address, read from the account itself. */
export interface SharingAccount {
  readonly email: string;
  readonly normalizedEmail: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface DocumentSharingDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: DocumentSharingIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly storage: ObjectStorage;
  readonly currentAccount: (userId: UserId) => Promise<SharingAccount | null>;
}

// ── Views ─────────────────────────────────────────────────────────────────

export interface SharingPerson {
  readonly userId: string;
  readonly displayName: string;
}

export interface CompletedDocumentSummary {
  readonly documentId: string;
  readonly verificationId: string;
  readonly documentTitle: string;
  readonly completedAt: number;
  readonly owner: SharingPerson;
  readonly participantCount: number;
}

export interface DocumentShareView {
  readonly shareId: string;
  readonly documentId: string;
  readonly verificationId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: DocumentShareStatus;
  /** The account that answered, once one has. */
  readonly recipient: SharingPerson | null;
  readonly sharedBy: SharingPerson;
  readonly removedBy: "owner" | "recipient" | "email-changed" | null;
  readonly replacesShareId: string | null;
  /** The recipient deleted this rejected share from their own list. */
  readonly recipientDeleted: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly respondedAt: number | null;
  readonly removedAt: number | null;
}

export interface DocumentSharesView {
  readonly document: CompletedDocumentSummary;
  readonly shares: readonly DocumentShareView[];
}

export interface DocumentAccessRequestView {
  readonly requestId: string;
  readonly document: CompletedDocumentSummary;
  readonly requester: { readonly userId: string; readonly displayName: string; readonly email: string };
  readonly note: string | null;
  readonly status: DocumentAccessRequestStatus;
  readonly decidedBy: SharingPerson | null;
  readonly decidedAt: number | null;
  readonly removedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SharedByMeItem {
  readonly document: CompletedDocumentSummary;
  readonly acceptedShares: number;
  readonly pendingShares: number;
  readonly rejectedShares: number;
  readonly approvedRequests: number;
  readonly pendingRequests: number;
}

export interface SharedBrandingSnapshot {
  /** The owner workspace's display name. */
  readonly displayName: string;
  readonly primaryColor: string | null;
  /** Fetch it from the recipient-safe logo route; `version` changes with the logo. */
  readonly logo: { readonly version: string; readonly width: number; readonly height: number } | null;
}

export type SharedWithMeStatus = "pending" | "accepted" | "rejected";
export const SHARED_WITH_ME_STATUSES: readonly SharedWithMeStatus[] = ["pending", "accepted", "rejected"];

export type SharedItemAction =
  | "accept" | "reject" | "withdraw-rejection" | "delete" | "remove-access" | "open";

export interface SharedDocumentView {
  /** The share's or the request's id; every `/me/shared-documents/:id` route takes it. */
  readonly id: string;
  readonly kind: "share" | "access-request";
  readonly status: SharedWithMeStatus;
  readonly verificationId: string;
  readonly documentTitle: string;
  readonly completedAt: number;
  readonly owner: { readonly displayName: string };
  /** Who shared it (a share), or who approved it (a request), once known. */
  readonly sharedBy: { readonly displayName: string } | null;
  /** The name the owner gave this person, for a share. */
  readonly fullName: string | null;
  /** The address the share or request is for (this account's own). */
  readonly email: string;
  /** This account's own note, for a request. */
  readonly note: string | null;
  readonly progress: { readonly participants: number; readonly completed: number };
  readonly branding: SharedBrandingSnapshot;
  readonly actions: readonly SharedItemAction[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly respondedAt: number | null;
}

export type DocumentAccessRelation =
  | "owner" | "admin" | "participant" | "shared-accepted" | "shared-pending"
  | "shared-rejected" | "request-pending" | "request-rejected" | "none";

export interface MyDocumentAccessView {
  readonly verificationId: string;
  readonly relation: DocumentAccessRelation;
  /** The caller's own share or request behind the relation, when there is one. */
  readonly shareId: string | null;
  readonly requestId: string | null;
  readonly canRequestAccess: boolean;
}

export interface MyAccessRequestView {
  readonly requestId: string;
  readonly verificationId: string;
  readonly documentTitle: string;
  readonly status: DocumentAccessRequestStatus;
  readonly note: string | null;
  readonly createdAt: number;
}

// ── Shared helpers ────────────────────────────────────────────────────────

function notifier(uow: WorkspaceUnitOfWork, deps: DocumentSharingDependencies) {
  return createNotificationIntent({
    notifications: uow.notifications,
    templates: deps.templates,
    ids: deps.notificationIds,
    clock: deps.clock,
  });
}

async function notifyUser(
  uow: WorkspaceUnitOfWork, deps: DocumentSharingDependencies,
  type: NotificationType, sourceId: string, userId: UserId, destination: string,
  templateInput: NotificationTemplateInput,
): Promise<void> {
  await notifier(uow, deps)({
    notificationType: type,
    sourceId,
    scope: { kind: "WORKSPACE", workspaceId: uow.workspaceId },
    audience: { kind: "USER", userId },
    // Never sent: every sharing notice is IN_APP_ONLY by policy.
    destination,
    templateInput,
  }, uow);
}

/** A current member's display name and address, or null once they have left. */
async function memberOf(
  uow: WorkspaceUnitOfWork, userId: UserId,
): Promise<{ readonly displayName: string; readonly email: string } | null> {
  const members = await uow.memberships.listWithAccounts();
  const member = members.find(m => m.userId === userId);
  return member === undefined ? null : { displayName: member.displayName, email: member.email };
}

async function nameOf(uow: WorkspaceUnitOfWork, userId: UserId): Promise<string> {
  return bounded(await uow.actorProfiles.displayNameOf(userId), UNKNOWN_PERSON);
}

async function workspaceNameOf(uow: WorkspaceUnitOfWork): Promise<string> {
  return bounded((await uow.workspaces.find())?.name, UNKNOWN_WORKSPACE);
}

async function summarize(uow: WorkspaceUnitOfWork, document: CompletedDocumentRecord): Promise<CompletedDocumentSummary> {
  return {
    documentId: document.documentId,
    verificationId: document.verificationId,
    documentTitle: document.documentTitle,
    completedAt: document.completedAt,
    owner: { userId: document.ownerUserId, displayName: await nameOf(uow, document.ownerUserId) },
    participantCount: document.participantCount,
  };
}

function sharedDocumentFields(document: CompletedDocumentRecord, workspaceName: string) {
  return {
    documentTitle: bounded(document.documentTitle, "a document", 300),
    workspaceName,
    verificationId: document.verificationId,
  };
}

async function record(
  uow: WorkspaceUnitOfWork, action: WorkspaceActivityAction, actorUserId: UserId,
  occurredAt: number, details: WorkspaceActivityDetails, actorName?: string,
): Promise<void> {
  await recordActivity(uow, {
    action, actorUserId, occurredAt, details,
    ...(actorName === undefined ? {} : { actorName }),
  });
}

/**
 * The actor's authority over one completed document: its owner (the sender,
 * still a member) or a holder of `document.share.manage`. Anything else is the
 * same hidden 404 a document outside the workspace gets.
 */
async function requireManager(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, document: CompletedDocumentRecord,
): Promise<void> {
  const membership = await uow.memberships.findByUser(actor.userId);
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  if (document.ownerUserId === actor.userId) return;
  if (canManageAll(membership)) return;
  throw new ResourceNotFoundError("Document");
}

function canManageAll(membership: {
  readonly role: Parameters<typeof hasCapability>[0];
  readonly canRequestDocuments?: boolean;
  readonly canAssignSigners?: boolean;
}): boolean {
  return hasCapability(membership.role, "document.share.manage")
    || privilegeCapabilities(privilegesOf(membership)).includes("document.share.manage");
}

async function completedDocumentOrThrow(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, documentId: string,
): Promise<CompletedDocumentRecord> {
  const membership = await uow.memberships.findByUser(actor.userId);
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const completed = await uow.documentSharing.findCompletedDocument(documentId as DocumentId);
  if (completed !== null) {
    await requireManager(uow, actor, completed);
    return completed;
  }
  const document = await uow.documents.findById(documentId as DocumentId);
  if (document === null) throw new ResourceNotFoundError("Document");
  throw new DocumentNotCompletedError();
}

function validateEmail(raw: string): { display: string; key: string } {
  const result = validateRecipientEmail(raw);
  if (!result.ok) {
    throw new ApplicationValidationError("Enter a valid email address.", [`email: ${result.reason}`]);
  }
  return { display: result.display, key: result.key };
}

function validateName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;
  if ([...value].length > DOCUMENT_SHARE_NAME_MAX_LENGTH || /[\p{Cc}]/u.test(value)) {
    throw new ApplicationValidationError("Check the name and try again.",
      [`fullName: at most ${String(DOCUMENT_SHARE_NAME_MAX_LENGTH)} characters, no control characters`]);
  }
  return value;
}

const LIVE_SHARE: readonly DocumentShareStatus[] = ["pending", "accepted", "rejected"];

function isLiveShare(share: DocumentShareRecord): boolean {
  return share.status === "pending" || share.status === "accepted"
    || (share.status === "rejected" && share.recipientDeletedAt === null);
}

function isLiveRequest(request: DocumentAccessRequestRecord): boolean {
  return request.status === "pending" || request.status === "approved"
    || (request.status === "rejected" && request.deletedAt === null);
}

// ── Owner side: shares ────────────────────────────────────────────────────

async function presentShares(
  uow: WorkspaceUnitOfWork, shares: readonly DocumentShareRecord[],
): Promise<DocumentShareView[]> {
  const names = new Map<string, string>();
  const nameFor = async (userId: UserId): Promise<string> => {
    const known = names.get(userId);
    if (known !== undefined) return known;
    const name = await nameOf(uow, userId);
    names.set(userId, name);
    return name;
  };
  const views: DocumentShareView[] = [];
  for (const share of shares) {
    views.push({
      shareId: share.shareId,
      documentId: share.documentId,
      verificationId: share.verificationId,
      email: share.email,
      fullName: share.fullName,
      status: share.status,
      recipient: share.recipientUserId === null ? null
        : { userId: share.recipientUserId, displayName: await nameFor(share.recipientUserId) },
      sharedBy: { userId: share.sharedByUserId, displayName: await nameFor(share.sharedByUserId) },
      removedBy: share.removedBy,
      replacesShareId: share.replacesShareId,
      recipientDeleted: share.recipientDeletedAt !== null,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
      respondedAt: share.respondedAt,
      removedAt: share.removedAt,
    });
  }
  return views;
}

async function presentShare(uow: WorkspaceUnitOfWork, shareId: string): Promise<DocumentShareView> {
  const share = await uow.documentSharing.findShare(shareId);
  if (share === null) throw new ResourceNotFoundError("DocumentShare");
  const [view] = await presentShares(uow, [share]);
  if (view === undefined) throw new ResourceNotFoundError("DocumentShare");
  return view;
}

export async function listDocumentShares(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, documentId: string,
  deps: Pick<DocumentSharingDependencies, "transactions">,
  filter: { readonly status?: DocumentShareStatus } = {},
): Promise<DocumentSharesView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const document = await completedDocumentOrThrow(uow, actor, documentId);
    const shares = await uow.documentSharing.listShares({
      verificationId: document.verificationId,
      ...(filter.status === undefined ? {} : { statuses: [filter.status] }),
    });
    return { document: await summarize(uow, document), shares: await presentShares(uow, shares) };
  });
}

/**
 * Refuses an address that already has access or a live share, then writes a
 * PENDING share and — when an account with that verified address exists —
 * tells it in-app.
 */
async function insertShare(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, deps: DocumentSharingDependencies,
  document: CompletedDocumentRecord,
  input: { display: string; key: string; fullName: string | null; replaces: DocumentShareRecord | null },
  now: number,
): Promise<string> {
  if (await uow.documentSharing.isParticipant(document, input.key)) {
    throw new DocumentShareRecipientHasAccessError();
  }
  const existing = await uow.documentSharing.listShares({
    verificationId: document.verificationId, normalizedEmail: input.key, statuses: LIVE_SHARE,
  });
  if (existing.some(share => isLiveShare(share) && share.shareId !== input.replaces?.shareId)) {
    throw new DocumentShareExistsError();
  }
  const account = await uow.documentSharing.verifiedAccountByEmail(input.key);
  if (account !== null && account.userId === actor.userId) {
    throw new ApplicationValidationError("You already have access to this document.",
      ["email: you cannot share a document with yourself"]);
  }

  const shareId = deps.ids.nextDocumentShareId();
  await uow.documentSharing.insertShare({
    shareId,
    workspaceId: uow.workspaceId,
    documentId: document.documentId,
    signingRequestId: document.signingRequestId,
    verificationId: document.verificationId,
    email: input.display,
    normalizedEmail: input.key,
    fullName: input.fullName,
    sharedByUserId: actor.userId,
    replacesShareId: input.replaces?.shareId ?? null,
    createdAt: now,
  });

  if (account !== null) {
    const workspaceName = await workspaceNameOf(uow);
    await notifyUser(uow, deps, "DOCUMENT_SHARE_RECEIVED", shareId, account.userId, input.display, {
      recipientName: bounded(input.fullName ?? account.displayName, "there"),
      sharerDisplayName: await nameOf(uow, actor.userId),
      ...sharedDocumentFields(document, workspaceName),
    });
  }
  return shareId;
}

export interface CreateDocumentShareInput {
  readonly email: string;
  readonly fullName?: string | null;
}

export async function createDocumentShare(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, documentId: string,
  input: CreateDocumentShareInput, deps: DocumentSharingDependencies,
): Promise<DocumentShareView> {
  const email = validateEmail(input.email);
  const fullName = validateName(input.fullName);
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const document = await completedDocumentOrThrow(uow, actor, documentId);
    const now = deps.clock.now();
    const shareId = await insertShare(uow, actor, deps, document,
      { ...email, fullName, replaces: null }, now);
    await record(uow, "document_share.created", actor.userId, now, {
      documentTitle: document.documentTitle, targetEmail: email.display, targetName: fullName,
    });
    return presentShare(uow, shareId);
  });
}

export interface UpdateDocumentShareInput {
  readonly email?: string;
  readonly fullName?: string | null;
}

export interface UpdatedDocumentShare {
  /** The share as it now stands — a NEW pending share when the address changed. */
  readonly share: DocumentShareView;
  /** The share the address change ended (now `removed`, `email-changed`), or null. */
  readonly previous: DocumentShareView | null;
}

async function ownedShare(
  uow: WorkspaceUnitOfWork, document: CompletedDocumentRecord, shareId: string,
): Promise<DocumentShareRecord> {
  const share = await uow.documentSharing.findShare(shareId);
  if (share === null || share.verificationId !== document.verificationId) {
    throw new ResourceNotFoundError("DocumentShare");
  }
  return share;
}

/**
 * Renames and/or re-addresses a share. A new address ENDS the old share
 * (`removed`, by `email-changed`) and starts a PENDING one for the new
 * address, carrying the name; the old recipient's access ends with it.
 */
export async function updateDocumentShare(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, documentId: string, shareId: string,
  input: UpdateDocumentShareInput, deps: DocumentSharingDependencies,
): Promise<UpdatedDocumentShare> {
  const email = input.email === undefined ? null : validateEmail(input.email);
  const fullName = input.fullName === undefined ? undefined : validateName(input.fullName);
  if (email === null && fullName === undefined) {
    throw new ApplicationValidationError("Nothing to change.", ["email or fullName: provide at least one"]);
  }
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const document = await completedDocumentOrThrow(uow, actor, documentId);
    const share = await ownedShare(uow, document, shareId);
    if (share.status === "removed") {
      throw new SharingStateConflictError("This share was removed and can no longer be changed.");
    }
    const now = deps.clock.now();
    const name = fullName === undefined ? share.fullName : fullName;

    if (email !== null && email.key !== share.normalizedEmail) {
      const ended = await uow.documentSharing.updateShare(share.shareId, { from: LIVE_SHARE }, {
        status: "removed", removedAt: now, removedBy: "email-changed", removedByUserId: actor.userId,
        recipientDeletedAt: null, updatedAt: now,
      });
      if (!ended) throw new SharingStateConflictError("This share changed. Reload it and try again.");
      const nextId = await insertShare(uow, actor, deps, document,
        { ...email, fullName: name, replaces: share }, now);
      await record(uow, "document_share.updated", actor.userId, now, {
        documentTitle: document.documentTitle, fromEmail: share.email,
        targetEmail: email.display, targetName: name,
      });
      return { share: await presentShare(uow, nextId), previous: await presentShare(uow, share.shareId) };
    }

    // Only the name (or an address differing in case alone, which is the same address).
    if (name !== share.fullName) {
      const applied = await uow.documentSharing.updateShare(share.shareId, { from: [share.status] }, {
        fullName: name, updatedAt: now,
      });
      if (!applied) throw new SharingStateConflictError("This share changed. Reload it and try again.");
      await record(uow, "document_share.updated", actor.userId, now, {
        documentTitle: document.documentTitle, targetEmail: share.email, targetName: name,
      });
    }
    return { share: await presentShare(uow, share.shareId), previous: null };
  });
}

export async function removeDocumentShare(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, documentId: string, shareId: string,
  deps: DocumentSharingDependencies,
): Promise<DocumentShareView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const document = await completedDocumentOrThrow(uow, actor, documentId);
    const share = await ownedShare(uow, document, shareId);
    if (share.status === "removed") {
      throw new SharingStateConflictError("This share was already removed.");
    }
    const now = deps.clock.now();
    const applied = await uow.documentSharing.updateShare(share.shareId, { from: LIVE_SHARE }, {
      status: "removed", removedAt: now, removedBy: "owner", removedByUserId: actor.userId,
      recipientDeletedAt: null, updatedAt: now,
    });
    if (!applied) throw new SharingStateConflictError("This share changed. Reload it and try again.");
    await record(uow, "document_share.removed", actor.userId, now, {
      documentTitle: document.documentTitle, targetEmail: share.email, targetName: share.fullName,
    });
    return presentShare(uow, share.shareId);
  });
}

// ── Owner side: access requests ───────────────────────────────────────────

async function presentRequests(
  uow: WorkspaceUnitOfWork, requests: readonly DocumentAccessRequestRecord[],
  documents: Map<string, CompletedDocumentRecord | null>,
): Promise<DocumentAccessRequestView[]> {
  const views: DocumentAccessRequestView[] = [];
  for (const request of requests) {
    const document = await documentFor(uow, documents, request.verificationId);
    if (document === null) continue;
    views.push({
      requestId: request.requestId,
      document: await summarize(uow, document),
      requester: {
        userId: request.requesterUserId, displayName: request.requesterName, email: request.requesterEmail,
      },
      note: request.note,
      status: request.status,
      decidedBy: request.decidedByUserId === null ? null
        : { userId: request.decidedByUserId, displayName: await nameOf(uow, request.decidedByUserId) },
      decidedAt: request.decidedAt,
      removedAt: request.removedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
  }
  return views;
}

async function documentFor(
  uow: WorkspaceUnitOfWork, cache: Map<string, CompletedDocumentRecord | null>, verificationId: VerificationId,
): Promise<CompletedDocumentRecord | null> {
  if (cache.has(verificationId)) return cache.get(verificationId) ?? null;
  const document = await uow.documentSharing.findCompletedByVerification(verificationId);
  cache.set(verificationId, document);
  return document;
}

/**
 * The access requests the actor may decide: every one for a holder of
 * `document.share.manage`, otherwise those for documents the actor sent.
 * Deleted (rejected-then-deleted) requests are not listed.
 */
export async function listAccessRequests(
  actor: AuthenticatedActor, workspaceId: WorkspaceId,
  filter: { readonly status?: DocumentAccessRequestStatus },
  deps: Pick<DocumentSharingDependencies, "transactions">,
): Promise<readonly DocumentAccessRequestView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(actor.userId);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const all = canManageAll(membership);
    const requests = await uow.documentSharing.listAccessRequests(
      filter.status === undefined ? {} : { statuses: [filter.status] });
    const cache = new Map<string, CompletedDocumentRecord | null>();
    const visible: DocumentAccessRequestRecord[] = [];
    for (const request of requests) {
      const document = await documentFor(uow, cache, request.verificationId);
      if (document === null) continue;
      if (all || document.ownerUserId === actor.userId) visible.push(request);
    }
    return presentRequests(uow, visible, cache);
  });
}

type OwnerRequestAction = "approve" | "reject" | "withdraw-rejection" | "delete" | "remove";

async function decideRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  action: OwnerRequestAction, deps: DocumentSharingDependencies,
): Promise<DocumentAccessRequestView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const request = await uow.documentSharing.findAccessRequest(requestId);
    if (request === null || request.deletedAt !== null) throw new ResourceNotFoundError("AccessRequest");
    const membership = await uow.memberships.findByUser(actor.userId);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const document = await uow.documentSharing.findCompletedByVerification(request.verificationId);
    if (document === null) throw new ResourceNotFoundError("AccessRequest");
    await requireManager(uow, actor, document);

    const now = deps.clock.now();
    const moved = async (
      from: readonly DocumentAccessRequestStatus[], patch: Parameters<typeof uow.documentSharing.updateAccessRequest>[2],
      conflict: string,
    ) => {
      if (!from.includes(request.status)) throw new SharingStateConflictError(conflict);
      const applied = await uow.documentSharing.updateAccessRequest(request.requestId, { from, notDeleted: true }, patch);
      if (!applied) throw new SharingStateConflictError("This request changed. Reload it and try again.");
    };
    const details = {
      documentTitle: document.documentTitle, targetName: request.requesterName, targetEmail: request.requesterEmail,
    };

    switch (action) {
      case "approve":
      case "reject": {
        const status = action === "approve" ? "approved" : "rejected";
        await moved(["pending"], {
          status, decidedByUserId: actor.userId, decidedAt: now, updatedAt: now,
        }, `Only a pending request can be ${status}.`);
        await record(uow, action === "approve" ? "access_request.approved" : "access_request.rejected",
          actor.userId, now, details);
        await notifyUser(uow, deps,
          action === "approve" ? "DOCUMENT_ACCESS_APPROVED" : "DOCUMENT_ACCESS_REJECTED",
          request.requestId, request.requesterUserId, request.requesterEmail, {
            recipientName: bounded(request.requesterName, "there"),
            deciderDisplayName: await nameOf(uow, actor.userId),
            decision: status,
            ...sharedDocumentFields(document, await workspaceNameOf(uow)),
          });
        break;
      }
      case "withdraw-rejection":
        await moved(["rejected"], {
          status: "pending", decidedByUserId: null, decidedAt: null, updatedAt: now,
        }, "Only a rejected request can have its rejection withdrawn.");
        await record(uow, "access_request.rejection_withdrawn", actor.userId, now, details);
        break;
      case "delete":
        await moved(["rejected"], {
          deletedByUserId: actor.userId, deletedAt: now, updatedAt: now,
        }, "Only a rejected request can be deleted.");
        await record(uow, "access_request.deleted", actor.userId, now, details);
        break;
      case "remove":
        await moved(["approved"], {
          status: "removed", removedByUserId: actor.userId, removedAt: now, updatedAt: now,
        }, "Only an approved request's access can be removed.");
        await record(uow, "access_request.access_removed", actor.userId, now, details);
        break;
    }

    const updated = await uow.documentSharing.findAccessRequest(request.requestId);
    if (updated === null) throw new ResourceNotFoundError("AccessRequest");
    const [view] = await presentRequests(uow, [updated], new Map([[document.verificationId, document]]));
    if (view === undefined) throw new ResourceNotFoundError("AccessRequest");
    return view;
  });
}

export const approveAccessRequest = (
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string, deps: DocumentSharingDependencies,
) => decideRequest(actor, workspaceId, requestId, "approve", deps);
export const rejectAccessRequest = (
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string, deps: DocumentSharingDependencies,
) => decideRequest(actor, workspaceId, requestId, "reject", deps);
export const withdrawAccessRequestRejection = (
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string, deps: DocumentSharingDependencies,
) => decideRequest(actor, workspaceId, requestId, "withdraw-rejection", deps);
/** Hides a REJECTED request from the workspace's list; the row stays for history. */
export const deleteAccessRequest = (
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string, deps: DocumentSharingDependencies,
) => decideRequest(actor, workspaceId, requestId, "delete", deps);
/** Ends the access an APPROVED request gave. */
export const removeAccessRequestAccess = (
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string, deps: DocumentSharingDependencies,
) => decideRequest(actor, workspaceId, requestId, "remove", deps);

// ── Owner side: Shared by me ──────────────────────────────────────────────

/**
 * Completed documents with at least one ACCEPTED share or APPROVED request.
 * `mine` (the default) is the documents the actor sent; `workspace` is every
 * one, for a holder of `document.share.manage` only.
 */
export async function listSharedByMe(
  actor: AuthenticatedActor, workspaceId: WorkspaceId,
  input: { readonly scope?: "mine" | "workspace" },
  deps: Pick<DocumentSharingDependencies, "transactions">,
): Promise<readonly SharedByMeItem[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(actor.userId);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const workspaceWide = input.scope === "workspace";
    if (workspaceWide && !canManageAll(membership)) throw new ResourceNotFoundError("Workspace");

    const shares = await uow.documentSharing.listShares({});
    const requests = await uow.documentSharing.listAccessRequests({});
    const counts = new Map<string, {
      acceptedShares: number; pendingShares: number; rejectedShares: number;
      approvedRequests: number; pendingRequests: number;
    }>();
    const bucket = (verificationId: string) => {
      let entry = counts.get(verificationId);
      if (entry === undefined) {
        entry = { acceptedShares: 0, pendingShares: 0, rejectedShares: 0, approvedRequests: 0, pendingRequests: 0 };
        counts.set(verificationId, entry);
      }
      return entry;
    };
    for (const share of shares) {
      if (share.status === "accepted") bucket(share.verificationId).acceptedShares++;
      else if (share.status === "pending") bucket(share.verificationId).pendingShares++;
      else if (share.status === "rejected") bucket(share.verificationId).rejectedShares++;
    }
    for (const request of requests) {
      if (request.status === "approved") bucket(request.verificationId).approvedRequests++;
      else if (request.status === "pending") bucket(request.verificationId).pendingRequests++;
    }

    const cache = new Map<string, CompletedDocumentRecord | null>();
    const items: SharedByMeItem[] = [];
    for (const [verificationId, count] of counts) {
      if (count.acceptedShares + count.approvedRequests === 0) continue;
      const document = await documentFor(uow, cache, verificationId as VerificationId);
      if (document === null) continue;
      if (!workspaceWide && document.ownerUserId !== actor.userId) continue;
      items.push({ document: await summarize(uow, document), ...count });
    }
    return items.sort((a, b) => b.document.completedAt - a.document.completedAt
      || a.document.verificationId.localeCompare(b.document.verificationId));
  });
}

// ── Recipient side ────────────────────────────────────────────────────────

async function recipientOf(
  userId: UserId, deps: Pick<DocumentSharingDependencies, "currentAccount">,
): Promise<{ userId: UserId; verifiedEmail: string | null; account: SharingAccount | null }> {
  const account = await deps.currentAccount(userId);
  return {
    userId,
    verifiedEmail: account !== null && account.emailVerified ? account.normalizedEmail : null,
    account,
  };
}

type RecipientItem =
  | { readonly kind: "share"; readonly record: DocumentShareRecord }
  | { readonly kind: "access-request"; readonly record: DocumentAccessRequestRecord };

/** The recipient's own share or request by id; deleted rejected shares are gone. */
async function recipientItem(ruow: SharingRecipientUnitOfWork, id: string): Promise<RecipientItem> {
  const share = await ruow.findShare(id);
  if (share !== null && share.recipientDeletedAt === null && share.status !== "removed") {
    return { kind: "share", record: share };
  }
  const request = await ruow.findAccessRequest(id);
  if (request !== null && request.status !== "removed") return { kind: "access-request", record: request };
  throw new ResourceNotFoundError("SharedDocument");
}

function listedStatus(item: RecipientItem): SharedWithMeStatus | null {
  if (item.kind === "share") {
    const share = item.record;
    if (share.status === "pending") return "pending";
    if (share.status === "accepted") return "accepted";
    if (share.status === "rejected" && share.recipientDeletedAt === null) return "rejected";
    return null;
  }
  const request = item.record;
  if (request.status === "pending") return "pending";
  if (request.status === "approved") return "accepted";
  if (request.status === "rejected" && request.deletedAt === null) return "rejected";
  return null;
}

function actionsFor(item: RecipientItem, status: SharedWithMeStatus): SharedItemAction[] {
  if (item.kind === "share") {
    switch (status) {
      case "pending": return ["accept", "reject"];
      case "accepted": return ["open", "remove-access"];
      case "rejected": return ["withdraw-rejection", "delete"];
    }
  }
  return status === "accepted" ? ["open", "remove-access"] : [];
}

/** Whether the owner workspace's branding may be shown for this item. */
function brandingVisible(item: RecipientItem): boolean {
  return item.kind === "share" || item.record.status === "approved";
}

async function presentSharedItem(
  uow: WorkspaceUnitOfWork, item: RecipientItem,
): Promise<SharedDocumentView | null> {
  const status = listedStatus(item);
  if (status === null) return null;
  const document = await uow.documentSharing.findCompletedByVerification(item.record.verificationId);
  if (document === null) return null;
  const [workspace, branding, projection] = await Promise.all([
    uow.workspaces.find(), uow.branding.find(), uow.documentSharing.detailsProjection(document),
  ]);
  const details = projection === null ? null : presentVerificationDetails(projection);
  const completed = details === null ? 0
    : details.participants.filter(p => p.status === "signed" || p.status === "approved").length;
  const visible = brandingVisible(item);
  const share = item.kind === "share" ? item.record : null;
  const request = item.kind === "access-request" ? item.record : null;
  const sharerId = share?.sharedByUserId ?? request?.decidedByUserId ?? null;

  return {
    id: share?.shareId ?? request?.requestId ?? "",
    kind: item.kind,
    status,
    verificationId: document.verificationId,
    documentTitle: document.documentTitle,
    completedAt: document.completedAt,
    owner: { displayName: await nameOf(uow, document.ownerUserId) },
    sharedBy: sharerId === null ? null : { displayName: await nameOf(uow, sharerId) },
    fullName: share?.fullName ?? null,
    email: share?.email ?? request?.requesterEmail ?? "",
    note: request?.note ?? null,
    progress: { participants: document.participantCount, completed },
    branding: {
      displayName: bounded(workspace?.name, UNKNOWN_WORKSPACE),
      primaryColor: visible ? branding?.primaryColor ?? null : null,
      logo: visible && branding?.logo !== null && branding?.logo !== undefined
        ? { version: branding.logo.digest, width: branding.logo.width, height: branding.logo.height }
        : null,
    },
    actions: actionsFor(item, status),
    createdAt: item.record.createdAt,
    updatedAt: item.record.updatedAt,
    respondedAt: share?.respondedAt ?? request?.decidedAt ?? null,
  };
}

/** "Shared with me", by status, from every workspace. Newest first. */
export async function listSharedWithMe(
  userId: UserId, status: SharedWithMeStatus,
  deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
): Promise<readonly SharedDocumentView[]> {
  const recipient = await recipientOf(userId, deps);
  return deps.transactions.runForSharingRecipient(
    { userId, verifiedEmail: recipient.verifiedEmail }, async ruow => {
      const items: RecipientItem[] = [
        ...(await ruow.listShares()).map(record => ({ kind: "share" as const, record })),
        ...(await ruow.listAccessRequests()).map(record => ({ kind: "access-request" as const, record })),
      ].filter(item => listedStatus(item) === status);
      const views: SharedDocumentView[] = [];
      for (const item of items) {
        const view = await ruow.enterWorkspace(item.record.workspaceId, uow => presentSharedItem(uow, item));
        if (view !== null) views.push(view);
      }
      return views.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    });
}

export async function getSharedWithMe(
  userId: UserId, id: string,
  deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
): Promise<SharedDocumentView> {
  const recipient = await recipientOf(userId, deps);
  return deps.transactions.runForSharingRecipient(
    { userId, verifiedEmail: recipient.verifiedEmail }, async ruow => {
      const item = await recipientItem(ruow, id);
      const view = await ruow.enterWorkspace(item.record.workspaceId, uow => presentSharedItem(uow, item));
      if (view === null) throw new ResourceNotFoundError("SharedDocument");
      return view;
    });
}

export type RecipientAction = "accept" | "reject" | "withdraw-rejection" | "delete" | "remove-access";

/**
 * One of the recipient's own actions on a share or an approved request.
 *
 *   share    accept / reject (pending), withdraw-rejection / delete (rejected),
 *            remove-access (accepted)
 *   request  remove-access (approved)
 */
export async function actOnSharedDocument(
  userId: UserId, id: string, action: RecipientAction, deps: DocumentSharingDependencies,
): Promise<SharedDocumentView | null> {
  const recipient = await recipientOf(userId, deps);
  const actorName = bounded(recipient.account?.displayName, UNKNOWN_PERSON);
  return deps.transactions.runForSharingRecipient(
    { userId, verifiedEmail: recipient.verifiedEmail }, async ruow => {
      const item = await recipientItem(ruow, id);
      return ruow.enterWorkspace(item.record.workspaceId, async uow => {
        const now = deps.clock.now();
        const document = await uow.documentSharing.findCompletedByVerification(item.record.verificationId);
        if (document === null) throw new ResourceNotFoundError("SharedDocument");
        const refuse = (message: string): never => { throw new SharingStateConflictError(message); };

        if (item.kind === "access-request") {
          if (action !== "remove-access") refuse("Only your access can be removed from an approved request.");
          const applied = await uow.documentSharing.updateAccessRequest(item.record.requestId,
            { from: ["approved"] },
            { status: "removed", removedByUserId: userId, removedAt: now, updatedAt: now });
          if (!applied) refuse("Only an approved request's access can be removed.");
          await record(uow, "access_request.access_removed", userId, now, {
            documentTitle: document.documentTitle, targetName: actorName,
            targetEmail: item.record.requesterEmail, byRequester: true,
          }, actorName);
          return null;
        }

        const share = item.record;
        const details = { documentTitle: document.documentTitle, targetEmail: share.email };
        const answer = async (to: "accepted" | "rejected") => {
          const applied = await uow.documentSharing.updateShare(share.shareId, { from: ["pending"] }, {
            status: to, recipientUserId: userId, respondedAt: now, updatedAt: now,
          });
          if (!applied) refuse(`Only a pending share can be ${to}.`);
          await record(uow, to === "accepted" ? "document_share.accepted" : "document_share.rejected",
            userId, now, details, actorName);
          const sharer = await memberOf(uow, share.sharedByUserId);
          if (sharer !== null) {
            await notifyUser(uow, deps,
              to === "accepted" ? "DOCUMENT_SHARE_ACCEPTED" : "DOCUMENT_SHARE_REJECTED",
              share.shareId, share.sharedByUserId, sharer.email, {
                recipientName: bounded(sharer.displayName, "there"),
                responderDisplayName: actorName,
                answer: to,
                ...sharedDocumentFields(document, await workspaceNameOf(uow)),
              });
          }
        };

        switch (action) {
          case "accept":
            await answer("accepted");
            break;
          case "reject":
            await answer("rejected");
            break;
          case "withdraw-rejection": {
            const applied = await uow.documentSharing.updateShare(share.shareId,
              { from: ["rejected"], notDeleted: true },
              { status: "pending", recipientUserId: null, respondedAt: null, updatedAt: now });
            if (!applied) refuse("Only a rejected share can have its rejection withdrawn.");
            await record(uow, "document_share.rejection_withdrawn", userId, now, details, actorName);
            break;
          }
          case "delete": {
            const applied = await uow.documentSharing.updateShare(share.shareId,
              { from: ["rejected"], notDeleted: true },
              { recipientDeletedAt: now, updatedAt: now });
            if (!applied) refuse("Only a rejected share can be deleted.");
            await record(uow, "document_share.deleted", userId, now, details, actorName);
            return null;
          }
          case "remove-access": {
            const applied = await uow.documentSharing.updateShare(share.shareId, { from: ["accepted"] }, {
              status: "removed", removedAt: now, removedBy: "recipient", removedByUserId: userId, updatedAt: now,
            });
            if (!applied) refuse("Only an accepted share's access can be removed.");
            await record(uow, "document_share.access_removed", userId, now, details, actorName);
            return null;
          }
        }
        const updated = await uow.documentSharing.findShare(share.shareId);
        if (updated === null) throw new ResourceNotFoundError("SharedDocument");
        return presentSharedItem(uow, { kind: "share", record: updated });
      });
    });
}

/** The completed document an accepted share or approved request opens. */
async function openable<T>(
  userId: UserId, id: string, deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
  use: (uow: WorkspaceUnitOfWork, document: CompletedDocumentRecord) => Promise<T>,
): Promise<T> {
  const recipient = await recipientOf(userId, deps);
  return deps.transactions.runForSharingRecipient(
    { userId, verifiedEmail: recipient.verifiedEmail }, async ruow => {
      const item = await recipientItem(ruow, id);
      if (listedStatus(item) !== "accepted") throw new ResourceNotFoundError("SharedDocument");
      return ruow.enterWorkspace(item.record.workspaceId, async uow => {
        const document = await uow.documentSharing.findCompletedByVerification(item.record.verificationId);
        if (document === null) throw new ResourceNotFoundError("SharedDocument");
        return use(uow, document);
      });
    });
}

/** 083's details summary (masked participant emails, audit timeline). */
export async function getSharedDocumentDetails(
  userId: UserId, id: string, deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
): Promise<VerificationDetailsView> {
  return openable(userId, id, deps, async (uow, document) => {
    const projection = await uow.documentSharing.detailsProjection(document);
    if (projection === null) throw new ResourceNotFoundError("SharedDocument");
    return presentVerificationDetails(projection);
  });
}

/** The sealed PDF, streamed as 083's document route streams it. */
export async function openSharedDocument(
  userId: UserId, id: string,
  deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount" | "storage">,
): Promise<VerificationDocumentStream> {
  const ref = await openable(userId, id, deps, async (uow, document) => {
    const found = await uow.documentSharing.sealedDocumentRef(document);
    if (found === null) throw new ResourceNotFoundError("SharedDocument");
    return found;
  });
  const content = await deps.storage.getObject({
    zone: "artifacts", key: toStorageObjectKey(ref.storageReference),
  });
  if (content === null) throw new VerificationDocumentUnavailableError();
  return { mediaType: ref.mediaType, sizeBytes: ref.sizeBytes, stream: content.stream };
}

/**
 * The owner workspace's logo, for a recipient who is NOT a member of it:
 * reachable through any of their visible shares and their approved requests.
 */
export async function getSharedDocumentLogo(
  userId: UserId, id: string, deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly mediaType: "image/png" } | null> {
  const recipient = await recipientOf(userId, deps);
  return deps.transactions.runForSharingRecipient(
    { userId, verifiedEmail: recipient.verifiedEmail }, async ruow => {
      const item = await recipientItem(ruow, id);
      if (listedStatus(item) === null || !brandingVisible(item)) throw new ResourceNotFoundError("SharedDocument");
      return ruow.enterWorkspace(item.record.workspaceId, async uow => {
        const logo = await uow.branding.findLogo();
        return logo === null ? null : { bytes: logo.bytes, digest: logo.digest, mediaType: logo.mediaType };
      });
    });
}

// ── Requester side: by verification ID ────────────────────────────────────

interface Relation {
  readonly relation: DocumentAccessRelation;
  readonly shareId: string | null;
  readonly requestId: string | null;
}

/** The caller's relation to one completed document — about the caller only. */
async function relationOf(
  uow: WorkspaceUnitOfWork, document: CompletedDocumentRecord, userId: UserId, verifiedEmail: string | null,
): Promise<Relation> {
  const none = { shareId: null, requestId: null };
  const membership = await uow.memberships.findByUser(userId);
  if (membership !== null && document.ownerUserId === userId) return { relation: "owner", ...none };
  if (membership !== null && canManageAll(membership)) return { relation: "admin", ...none };
  if (verifiedEmail !== null && await uow.documentSharing.isParticipant(document, verifiedEmail)) {
    return { relation: "participant", ...none };
  }
  const shares = verifiedEmail === null ? [] : (await uow.documentSharing.listShares({
    verificationId: document.verificationId, normalizedEmail: verifiedEmail, statuses: LIVE_SHARE,
  })).filter(isLiveShare);
  const requests = (await uow.documentSharing.listAccessRequests({
    verificationId: document.verificationId, requesterUserId: userId,
  })).filter(isLiveRequest);
  const share = (status: DocumentShareStatus) => shares.find(s => s.status === status);
  const request = (status: DocumentAccessRequestStatus) => requests.find(r => r.status === status);

  const accepted = share("accepted");
  if (accepted !== undefined) return { relation: "shared-accepted", shareId: accepted.shareId, requestId: null };
  const approved = request("approved");
  if (approved !== undefined) return { relation: "shared-accepted", shareId: null, requestId: approved.requestId };
  const pendingShare = share("pending");
  if (pendingShare !== undefined) return { relation: "shared-pending", shareId: pendingShare.shareId, requestId: null };
  const pendingRequest = request("pending");
  if (pendingRequest !== undefined) {
    return { relation: "request-pending", shareId: null, requestId: pendingRequest.requestId };
  }
  const rejectedRequest = request("rejected");
  if (rejectedRequest !== undefined) {
    return { relation: "request-rejected", shareId: null, requestId: rejectedRequest.requestId };
  }
  const rejectedShare = share("rejected");
  if (rejectedShare !== undefined) return { relation: "shared-rejected", shareId: rejectedShare.shareId, requestId: null };
  return { relation: "none", ...none };
}

/**
 * The signed-in caller's relation to a completed document, by verification
 * ID. An unknown or uncompleted reference is `none` with nothing to request.
 */
export async function getMyDocumentAccess(
  userId: UserId, rawVerificationId: string,
  deps: Pick<DocumentSharingDependencies, "transactions" | "currentAccount">,
): Promise<MyDocumentAccessView> {
  const verificationId = parseVerificationId(rawVerificationId);
  const nothing = {
    verificationId: rawVerificationId.trim(), relation: "none" as const,
    shareId: null, requestId: null, canRequestAccess: false,
  };
  if (verificationId === null) return nothing;
  const recipient = await recipientOf(userId, deps);
  return deps.transactions.runForCompletedVerification(verificationId, async uow => {
    if (uow === null) return nothing;
    const document = await uow.documentSharing.findCompletedByVerification(verificationId);
    if (document === null) return nothing;
    const found = await relationOf(uow, document, userId, recipient.verifiedEmail);
    return {
      verificationId,
      ...found,
      canRequestAccess: found.relation === "none" && recipient.verifiedEmail !== null,
    };
  });
}

const REFUSALS: Partial<Record<DocumentAccessRelation, [
  ConstructorParameters<typeof DocumentAccessRequestRefusedError>[0], string,
]>> = {
  owner: ["document_access_already_granted", "You already have access to this document."],
  admin: ["document_access_already_granted", "You already have access to this document."],
  participant: ["document_access_already_granted", "You already have access to this document."],
  "shared-accepted": ["document_access_already_granted", "You already have access to this document."],
  "shared-pending": ["document_share_pending",
    "This document was already shared with you. Accept it from Shared with me."],
  "shared-rejected": ["document_share_rejected",
    "You rejected this document when it was shared with you. Withdraw that rejection from Shared with me."],
  "request-pending": ["document_access_request_pending", "You already asked for access to this document."],
  "request-rejected": ["document_access_request_rejected",
    "Your request for access to this document was rejected."],
};

/** A signed-in account with a VERIFIED address asks the owner for access. */
export async function requestDocumentAccess(
  userId: UserId, rawVerificationId: string, input: { readonly note?: string | null },
  deps: DocumentSharingDependencies,
): Promise<MyAccessRequestView> {
  const note = (input.note ?? "").trim();
  if ([...note].length > DOCUMENT_ACCESS_REQUEST_NOTE_MAX_LENGTH || /[\p{Cc}]/u.test(note.replace(/[\r\n\t]/gu, ""))) {
    throw new ApplicationValidationError("Check your note and try again.",
      [`note: at most ${String(DOCUMENT_ACCESS_REQUEST_NOTE_MAX_LENGTH)} characters`]);
  }
  const verificationId = parseVerificationId(rawVerificationId);
  if (verificationId === null) throw new ResourceNotFoundError("Verification");
  const recipient = await recipientOf(userId, deps);
  if (recipient.account === null || recipient.verifiedEmail === null) throw new AccountEmailUnverifiedError();
  const account = recipient.account;
  const verifiedEmail = recipient.verifiedEmail;

  return deps.transactions.runForCompletedVerification(verificationId, async uow => {
    if (uow === null) throw new ResourceNotFoundError("Verification");
    const document = await uow.documentSharing.findCompletedByVerification(verificationId);
    if (document === null) throw new ResourceNotFoundError("Verification");
    const found = await relationOf(uow, document, userId, verifiedEmail);
    const refusal = REFUSALS[found.relation];
    if (refusal !== undefined) throw new DocumentAccessRequestRefusedError(refusal[0], refusal[1]);

    const now = deps.clock.now();
    const requestId = deps.ids.nextDocumentAccessRequestId();
    const requesterName = bounded(account.displayName, account.email);
    await uow.documentSharing.insertAccessRequest({
      requestId,
      workspaceId: uow.workspaceId,
      documentId: document.documentId,
      signingRequestId: document.signingRequestId,
      verificationId: document.verificationId,
      requesterUserId: userId,
      requesterEmail: verifiedEmail,
      requesterName,
      note: note === "" ? null : note,
      createdAt: now,
    });
    await record(uow, "access_request.submitted", userId, now, {
      documentTitle: document.documentTitle, email: verifiedEmail,
    }, requesterName);

    // The owner only — and only while they are still a member to act on it.
    const owner = await memberOf(uow, document.ownerUserId);
    if (owner !== null) {
      await notifyUser(uow, deps, "DOCUMENT_ACCESS_REQUESTED", requestId, document.ownerUserId, owner.email, {
        recipientName: bounded(owner.displayName, "there"),
        requesterDisplayName: requesterName,
        requesterEmail: verifiedEmail,
        ...(note === "" ? {} : { note }),
        ...sharedDocumentFields(document, await workspaceNameOf(uow)),
      });
    }
    return {
      requestId,
      verificationId: document.verificationId,
      documentTitle: document.documentTitle,
      status: "pending",
      note: note === "" ? null : note,
      createdAt: now,
    };
  });
}
