// Plans (093): who is on what, the Free allowance, and test-mode upgrades.
//
// ── The rules ─────────────────────────────────────────────────────────────
//
// A plan is a PERSON's. A workspace has paid features while its OWNER's plan
// is paid; everything a workspace offers is decided by `workspaceOwnerPlan`,
// never by the plan of whoever happens to be asking.
//
// Free sends ONE document, for life, under a Free owner's workspace. The
// allowance is taken by a conditional increment in the send path (see
// `claimFreeDocumentForSend`) and given back if that send does not commit.
//
// A paid plan lasts until `paidUntil`, then reads as Free. Nothing is deleted:
// the workspace's members, teams and branding stay stored and come back with
// the next paid month. A renewing plan (`autoRenew`) never lapses.
//
// ── Upgrading in test mode ────────────────────────────────────────────────
//
// No payment provider exists yet. The form accepts ONLY the published sample
// account, so no real bank number can be stored, logged or emailed — only the
// fact that it matched is kept. The LAGDA owner (PLAN_APPROVER_EMAIL) is told,
// and approves or declines inside the app with their own session: the email
// carries no credential. A request is open for seven days.

import type { UserId, WorkspaceId } from "@lagda/contracts";
import { findWorkspaceOwner } from "@lagda/core";
import type { Clock, TransactionManager } from "../common/ports/index.js";
import type {
  PlanId, PlanRepository, PlanUpgradeRequestRecord, PlanUpgradeRequestIdGenerator,
  RequestablePlanId, UserPlanRecord, PlanUnitOfWork, PlanAccount,
} from "../common/ports/plans.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { normalizeEmail } from "../auth/email-identity.js";

export const FREE_DOCUMENT_LIMIT = 1;
export const PLAN_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Pesos a month (per user for Business). */
export const PLAN_PRICES: Readonly<Record<RequestablePlanId, number>> = Object.freeze({
  personal: 299,
  business: 799,
});

export const PLAN_NAMES: Readonly<Record<PlanId, string>> = Object.freeze({
  free: "Free",
  personal: "Personal",
  business: "Business",
  enterprise: "Enterprise",
});

/** The one account the test-mode form accepts. Fictional on purpose. */
export const SAMPLE_BANK_ACCOUNT = Object.freeze({
  bankName: "LAGDA Test Bank",
  accountName: "LAGDA Test Account",
  accountNumber: "0000-1234-5678",
  branch: "Test Branch",
  swiftCode: "LAGDTEST",
});
export type BankDetails = { readonly [K in keyof typeof SAMPLE_BANK_ACCOUNT]: string };

// ── Errors ─────────────────────────────────────────────────────────────────

type Detail = { field: string; code: string; message: string };

/** 403: the workspace owner's plan does not include this. */
export class PlanRequiredError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "plan_required";
  readonly details: readonly Detail[];

  constructor(readonly requiredPlan: "personal" | "business", feature: string) {
    super(`${feature} needs the ${PLAN_NAMES[requiredPlan]} plan or higher.`);
    this.details = [{ field: "plan", code: requiredPlan, message: this.message }];
  }
}

/** 409: the Free document has been used. */
export class FreeDocumentLimitError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "free_document_limit_reached";

  constructor() {
    super("You've used your free document. Choose Personal or Business to send more.");
  }
}

/** 422: anything but the sample account was entered. */
export class TestBankAccountError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "test_bank_account_required";
  readonly details: readonly Detail[];

  constructor(fields: readonly string[]) {
    super("Test mode: please use the sample account shown.");
    this.details = fields.map(field => ({ field, code: "sample_only", message: this.message }));
  }
}

/** 409 with a reason a client can act on. */
export class PlanUpgradeConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code: string;

  constructor(reason: "pending" | "not_pending" | "unavailable", message: string) {
    super(message);
    this.code = `plan_upgrade_${reason}`;
  }
}

// ── Reading a plan ─────────────────────────────────────────────────────────

const MONTH_DAYS_FALLBACK = 30 * 24 * 60 * 60 * 1000;

/** One calendar month after `from` (the same day, clamped to the month's end). */
export function addOneMonth(from: number): number {
  const d = new Date(from);
  const day = d.getUTCDate();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  const result = next.getTime();
  return Number.isFinite(result) ? result : from + MONTH_DAYS_FALLBACK;
}

/** The plan in force now. No row, a lapsed month, or Free all read as Free. */
export function effectivePlan(record: UserPlanRecord | null, now: number): PlanId {
  if (record === null || record.plan === "free") return "free";
  if (record.autoRenew) return record.plan;
  return record.paidUntil !== null && record.paidUntil > now ? record.plan : "free";
}

/** When the current paid period ends; a renewing plan rolls month by month. */
export function currentPeriodEnd(record: UserPlanRecord | null, now: number): number | null {
  if (record === null || effectivePlan(record, now) === "free") return null;
  if (!record.autoRenew) return record.paidUntil;
  let end = record.paidUntil ?? addOneMonth(record.updatedAt);
  for (let i = 0; end <= now && i < 1200; i++) end = addOneMonth(end);
  return end;
}

const RANK: Readonly<Record<PlanId, number>> = { free: 0, personal: 1, business: 2, enterprise: 3 };

/** Whether `plan` includes everything `minimum` does. */
export function planIncludes(plan: PlanId, minimum: PlanId): boolean {
  return RANK[plan] >= RANK[minimum];
}

// ── Dependencies ───────────────────────────────────────────────────────────

export interface PlanReadDependencies {
  readonly plans: PlanRepository;
  readonly transactions: TransactionManager;
  readonly clock: Clock;
}

export interface PlanDependencies extends PlanReadDependencies {
  readonly ids: PlanUpgradeRequestIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  /** Who approves upgrades, or null when upgrades are not offered. */
  readonly approverEmail: string | null;
}

function notifier(uow: PlanUnitOfWork, deps: PlanDependencies) {
  return createNotificationIntent({
    notifications: uow.notifications,
    templates: deps.templates,
    ids: deps.notificationIds,
    clock: deps.clock,
  });
}

function normalized(email: string | null): string | null {
  if (email === null) return null;
  const result = normalizeEmail(email);
  return result.outcome === "ok" ? result.normalized : null;
}

async function isApprover(actor: AuthenticatedActor, deps: PlanDependencies): Promise<boolean> {
  const approver = normalized(deps.approverEmail);
  if (approver === null) return false;
  const account = await deps.plans.account(actor.userId);
  return account !== null && normalized(account.email) === approver;
}

async function requireApprover(actor: AuthenticatedActor, deps: PlanDependencies): Promise<void> {
  // Not-found rather than forbidden: nobody else learns these pages exist.
  if (!(await isApprover(actor, deps))) throw new ResourceNotFoundError("PlanUpgradeRequest");
}

const formatDate = (at: number): string =>
  new Date(at).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Manila" });

const formatPesos = (amount: number): string =>
  `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A pending request past its seven days reads as expired. */
function statusAt(request: PlanUpgradeRequestRecord, now: number): PlanUpgradeRequestRecord["status"] {
  return request.status === "pending" && request.expiresAt <= now ? "expired" : request.status;
}

// ── Views ──────────────────────────────────────────────────────────────────

export interface PlanUpgradeRequestView {
  readonly requestId: string;
  readonly plan: RequestablePlanId;
  readonly amountPesos: number;
  readonly status: PlanUpgradeRequestRecord["status"];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
}

export interface MyPlanView {
  readonly plan: PlanId;
  /** The plan stored, which may have lapsed to Free. */
  readonly storedPlan: PlanId;
  readonly paidUntil: number | null;
  readonly autoRenew: boolean;
  readonly freeDocumentsUsed: number;
  readonly freeDocumentLimit: number;
  readonly pendingRequest: PlanUpgradeRequestView | null;
  /** Whether this account approves upgrades. */
  readonly approver: boolean;
  /** Whether upgrades can be requested at all right now. */
  readonly upgradesAvailable: boolean;
}

function requestView(request: PlanUpgradeRequestRecord, now: number): PlanUpgradeRequestView {
  return {
    requestId: request.requestId,
    plan: request.plan,
    amountPesos: request.amountPesos,
    status: statusAt(request, now),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    decidedAt: request.decidedAt,
  };
}

export async function getMyPlan(actor: AuthenticatedActor, deps: PlanDependencies): Promise<MyPlanView> {
  const now = deps.clock.now();
  const record = await deps.plans.find(actor.userId);
  const pending = await deps.plans.findPendingRequest(actor.userId);
  const live = pending !== null && statusAt(pending, now) === "pending" ? pending : null;
  return {
    plan: effectivePlan(record, now),
    storedPlan: record?.plan ?? "free",
    paidUntil: currentPeriodEnd(record, now),
    autoRenew: record?.autoRenew ?? false,
    freeDocumentsUsed: record?.freeDocumentsUsed ?? 0,
    freeDocumentLimit: FREE_DOCUMENT_LIMIT,
    pendingRequest: live === null ? null : requestView(live, now),
    approver: await isApprover(actor, deps),
    upgradesAvailable: normalized(deps.approverEmail) !== null,
  };
}

// ── A workspace's plan: its owner's ────────────────────────────────────────

export interface WorkspaceOwnerPlan {
  readonly ownerUserId: UserId | null;
  readonly plan: PlanId;
}

/** The plan of the workspace's owner. A workspace with no owner reads as Free. */
export async function workspaceOwnerPlan(
  workspaceId: WorkspaceId,
  deps: PlanReadDependencies,
): Promise<WorkspaceOwnerPlan> {
  const owner = await deps.transactions.runForWorkspace(workspaceId, async uow =>
    findWorkspaceOwner(await uow.memberships.list())?.userId ?? null);
  if (owner === null) return { ownerUserId: null, plan: "free" };
  return { ownerUserId: owner, plan: effectivePlan(await deps.plans.find(owner), deps.clock.now()) };
}

export interface WorkspacePlanView {
  readonly plan: PlanId;
  readonly ownerIsYou: boolean;
  readonly ownerName: string | null;
  readonly paidUntil: number | null;
}

/** For a member of the workspace: what it offers, and whose plan decides it. */
export async function getWorkspacePlan(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  deps: PlanReadDependencies,
): Promise<WorkspacePlanView> {
  const { owner, member } = await deps.transactions.runForWorkspace(workspaceId, async uow => ({
    member: await uow.memberships.findByUser(actor.userId),
    owner: findWorkspaceOwner(await uow.memberships.list())?.userId ?? null,
  }));
  if (member === null) throw new ResourceNotFoundError("Workspace");
  if (owner === null) return { plan: "free", ownerIsYou: false, ownerName: null, paidUntil: null };
  const now = deps.clock.now();
  const record = await deps.plans.find(owner);
  const account = await deps.plans.account(owner);
  return {
    plan: effectivePlan(record, now),
    ownerIsYou: owner === actor.userId,
    ownerName: account?.displayName ?? null,
    paidUntil: currentPeriodEnd(record, now),
  };
}

/**
 * Refuses when the workspace owner's plan is below `minimum`. Optional deps:
 * a composition without plans (tests, tools) gates nothing.
 *
 * With `memberUserId`, a caller who is not a member passes straight through,
 * so the operation's own not-found answers them — a plan error would confirm
 * the workspace exists.
 */
export async function requireWorkspacePlan(
  workspaceId: WorkspaceId,
  minimum: "personal" | "business",
  feature: string,
  deps: PlanReadDependencies | undefined,
  memberUserId?: UserId,
): Promise<void> {
  if (deps === undefined) return;
  const { owner, member } = await deps.transactions.runForWorkspace(workspaceId, async uow => ({
    owner: findWorkspaceOwner(await uow.memberships.list())?.userId ?? null,
    member: memberUserId === undefined ? true : (await uow.memberships.findByUser(memberUserId)) !== null,
  }));
  if (!member) return;
  const plan = owner === null ? "free" : effectivePlan(await deps.plans.find(owner), deps.clock.now());
  if (!planIncludes(plan, minimum)) throw new PlanRequiredError(minimum, feature);
}

/**
 * Refuses when the PERSON's own plan is below `minimum` — for what a person
 * does as themselves rather than inside a workspace: joining another
 * workspace, by invitation or by join link.
 */
export async function requireOwnPlan(
  userId: UserId,
  minimum: "personal" | "business",
  feature: string,
  deps: Pick<PlanReadDependencies, "plans" | "clock"> | undefined,
): Promise<void> {
  if (deps === undefined) return;
  const plan = effectivePlan(await deps.plans.find(userId), deps.clock.now());
  if (!planIncludes(plan, minimum)) throw new PlanRequiredError(minimum, feature);
}

/**
 * The send path's Free allowance. Called INSIDE the send transaction, after
 * every other check has passed, with the owner read from that transaction.
 * Returns the account whose allowance was taken (to give back on rollback),
 * or null when the owner is paid.
 */
export async function claimFreeDocumentForSend(
  ownerUserId: UserId | null,
  senderUserId: UserId,
  deps: { readonly plans: PlanRepository; readonly clock: Clock },
): Promise<UserId | null> {
  const now = deps.clock.now();
  const plan = ownerUserId === null ? "free" : effectivePlan(await deps.plans.find(ownerUserId), now);
  if (plan !== "free") return null;
  const claimed = await deps.plans.claimFreeDocument(senderUserId, FREE_DOCUMENT_LIMIT, now);
  if (!claimed) throw new FreeDocumentLimitError();
  return senderUserId;
}

/**
 * Whether this person may create a workspace: a paid plan, or their first
 * one (a Free account's own space for its documents).
 */
export async function assertMayCreateWorkspace(
  actor: AuthenticatedActor,
  deps: PlanReadDependencies | undefined,
): Promise<void> {
  if (deps === undefined) return;
  const plan = effectivePlan(await deps.plans.find(actor.userId), deps.clock.now());
  if (plan !== "free") return;
  const owned = await deps.transactions.runForUser(actor.userId, async uow =>
    (await uow.memberships.listWorkspaces()).filter(m => findWorkspaceOwner([m]) !== undefined).length);
  if (owned > 0) throw new PlanRequiredError("personal", "Creating another workspace");
}

// ── Requesting an upgrade ──────────────────────────────────────────────────

const squash = (value: string): string => value.trim().toLowerCase().replace(/[\s\-_.]+/g, "");

/** Every field that does not match the sample account. */
export function bankMismatches(bank: BankDetails): string[] {
  return (Object.keys(SAMPLE_BANK_ACCOUNT) as (keyof BankDetails)[])
    .filter(field => squash(bank[field] ?? "") !== squash(SAMPLE_BANK_ACCOUNT[field]));
}

async function approverAccount(deps: PlanDependencies): Promise<PlanAccount> {
  const email = normalized(deps.approverEmail);
  const account = email === null ? null : await deps.plans.accountByNormalizedEmail(email);
  if (account === null) {
    throw new PlanUpgradeConflictError("unavailable", "Upgrades are not available right now. Please try again later.");
  }
  return account;
}

export async function requestPlanUpgrade(
  actor: AuthenticatedActor,
  input: { readonly plan: RequestablePlanId; readonly bank: BankDetails },
  deps: PlanDependencies,
): Promise<PlanUpgradeRequestView> {
  if (input.plan !== "personal" && input.plan !== "business") {
    throw new ApplicationValidationError("Choose Personal or Business.", ["plan"]);
  }
  const mismatched = bankMismatches(input.bank);
  if (mismatched.length > 0) throw new TestBankAccountError(mismatched);

  const approver = await approverAccount(deps);
  const requester = await deps.plans.account(actor.userId);
  if (requester === null) throw new ResourceNotFoundError("Account");

  const now = deps.clock.now();
  const existing = await deps.plans.findPendingRequest(actor.userId);
  if (existing !== null && statusAt(existing, now) === "pending") {
    throw new PlanUpgradeConflictError("pending", "You already have a request waiting for approval.");
  }

  const request: PlanUpgradeRequestRecord = {
    requestId: deps.ids.nextPlanUpgradeRequestId(),
    userId: actor.userId,
    plan: input.plan,
    amountPesos: PLAN_PRICES[input.plan],
    status: "pending",
    createdAt: now,
    expiresAt: now + PLAN_REQUEST_LIFETIME_MS,
    decidedAt: null,
    decidedBy: null,
  };

  await deps.plans.transact(approver.userId, async uow => {
    // A stale pending request makes way for the new one.
    if (existing !== null) {
      await uow.decideRequest({ requestId: existing.requestId, status: "expired", at: now, decidedBy: null });
    }
    await uow.insertRequest(request);
    await notifier(uow, deps)({
      notificationType: "PLAN_UPGRADE_REQUESTED",
      sourceId: request.requestId,
      scope: { kind: "GLOBAL_USER", userId: approver.userId },
      audience: { kind: "USER", userId: approver.userId },
      destination: approver.email,
      templateInput: {
        recipientName: approver.displayName,
        requesterDisplayName: requester.displayName,
        requesterEmail: requester.email,
        planName: PLAN_NAMES[request.plan],
        amount: formatPesos(request.amountPesos),
        expiresAt: formatDate(request.expiresAt),
        requestId: request.requestId,
      },
    }, uow.transaction);
  });

  return requestView(request, now);
}

export async function cancelMyPlanUpgradeRequest(
  actor: AuthenticatedActor,
  deps: PlanDependencies,
): Promise<void> {
  const pending = await deps.plans.findPendingRequest(actor.userId);
  if (pending === null) throw new PlanUpgradeConflictError("not_pending", "There is no request to cancel.");
  const at = deps.clock.now();
  await deps.plans.transact(actor.userId, uow =>
    uow.decideRequest({ requestId: pending.requestId, status: "cancelled", at, decidedBy: actor.userId }));
}

// ── Deciding (the approver only) ───────────────────────────────────────────

export interface PlanUpgradeReviewView extends PlanUpgradeRequestView {
  readonly requesterName: string;
  readonly requesterEmail: string;
  readonly currentPlan: PlanId;
}

async function review(request: PlanUpgradeRequestRecord, deps: PlanDependencies, now: number): Promise<PlanUpgradeReviewView> {
  const account = await deps.plans.account(request.userId);
  return {
    ...requestView(request, now),
    requesterName: account?.displayName ?? "A LAGDA user",
    requesterEmail: account?.email ?? "",
    currentPlan: effectivePlan(await deps.plans.find(request.userId), now),
  };
}

export async function listPendingPlanUpgradeRequests(
  actor: AuthenticatedActor,
  deps: PlanDependencies,
): Promise<readonly PlanUpgradeReviewView[]> {
  await requireApprover(actor, deps);
  const now = deps.clock.now();
  const pending = (await deps.plans.listPendingRequests()).filter(r => statusAt(r, now) === "pending");
  return Promise.all(pending.map(r => review(r, deps, now)));
}

export async function getPlanUpgradeRequest(
  actor: AuthenticatedActor,
  requestId: string,
  deps: PlanDependencies,
): Promise<PlanUpgradeReviewView> {
  await requireApprover(actor, deps);
  const request = await deps.plans.findRequest(requestId);
  if (request === null) throw new ResourceNotFoundError("PlanUpgradeRequest");
  return review(request, deps, deps.clock.now());
}

export async function decidePlanUpgradeRequest(
  actor: AuthenticatedActor,
  requestId: string,
  decision: "approve" | "decline",
  deps: PlanDependencies,
): Promise<PlanUpgradeReviewView> {
  await requireApprover(actor, deps);
  const request = await deps.plans.findRequest(requestId);
  if (request === null) throw new ResourceNotFoundError("PlanUpgradeRequest");
  const now = deps.clock.now();
  const status = statusAt(request, now);
  if (status !== "pending") {
    if (status === "expired" && request.status === "pending") {
      await deps.plans.transact(request.userId, uow =>
        uow.decideRequest({ requestId, status: "expired", at: now, decidedBy: null }));
    }
    throw new PlanUpgradeConflictError("not_pending",
      status === "expired" ? "This request expired. The person can send a new one." : `This request was already ${status}.`);
  }

  const requester = await deps.plans.account(request.userId);
  const current = await deps.plans.find(request.userId);
  // A new month starts today, or where a running month of the SAME plan ends.
  const runningEnd = current !== null && current.plan === request.plan ? currentPeriodEnd(current, now) : null;
  const paidUntil = addOneMonth(runningEnd ?? now);

  await deps.plans.transact(request.userId, async uow => {
    const decided = await uow.decideRequest({
      requestId, status: decision === "approve" ? "approved" : "declined", at: now, decidedBy: actor.userId,
    });
    if (!decided) throw new PlanUpgradeConflictError("not_pending", "This request was already decided.");
    if (decision === "approve") {
      await uow.setPlan({
        userId: request.userId, plan: request.plan, paidUntil,
        autoRenew: current?.autoRenew === true && current.plan === request.plan, at: now,
      });
    }
    if (requester === null) return;
    await notifier(uow, deps)({
      notificationType: decision === "approve" ? "PLAN_UPGRADE_APPROVED" : "PLAN_UPGRADE_DECLINED",
      sourceId: request.requestId,
      scope: { kind: "GLOBAL_USER", userId: request.userId },
      audience: { kind: "USER", userId: request.userId },
      destination: requester.email,
      templateInput: {
        recipientName: requester.displayName,
        planName: PLAN_NAMES[request.plan],
        requestId: request.requestId,
        ...(decision === "approve" ? { paidUntil: formatDate(paidUntil) } : {}),
      },
    }, uow.transaction);
  });

  const after = await deps.plans.findRequest(requestId);
  return review(after ?? request, deps, now);
}
