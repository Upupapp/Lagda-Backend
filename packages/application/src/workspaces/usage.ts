// A workspace's usage summary, for Settings → Usage.
//
// Any member may read it (`workspace.view`): every number is a COUNT of rows
// the member's own screens already reach, and none names a person, a document
// or an address. Counted from the workspace's own rows in one tenant-scoped
// transaction, so the figures are real and mutually consistent.
//
// ── The period ─────────────────────────────────────────────────────────────
//
// The current calendar month in UTC. `start` is its first millisecond and
// `end` its LAST millisecond, both inclusive, so a client can render the two
// as dates directly.
//
// ── Verifications ──────────────────────────────────────────────────────────
//
// Public verification lookups are not recorded anywhere: the lookup is a
// read in its own narrow realm (075) and writes no row. So
// `verificationsThisMonth` is 0 until lookups are recorded — a stated gap,
// not an estimate.

import type { WorkspaceId } from "@lagda/contracts";
import { assertCapability, privilegesOf, type WorkspaceAccessContext } from "./workspace-access.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type { WorkspaceUsageCounts } from "../common/ports/workspace-usage.js";

export interface WorkspaceUsageDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
}

export interface WorkspaceUsageView extends WorkspaceUsageCounts {
  readonly period: { readonly start: number; readonly end: number };
  /** Always 0 today: public verification lookups are not recorded. */
  readonly verificationsThisMonth: number;
}

/** The UTC calendar month containing `now`: [start, endExclusive). */
export function currentUtcMonth(now: number): { start: number; endExclusive: number } {
  const at = new Date(now);
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const endExclusive = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { start, endExclusive };
}

async function authorize(uow: WorkspaceUnitOfWork, actor: AuthenticatedActor): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // A non-member is indistinguishable from an absent workspace.
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId, userId: membership.userId,
    membershipId: membership.memberId, role: membership.role, privileges: privilegesOf(membership),
  };
  assertCapability(access, "workspace.view");
  return access;
}

export async function getWorkspaceUsage(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: WorkspaceUsageDependencies,
): Promise<WorkspaceUsageView> {
  const { start, endExclusive } = currentUtcMonth(deps.clock.now());
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor);
    const counts = await uow.usage.summarize({
      periodStart: start, periodEndExclusive: endExclusive, callerUserId: actor.userId,
    });
    return {
      period: { start, end: endExclusive - 1 },
      documents: counts.documents,
      signingRequests: counts.signingRequests,
      members: counts.members,
      templates: counts.templates,
      contacts: counts.contacts,
      verificationsThisMonth: 0,
      storageBytes: counts.storageBytes,
    };
  });
}
