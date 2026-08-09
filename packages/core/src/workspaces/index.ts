// Workspace ownership invariants.
//
// Only the rule that is unambiguous today. Membership lifecycle, invitations
// and role/permission policy need product answers that do not exist yet, and
// §54 forbids inventing them.

import { InvariantViolationError } from "../common/index.js";

/** Canonical workspace roles, from the frontend's `PlatformRole`. */
export const WORKSPACE_ROLES = [
  "owner", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface MembershipView {
  readonly memberId: string;
  readonly role: WorkspaceRole;
}

/**
 * A workspace always has exactly one owner.
 *
 * Zero owners means no one can transfer ownership or delete the workspace —
 * an unrecoverable state reachable by an ordinary "remove member" call. Two
 * owners makes "the owner" ambiguous wherever the product says it.
 */
export function assertExactlyOneOwner(members: readonly MembershipView[]): void {
  const owners = members.filter(m => m.role === "owner");
  if (owners.length !== 1) {
    throw new InvariantViolationError(
      "Workspace.exactlyOneOwner",
      `Expected exactly one owner, found ${String(owners.length)}.`,
    );
  }
}

/**
 * Whether removing a member would leave the workspace ownerless.
 *
 * Pure: the caller supplies the membership list. Whether the ACTOR is permitted
 * to remove anyone is authorization, and belongs to BACKEND-27.
 */
export function wouldOrphanWorkspace(
  members: readonly MembershipView[],
  removingMemberId: string,
): boolean {
  const remaining = members.filter(m => m.memberId !== removingMemberId);
  return remaining.filter(m => m.role === "owner").length === 0;
}

/**
 * Ownership transfer must target an existing member.
 *
 * Whether every role is an eligible target is unresolved — OD-015.
 */
export function canReceiveOwnership(
  members: readonly MembershipView[],
  targetMemberId: string,
): boolean {
  const target = members.find(m => m.memberId === targetMemberId);
  return target !== undefined && target.role !== "owner";
}
