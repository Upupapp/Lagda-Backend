// Joining a workspace by a single-use join link, always approved (078).
//
// Owners and administrators create TICKETS — one link for one person — as
// Drafts, send them (a fresh link and QR, optionally emailed), and withdraw
// them (the link dies; the ticket is kept and can be sent again with a new
// link). The first person to submit a request through a sent link uses it.
//
// Nobody joins directly. A request is pending until an owner or administrator
// approves it — giving the person the role "member" (shown as New Comer),
// optionally a typed role title and the two privileges — or declines it.

import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { hasCapability, type WorkspaceCapability } from "@lagda/core";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork, WorkspaceMemberIdGenerator,
} from "../common/ports/index.js";
import type {
  JoinIdGenerator, JoinRequestId, JoinRequestRecord, JoinRequestState,
  JoinTicketId, JoinTicketRecord, JoinTicketSecrets, JoinTicketTokenFactory,
} from "../common/ports/workspace-join.js";
import {
  JOIN_REQUEST_REASON_MAX_LENGTH, JOIN_TICKET_LABEL_MAX_LENGTH, MEMBER_ROLE_TITLE_MAX_LENGTH,
} from "../common/ports/workspace-join.js";
import type {
  NotificationDeliveryIdGenerator, NotificationIntentIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import {
  ApplicationError, ApplicationValidationError, ResourceConflictError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { assertCapability, privilegesOf, type WorkspaceAccessContext } from "./workspace-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Unknown, malformed or withdrawn — one answer, so a guess learns nothing. */
export class JoinLinkInvalidError extends ApplicationError {
  readonly category = "not-found" as const;
  readonly code = "join_link_invalid";
  constructor() { super("This join link isn't valid."); }
}

/** The one thing a visitor is told apart: somebody already used this link. */
export class JoinLinkUsedError extends ApplicationError {
  readonly category = "gone" as const;
  readonly code = "join_link_used";
  constructor() {
    super("This join link has already been used. Ask the workspace owner for a new one.");
  }
}

export class JoinAlreadyMemberError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "join_already_member";
  constructor() { super("You're already a member of this workspace."); }
}

export class JoinRequestPendingError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "join_request_pending";
  constructor() { super("You already have a request waiting for approval."); }
}

export class JoinEmailUnverifiedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "join_email_unverified";
  constructor() { super("Verify your email address before asking to join a workspace."); }
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface JoinAccount {
  readonly email: string;
  readonly normalizedEmail: string;
  readonly emailVerified: boolean;
}

export interface JoinNotifyDependencies {
  readonly templates: NotificationTemplateRegistry;
  readonly ids: JoinIdGenerator & NotificationIntentIdGenerator & NotificationDeliveryIdGenerator
    & WorkspaceMemberIdGenerator;
  readonly clock: Clock;
}

export interface JoinTicketDependencies extends JoinNotifyDependencies {
  readonly transactions: TransactionManager;
  readonly tokens: JoinTicketTokenFactory;
  readonly secrets: JoinTicketSecrets;
}

export interface JoinRequestDependencies extends JoinNotifyDependencies {
  readonly transactions: TransactionManager;
  readonly tokens: JoinTicketTokenFactory;
  readonly currentAccount: (userId: UserId) => Promise<JoinAccount | null>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
    privileges: privilegesOf(membership),
  };
  assertCapability(access, capability);
  return access;
}

function text(value: string | null | undefined, field: string, max: number, required: boolean): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    if (required) throw new ApplicationValidationError("Check the details and try again.", [`${field}: required`]);
    return null;
  }
  if (trimmed.length > max) {
    throw new ApplicationValidationError("Check the details and try again.", [`${field}: at most ${String(max)} characters`]);
  }
  return trimmed;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function optionalEmail(value: string | null | undefined): string | null {
  const email = text(value, "recipientEmail", 320, false);
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new ApplicationValidationError("Check the details and try again.", ["recipientEmail: not an email address"]);
  }
  return email?.toLowerCase() ?? null;
}

function notify(deps: JoinNotifyDependencies, uow: WorkspaceUnitOfWork) {
  return createNotificationIntent({
    notifications: uow.notifications,
    templates: deps.templates,
    ids: deps.ids,
    clock: deps.clock,
  });
}

// ── Ticket views ─────────────────────────────────────────────────────────────

export interface JoinTicketView {
  readonly ticketId: JoinTicketId;
  readonly label: string;
  readonly recipientEmail: string | null;
  readonly state: JoinTicketRecord["state"];
  /** The live link's token, for the admin's Copy/QR; only while Sent. */
  readonly linkToken: string | null;
  readonly sentAt: number | null;
  readonly withdrawnAt: number | null;
  readonly usedAt: number | null;
  /** The request that used it, if any — its outcome shows on the Sent list. */
  readonly request: { readonly requestId: JoinRequestId; readonly fullName: string;
    readonly state: JoinRequestState } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toTicketView(
  ticket: JoinTicketRecord, secrets: JoinTicketSecrets, requests: readonly JoinRequestRecord[],
): JoinTicketView {
  const used = requests
    .filter(r => r.ticketId === ticket.ticketId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    ticketId: ticket.ticketId,
    label: ticket.label,
    recipientEmail: ticket.recipientEmail,
    state: ticket.state,
    linkToken: ticket.state === "sent" && ticket.sealedToken !== null ? secrets.open(ticket.sealedToken) : null,
    sentAt: ticket.sentAt,
    withdrawnAt: ticket.withdrawnAt,
    usedAt: ticket.usedAt,
    request: used === undefined || ticket.usedAt === null || used.createdAt < (ticket.sentAt ?? 0)
      ? null
      : { requestId: used.requestId, fullName: used.fullName, state: used.state },
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

// ── Tickets ──────────────────────────────────────────────────────────────────

export async function listJoinTickets(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: JoinTicketDependencies,
): Promise<readonly JoinTicketView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "invitation.view");
    const [tickets, requests] = await Promise.all([uow.joinTickets.list(), uow.joinRequests.list(null)]);
    return tickets.map(t => toTicketView(t, deps.secrets, requests));
  });
}

export async function createJoinTicket(
  actor: AuthenticatedActor, workspaceId: WorkspaceId,
  input: { readonly label: string; readonly recipientEmail?: string | null },
  deps: JoinTicketDependencies,
): Promise<JoinTicketView> {
  const label = text(input.label, "label", JOIN_TICKET_LABEL_MAX_LENGTH, true) as string;
  const recipientEmail = optionalEmail(input.recipientEmail);
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "invitation.create");
    const now = deps.clock.now();
    const ticket: JoinTicketRecord = {
      ticketId: deps.ids.nextJoinTicketId(), workspaceId, label, recipientEmail,
      state: "draft", tokenDigest: null, sealedToken: null, sealedKeyVersion: null,
      workspaceName: null, sentByName: null, sentByUserId: null, sentAt: null,
      withdrawnAt: null, usedAt: null, usedByUserId: null,
      createdByUserId: actor.userId, createdAt: now, updatedAt: now,
    };
    await uow.joinTickets.insert(ticket);
    return toTicketView(ticket, deps.secrets, []);
  });
}

export async function updateJoinTicketDraft(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, ticketId: string,
  input: { readonly label: string; readonly recipientEmail?: string | null },
  deps: JoinTicketDependencies,
): Promise<JoinTicketView> {
  const label = text(input.label, "label", JOIN_TICKET_LABEL_MAX_LENGTH, true) as string;
  const recipientEmail = optionalEmail(input.recipientEmail);
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "invitation.create");
    const updated = await uow.joinTickets.updateDraft({
      ticketId: ticketId as JoinTicketId, label, recipientEmail, now: deps.clock.now(),
    });
    if (!updated) throw new ResourceConflictError("Only a draft can be edited.");
    const ticket = await uow.joinTickets.find(ticketId as JoinTicketId);
    if (ticket === null) throw new ResourceNotFoundError("Join link");
    return toTicketView(ticket, deps.secrets, []);
  });
}

/**
 * Draft or Withdrawn → Sent with a brand-new link. Emails it when asked and
 * the ticket names an address.
 */
export async function sendJoinTicket(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, ticketId: string,
  input: { readonly email: boolean },
  deps: JoinTicketDependencies,
): Promise<JoinTicketView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "invitation.create");
    const existing = await uow.joinTickets.find(ticketId as JoinTicketId);
    if (existing === null) throw new ResourceNotFoundError("Join link");
    if (existing.state === "sent") throw new ResourceConflictError("This join link is already sent.");
    if (input.email && existing.recipientEmail === null) {
      throw new ApplicationValidationError("Add an email address to send this link by email.",
        ["recipientEmail: required to email the link"]);
    }

    const now = deps.clock.now();
    const credential = deps.tokens.issue();
    const sealedToken = deps.secrets.seal(credential.raw);
    const workspace = await uow.workspaces.find();
    const workspaceName = workspace?.name ?? "LAGDA";
    const sentByName = await uow.actorProfiles.displayNameOf(actor.userId) ?? workspaceName;

    const sent = await uow.joinTickets.markSent({
      ticketId: existing.ticketId, tokenDigest: credential.digest,
      sealedToken, sealedKeyVersion: deps.secrets.keyVersion,
      workspaceName, sentByName, sentByUserId: actor.userId, now,
    });
    if (!sent) throw new ResourceConflictError("This join link changed. Refresh and try again.");

    if (input.email && existing.recipientEmail !== null) {
      await notify(deps, uow)({
        notificationType: "WORKSPACE_JOIN_LINK",
        // Each send is its own source, so sending again is a new email.
        sourceId: deps.ids.nextJoinNoticeId(),
        scope: { kind: "WORKSPACE", workspaceId },
        audience: { kind: "WORKSPACE_JOIN_TICKET", joinTicketId: existing.ticketId },
        destination: existing.recipientEmail,
        templateInput: { workspaceName, senderDisplayName: sentByName },
        secretRef: { kind: "SEALED", sealed: sealedToken as never, keyVersion: deps.secrets.keyVersion },
      }, uow);
    }

    const ticket = await uow.joinTickets.find(existing.ticketId);
    if (ticket === null) throw new ResourceNotFoundError("Join link");
    return toTicketView(ticket, deps.secrets, []);
  });
}

/** Draft or Sent → Withdrawn. The live link dies at once; the ticket stays on record. */
export async function withdrawJoinTicket(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, ticketId: string,
  deps: JoinTicketDependencies,
): Promise<JoinTicketView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "invitation.revoke");
    const withdrawn = await uow.joinTickets.withdraw({
      ticketId: ticketId as JoinTicketId, now: deps.clock.now(),
    });
    if (!withdrawn) throw new ResourceConflictError("This join link can't be withdrawn.");
    const ticket = await uow.joinTickets.find(ticketId as JoinTicketId);
    if (ticket === null) throw new ResourceNotFoundError("Join link");
    return toTicketView(ticket, deps.secrets, []);
  });
}

// ── The public link ──────────────────────────────────────────────────────────

export interface JoinLinkPreview {
  readonly workspaceName: string;
  readonly invitedByName: string | null;
}

/** What the join page shows before anyone signs in. Reads, writes nothing. */
export async function previewJoinLink(
  rawToken: string, deps: Pick<JoinRequestDependencies, "transactions" | "tokens">,
): Promise<JoinLinkPreview> {
  const digest = deps.tokens.digest(rawToken);
  if (digest === null) throw new JoinLinkInvalidError();
  return deps.transactions.runForJoinTicketCredential(digest, async uow => {
    const ticket = await uow.ticket.find();
    if (ticket === null || ticket.state !== "sent") throw new JoinLinkInvalidError();
    if (ticket.usedAt !== null) throw new JoinLinkUsedError();
    return { workspaceName: ticket.workspaceName ?? "a LAGDA workspace", invitedByName: ticket.sentByName };
  });
}

export interface SubmittedJoinRequest {
  readonly requestId: JoinRequestId;
  readonly workspaceName: string;
  readonly state: "pending";
}

async function notifyAdminsOfRequest(
  uow: WorkspaceUnitOfWork, deps: JoinNotifyDependencies, request: JoinRequestRecord, workspaceName: string,
): Promise<void> {
  const members = await uow.memberships.listWithAccounts();
  for (const admin of members.filter(m => hasCapability(m.role, "membership.role.change"))) {
    await notify(deps, uow)({
      notificationType: "WORKSPACE_JOIN_REQUESTED",
      sourceId: deps.ids.nextJoinNoticeId(),
      scope: { kind: "WORKSPACE", workspaceId: request.workspaceId },
      audience: { kind: "USER", userId: admin.userId },
      destination: admin.email,
      templateInput: {
        recipientName: admin.displayName,
        requesterName: request.fullName,
        requesterEmail: request.email,
        workspaceName,
        ...(request.reason === null ? {} : { reason: request.reason }),
      },
    }, uow);
  }
}

/**
 * A signed-in person asks to join through a link. Their address is the
 * account's VERIFIED one — never typed. The link is used by this request.
 */
export async function submitJoinRequest(
  actor: AuthenticatedActor, rawToken: string,
  input: { readonly fullName: string; readonly reason?: string | null },
  deps: JoinRequestDependencies,
): Promise<SubmittedJoinRequest> {
  const fullName = text(input.fullName, "fullName", 200, true) as string;
  if (fullName.length < 2) {
    throw new ApplicationValidationError("Check the details and try again.", ["fullName: at least 2 characters"]);
  }
  const reason = text(input.reason, "reason", JOIN_REQUEST_REASON_MAX_LENGTH, false);
  const digest = deps.tokens.digest(rawToken);
  if (digest === null) throw new JoinLinkInvalidError();

  const account = await deps.currentAccount(actor.userId);
  if (account === null) throw new JoinLinkInvalidError();
  if (!account.emailVerified) throw new JoinEmailUnverifiedError();

  return deps.transactions.runForJoinTicketCredential(digest, async credential => {
    const ticket = await credential.ticket.find();
    if (ticket === null || ticket.state !== "sent") throw new JoinLinkInvalidError();
    if (ticket.usedAt !== null) throw new JoinLinkUsedError();

    return credential.enterWorkspace(ticket.workspaceId, async uow => {
      if (await uow.memberships.findByUser(actor.userId) !== null) throw new JoinAlreadyMemberError();
      if (await uow.joinRequests.findPendingForUser(actor.userId) !== null) throw new JoinRequestPendingError();

      const now = deps.clock.now();
      // The single-use gate. Of two people racing one link, exactly one passes.
      const used = await uow.joinTickets.markUsedIfUnused({ ticketId: ticket.ticketId, userId: actor.userId, now });
      if (!used) throw new JoinLinkUsedError();

      const request: JoinRequestRecord = {
        requestId: deps.ids.nextJoinRequestId(), workspaceId: ticket.workspaceId,
        sourceKind: "ticket", ticketId: ticket.ticketId, invitationId: null,
        userId: actor.userId, fullName, email: account.email, reason,
        requestedRole: "member", state: "pending", decidedByUserId: null, decidedAt: null, createdAt: now,
      };
      await uow.joinRequests.insert(request);
      const workspaceName = ticket.workspaceName ?? (await uow.workspaces.find())?.name ?? "LAGDA";
      await notifyAdminsOfRequest(uow, deps, request, workspaceName);
      return { requestId: request.requestId, workspaceName, state: "pending" };
    });
  });
}

/**
 * The same approval step for an emailed invitation (078): accepting one no
 * longer joins — it files a pending request carrying the invited role.
 */
export async function fileInvitationJoinRequest(
  uow: WorkspaceUnitOfWork, deps: JoinNotifyDependencies,
  input: {
    readonly invitationId: string; readonly userId: UserId; readonly fullName: string;
    readonly email: string; readonly requestedRole: JoinRequestRecord["requestedRole"];
    readonly workspaceName: string;
  },
): Promise<JoinRequestRecord> {
  const pending = await uow.joinRequests.findPendingForUser(input.userId);
  if (pending !== null) return pending;
  const request: JoinRequestRecord = {
    requestId: deps.ids.nextJoinRequestId(), workspaceId: uow.workspaceId,
    sourceKind: "invitation", ticketId: null, invitationId: input.invitationId,
    userId: input.userId, fullName: input.fullName, email: input.email, reason: null,
    requestedRole: input.requestedRole, state: "pending",
    decidedByUserId: null, decidedAt: null, createdAt: deps.clock.now(),
  };
  await uow.joinRequests.insert(request);
  await notifyAdminsOfRequest(uow, deps, request, input.workspaceName);
  return request;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface JoinRequestView {
  readonly requestId: JoinRequestId;
  readonly sourceKind: "ticket" | "invitation";
  readonly ticketLabel: string | null;
  readonly fullName: string;
  readonly email: string;
  readonly reason: string | null;
  readonly requestedRole: JoinRequestRecord["requestedRole"];
  readonly state: JoinRequestState;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export async function listJoinRequests(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, state: JoinRequestState | null,
  deps: Pick<JoinTicketDependencies, "transactions">,
): Promise<readonly JoinRequestView[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "membership.view");
    const [requests, tickets] = await Promise.all([uow.joinRequests.list(state), uow.joinTickets.list()]);
    const labels = new Map(tickets.map(t => [t.ticketId, t.label]));
    return requests.map(r => ({
      requestId: r.requestId, sourceKind: r.sourceKind,
      ticketLabel: r.ticketId === null ? null : labels.get(r.ticketId) ?? null,
      fullName: r.fullName, email: r.email, reason: r.reason, requestedRole: r.requestedRole,
      state: r.state, createdAt: r.createdAt, decidedAt: r.decidedAt,
    }));
  });
}

export interface MemberAccessInput {
  readonly roleTitle?: string | null;
  readonly canRequestDocuments?: boolean;
  readonly canAssignSigners?: boolean;
}

function accessFields(input: MemberAccessInput) {
  return {
    roleTitle: text(input.roleTitle, "roleTitle", MEMBER_ROLE_TITLE_MAX_LENGTH, false),
    canRequestDocuments: input.canRequestDocuments === true,
    canAssignSigners: input.canAssignSigners === true,
  };
}

async function notifyDecision(
  uow: WorkspaceUnitOfWork, deps: JoinNotifyDependencies, request: JoinRequestRecord, approved: boolean,
): Promise<void> {
  const workspaceName = (await uow.workspaces.find())?.name ?? "LAGDA";
  await notify(deps, uow)({
    notificationType: "WORKSPACE_JOIN_DECIDED",
    sourceId: request.requestId,
    scope: { kind: "WORKSPACE", workspaceId: request.workspaceId },
    audience: { kind: "USER", userId: request.userId },
    destination: request.email,
    templateInput: { recipientName: request.fullName, workspaceName, approved },
  }, uow);
}

/** Approve: the person becomes a member — a New Comer unless a title is typed. */
export async function approveJoinRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  input: MemberAccessInput, deps: JoinNotifyDependencies & Pick<JoinTicketDependencies, "transactions">,
): Promise<{ readonly memberId: WorkspaceMemberId }> {
  const access = accessFields(input);
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "membership.role.change");
    const request = await uow.joinRequests.find(requestId as JoinRequestId);
    if (request === null) throw new ResourceNotFoundError("Join request");
    const now = deps.clock.now();
    const decided = await uow.joinRequests.decideIfPending({
      requestId: request.requestId, state: "approved", decidedByUserId: actor.userId, now,
    });
    if (!decided) throw new ResourceConflictError("This request was already decided.");

    const existing = await uow.memberships.findByUser(request.userId);
    const memberId = existing?.memberId ?? deps.ids.nextWorkspaceMemberId();
    if (existing === null) {
      await uow.memberships.insert({
        memberId, workspaceId, userId: request.userId,
        role: request.requestedRole, createdAt: now, ...access,
      });
    }
    await notifyDecision(uow, deps, request, true);
    return { memberId };
  });
}

export async function declineJoinRequest(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, requestId: string,
  deps: JoinNotifyDependencies & Pick<JoinTicketDependencies, "transactions">,
): Promise<{ readonly declined: true }> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "membership.role.change");
    const request = await uow.joinRequests.find(requestId as JoinRequestId);
    if (request === null) throw new ResourceNotFoundError("Join request");
    const decided = await uow.joinRequests.decideIfPending({
      requestId: request.requestId, state: "declined", decidedByUserId: actor.userId, now: deps.clock.now(),
    });
    if (!decided) throw new ResourceConflictError("This request was already decided.");
    await notifyDecision(uow, deps, request, false);
    return { declined: true };
  });
}

/** An owner or administrator sets any member's typed title and the two privileges. */
export async function updateMemberAccess(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, memberId: string,
  input: MemberAccessInput, deps: Pick<JoinTicketDependencies, "transactions">,
): Promise<{ readonly updated: true }> {
  const access = accessFields(input);
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "membership.role.change");
    const updated = await uow.memberships.updateAccess({ memberId: memberId as WorkspaceMemberId, ...access });
    if (!updated) throw new ResourceNotFoundError("Workspace member");
    return { updated: true };
  });
}
