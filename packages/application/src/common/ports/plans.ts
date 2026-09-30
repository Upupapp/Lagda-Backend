// Ports for plans (093): a person's plan, the Free allowance, and test-mode
// upgrade requests.
//
// Account-owned tables with no tenant policy. Every read names the account it
// is about; nothing here is reachable from a workspace transaction.

import type { UserId } from "@lagda/contracts";
import type { NotificationRepository } from "./notifications.js";

export const PLAN_IDS = ["free", "personal", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const PAID_PLAN_IDS = ["personal", "business"] as const;
export type RequestablePlanId = (typeof PAID_PLAN_IDS)[number];

export const PLAN_UPGRADE_STATUSES = ["pending", "approved", "declined", "expired", "cancelled"] as const;
export type PlanUpgradeStatus = (typeof PLAN_UPGRADE_STATUSES)[number];

export interface UserPlanRecord {
  readonly userId: UserId;
  readonly plan: PlanId;
  /** Epoch milliseconds, or null for Free and for a renewing plan with none. */
  readonly paidUntil: number | null;
  readonly autoRenew: boolean;
  readonly freeDocumentsUsed: number;
  readonly updatedAt: number;
}

export interface PlanUpgradeRequestRecord {
  readonly requestId: string;
  readonly userId: UserId;
  readonly plan: RequestablePlanId;
  readonly amountPesos: number;
  readonly status: PlanUpgradeStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: UserId | null;
}

/** What the plan screens show of an account. */
export interface PlanAccount {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
}

/** The writes that travel with a notice, on ONE transaction. */
export interface PlanUnitOfWork {
  /** Sets the plan outright (creating the row when there is none). */
  setPlan(input: {
    readonly userId: UserId; readonly plan: PlanId; readonly paidUntil: number | null;
    readonly autoRenew: boolean; readonly at: number;
  }): Promise<void>;
  /** @throws ResourceConflictError when this account already has a pending request. */
  insertRequest(request: PlanUpgradeRequestRecord): Promise<void>;
  /** pending → status, only while pending. False when it was not. */
  decideRequest(input: {
    readonly requestId: string;
    readonly status: Exclude<PlanUpgradeStatus, "pending">;
    readonly at: number;
    readonly decidedBy: UserId | null;
  }): Promise<boolean>;
  readonly notifications: NotificationRepository;
  readonly transaction: unknown;
}

export interface PlanRepository {
  find(userId: UserId): Promise<UserPlanRecord | null>;
  /**
   * Takes one Free document for this account: a conditional increment that
   * succeeds only below `limit`. Creates the Free row when there is none.
   */
  claimFreeDocument(userId: UserId, limit: number, at: number): Promise<boolean>;
  /** Gives one back, after a send that took it did not commit. */
  releaseFreeDocument(userId: UserId, at: number): Promise<void>;
  findRequest(requestId: string): Promise<PlanUpgradeRequestRecord | null>;
  findPendingRequest(userId: UserId): Promise<PlanUpgradeRequestRecord | null>;
  /** Pending requests, oldest first, for the approver. */
  listPendingRequests(): Promise<readonly PlanUpgradeRequestRecord[]>;
  account(userId: UserId): Promise<PlanAccount | null>;
  accountByNormalizedEmail(normalizedEmail: string): Promise<PlanAccount | null>;
  /**
   * A transaction whose notices are addressed to `noticeUserId` (one person
   * per transaction: the notice rows are that account's own).
   */
  transact<T>(noticeUserId: UserId, operation: (uow: PlanUnitOfWork) => Promise<T>): Promise<T>;
}

export interface PlanUpgradeRequestIdGenerator {
  nextPlanUpgradeRequestId(): string;
}
