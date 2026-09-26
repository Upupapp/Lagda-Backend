// A workspace's usage, counted from its own rows. Read-only; tenant-scoped by
// the unit of work AND by row-level security.

import type { UserId } from "@lagda/contracts";

export interface WorkspaceUsageQuery {
  /** Inclusive, epoch ms. */
  readonly periodStart: number;
  /** EXCLUSIVE, epoch ms — the first instant after the period. */
  readonly periodEndExclusive: number;
  /**
   * The caller. Personal contacts (074) are visible only to their owner, so
   * the contact count is the count the caller's own address book shows.
   */
  readonly callerUserId: UserId;
}

export interface WorkspaceUsageCounts {
  readonly documents: {
    /** Documents not deleted. */
    readonly total: number;
    /** Documents created in the period, deleted since or not. */
    readonly uploadedThisMonth: number;
  };
  readonly signingRequests: {
    /** `sent_at` inside the period. */
    readonly sentThisMonth: number;
    /** Every request that was ever sent (`sent_at` set). */
    readonly sentTotal: number;
    /** Sent and not yet finished: sent, partially-completed, completion-ready. */
    readonly inProgress: number;
    /** `completed_at` inside the period. */
    readonly completedThisMonth: number;
    /** Every request in the `completed` state. */
    readonly completedTotal: number;
  };
  readonly members: number;
  /** Workflow templates. */
  readonly templates: number;
  /** Unarchived contacts the caller can see. */
  readonly contacts: number;
  /** Sum of every stored document artifact's size, in bytes. */
  readonly storageBytes: number;
}

export interface ScopedWorkspaceUsageRepository {
  summarize(query: WorkspaceUsageQuery): Promise<WorkspaceUsageCounts>;
}
