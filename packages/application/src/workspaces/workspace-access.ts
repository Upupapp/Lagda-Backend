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
import { hasCapability, capabilitiesFor, type WorkspaceCapability } from "@lagda/core";
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
 * Requires a specific CAPABILITY inside a workspace the caller belongs to.
 *
 * ── The centralization point (BACKEND-27) ──────────────────────────────────
 *
 * Every workspace operation in the backend passes through here, naming the
 * capability it needs. No route and no use case compares a role: the role is
 * read from the membership row inside this function, handed to the pure policy,
 * and never inspected again.
 *
 * BACKEND-25 and BACKEND-26 had `requireWorkspaceManager`, which was
 * `role === "owner"` under another name. It is gone.
 *
 * ── Why the denial is a hidden 404, not a 403 ──────────────────────────────
 *
 * `requireWorkspaceAccess` already answers 404 for a non-member, and using the
 * SAME error for an under-privileged member means a caller cannot distinguish
 * "this workspace is not yours" from "this workspace is yours but you may not
 * do that" — so the endpoint never becomes an oracle for either fact. It also
 * means no response ever explains the role policy (§77).
 *
 * The cost is that a member who genuinely lacks a capability sees a 404 rather
 * than a 403. That is the deliberate trade: the frontend hides controls using
 * the capability projection, so a legitimate user should not reach this at all.
 */
export async function requireCapability(
  userId: UserId,
  workspaceId: WorkspaceId,
  capability: WorkspaceCapability,
  deps: WorkspaceAccessDependencies,
): Promise<WorkspaceAccessContext> {
  const access = await requireWorkspaceAccess(userId, workspaceId, deps);
  assertCapability(access, capability);
  return access;
}

/**
 * Asserts a capability against an ALREADY-RESOLVED access context.
 *
 * For the path that matters most: a mutation that resolved the actor's
 * membership inside its own transaction and must not re-read it. Sensitive
 * administrative operations do exactly that, so the authority they act on
 * cannot have changed between the check and the write (§149, §150).
 *
 * Pure and synchronous — it is a policy lookup, not an I/O call.
 */
export function assertCapability(
  access: WorkspaceAccessContext,
  capability: WorkspaceCapability,
): void {
  // The role comes from a membership row the server read. There is no `role`
  // field on any request schema anywhere in the backend.
  if (!hasCapability(access.role, capability)) {
    throw new ResourceNotFoundError("Workspace");
  }
}

/**
 * The capabilities the caller holds, for a client to hide controls with.
 *
 * INFORMATIONAL. The backend re-evaluates on every mutation, so a client that
 * fabricated this list would change nothing (§17, §18, §128).
 */
export function accessCapabilities(
  access: WorkspaceAccessContext,
): readonly WorkspaceCapability[] {
  return capabilitiesFor(access.role);
}
