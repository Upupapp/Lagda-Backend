// Workspace access resolution — the authorization step.
//
// ── The rule this file exists to hold ──────────────────────────────────────
//
//   A session authenticates the USER.
//   Membership in the target workspace authorizes access to that TENANT.
//
// They are answered by different code, against different state, at different
// times. `AuthenticatedActor` carries no workspace, no role and no permission
// list — deliberately, since BACKEND-13 — so there is nothing in a session
// credential that could go stale and still grant access.
//
// ── Why this lives in application, not in a Fastify hook ───────────────────
//
// A worker, a future partner API and a CLI can all invoke a workspace use case,
// and none of them has a request. If authorization lived only in a route hook,
// every non-HTTP caller would enter the use case already authorized by nothing
// at all. The API may CALL this to decorate a request; it may not BE it (§43).

import type { UserId, WorkspaceId, WorkspaceMemberId, WorkspaceRole } from "@lagda/contracts";
import { canManageWorkspace } from "@lagda/core";
import type { TransactionManager } from "../common/ports/index.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

/**
 * Proof that a specific user may act inside a specific workspace, right now.
 *
 * Semantic and application-owned. No `FastifyRequest`, no session token, no
 * database row — those are transport and persistence, and a context carrying
 * them would be one a worker cannot construct.
 *
 * Obtainable only from `resolveWorkspaceAccess`, which reads the authoritative
 * membership. There is no constructor a caller can reach and no way to assert
 * one into existence from client input.
 */
export interface WorkspaceAccessContext {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly membershipId: WorkspaceMemberId;
  readonly role: WorkspaceRole;
}

export interface WorkspaceAccessDependencies {
  readonly transactions: TransactionManager;
}

/**
 * Resolves current membership, or returns null.
 *
 * ── Why binding tenant context BEFORE the check is safe ────────────────────
 *
 * The requested workspace ID is client-supplied, and this opens a transaction
 * bound to it. That does not grant anything: RLS context only ever RESTRICTS
 * what is visible, and the query additionally names `user_id` explicitly. The
 * lookup therefore returns a row only when the caller genuinely holds a
 * membership in that workspace — which IS the authorization question. A
 * fabricated or guessed ID yields a transaction that can see nothing.
 *
 * ── Why it returns null rather than throwing ───────────────────────────────
 *
 * "Not a member" and "no such workspace" must produce the SAME outcome, and the
 * caller decides what that outcome is. Throwing an authorization error here
 * would make the two distinguishable at the point where a route decides between
 * 403 and 404 — and 403 confirms the workspace exists.
 */
export async function resolveWorkspaceAccess(
  userId: UserId,
  workspaceId: WorkspaceId,
  deps: WorkspaceAccessDependencies,
): Promise<WorkspaceAccessContext | null> {
  const membership = await deps.transactions.runForWorkspace(
    workspaceId,
    uow => uow.memberships.findByUser(userId),
  );

  if (membership === null) return null;

  return {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
}

/**
 * Resolves access or refuses with the resource-hiding error.
 *
 * `ResourceNotFoundError` for a workspace the caller is not a member of, which
 * maps to 404. API_CONVENTIONS §3 permits exactly this: "Authorization policy
 * may deliberately return 404 instead of 403 to avoid confirming another
 * workspace's resource exists." A 403 here would make the endpoint an oracle for
 * which workspace IDs are real (§49, §50).
 */
export async function requireWorkspaceAccess(
  userId: UserId,
  workspaceId: WorkspaceId,
  deps: WorkspaceAccessDependencies,
): Promise<WorkspaceAccessContext> {
  const access = await resolveWorkspaceAccess(userId, workspaceId, deps);
  if (access === null) throw new ResourceNotFoundError("Workspace");
  return access;
}

/**
 * Requires a role that may change workspace metadata.
 *
 * Also `ResourceNotFoundError`, and NOT `AccessDeniedError`. The distinction a
 * 403 would draw — "this workspace exists and you are in it, but you are not the
 * owner" — is information a member already has, so hiding it costs nothing;
 * meanwhile one error for both cases means no caller can ever tell the two
 * apart by accident. BACKEND-27 may revisit this once roles other than `owner`
 * can exist and the product decides what a non-owner should be told (§210).
 */
export async function requireWorkspaceManager(
  userId: UserId,
  workspaceId: WorkspaceId,
  deps: WorkspaceAccessDependencies,
): Promise<WorkspaceAccessContext> {
  const access = await requireWorkspaceAccess(userId, workspaceId, deps);
  // The role comes from the membership row that was just read, never from a
  // client field. There is no `role` on any request schema in this command.
  if (!canManageWorkspace(access.role)) throw new ResourceNotFoundError("Workspace");
  return access;
}
