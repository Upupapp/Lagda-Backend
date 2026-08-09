// ListMyWorkspaces — the workspace switcher's query.
//
// ── Why there is no workspace parameter ────────────────────────────────────
//
// This is the one workspace query that is NOT tenant-scoped. Asking "which
// workspaces do I belong to?" cannot begin by choosing a workspace. It is a
// GLOBAL query over the caller's own membership edges, and it is scoped by
// `userId` at every layer: the SQL predicate, the transaction's user context,
// and the RLS policy.
//
// ── Why it does not load workspaces and filter them ────────────────────────
//
// `SELECT * FROM workspaces` followed by `.filter(w => isMember(w))` is a
// security control implemented in application memory over a result set that
// already contains every tenant's data. One early return, one thrown exception
// mid-loop, one refactor that reorders the filter, and the whole list leaks. The
// query joins through membership so the rows never exist (§30, §242).

import type { UserId } from "@lagda/contracts";
import type {
  TransactionManager, UserWorkspaceMembershipRecord,
} from "../common/ports/index.js";

/**
 * One entry in the switcher.
 *
 * `role` is the CALLER'S role, and returning it is safe for the same reason
 * returning it from create is: it is their own authorization state. No other
 * member appears, no member count appears, and no permission list appears —
 * member management is BACKEND-26/27, and a capability set is BACKEND-27 (§106,
 * §107, §201).
 */
export interface MyWorkspaceSummary {
  readonly workspaceId: string;
  readonly name: string;
  readonly role: string;
  readonly joinedAt: number;
  readonly createdAt: number;
}

export interface ListMyWorkspacesDependencies {
  readonly transactions: TransactionManager;
}

export async function listMyWorkspaces(
  userId: UserId,
  deps: ListMyWorkspacesDependencies,
): Promise<readonly MyWorkspaceSummary[]> {
  // A user-scoped transaction. It establishes NO workspace context, so the
  // tenant-isolation policies match nothing for its whole lifetime, and the
  // user-scoped policies it does satisfy are SELECT-only. There is no write this
  // transaction is capable of performing against either table.
  const rows = await deps.transactions.runForUser(
    userId,
    uow => uow.memberships.listWorkspaces(),
  );

  return rows.map(project);
}

/**
 * Maps the join projection to the wire shape.
 *
 * Never a database row (§104). Nothing here exposes another member, the owner's
 * identity, a storage prefix, a plan, or an RLS setting name.
 */
function project(row: UserWorkspaceMembershipRecord): MyWorkspaceSummary {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    role: row.role,
    joinedAt: row.joinedAt,
    createdAt: row.workspaceCreatedAt,
  };
}

/**
 * Pagination is deliberately absent.
 *
 * A workspace switcher renders every workspace a person belongs to, and that
 * number is bounded by how many organizations one human works for. Paginating
 * it would make the switcher's "show all my workspaces" job require a loop, to
 * solve a volume problem nobody has measured — the same reasoning API
 * CONVENTIONS §5 used to keep `total` (§118).
 *
 * If a user ever holds hundreds, `PaginatedResult<T>` is already the
 * established shape and this becomes a parameterized query.
 */
export type ListMyWorkspacesPaginationSeam = never;
