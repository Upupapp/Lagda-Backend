// Workspace domain rules.
//
// Pure: no clock, no persistence, no HTTP. Every function here takes the state
// it judges as an argument, which is what lets a test state a rule and a use
// case apply it without either owning it.
//
// Only rules that are unambiguous TODAY. Invitation lifecycle and the
// permission model need product answers that do not exist yet, and §194 forbids
// inventing them.

import { InvariantViolationError } from "../common/index.js";
import {
  WORKSPACE_ROLES, WORKSPACE_NAME_MAX_LENGTH, WORKSPACE_NAME_MIN_LENGTH,
  INVITABLE_WORKSPACE_ROLES, INVITATION_TTL_MS,
  type WorkspaceRole, type InvitableWorkspaceRole, type InvitationState,
} from "@lagda/contracts";

/**
 * Re-exported, not re-declared.
 *
 * The canonical list moved to `@lagda/contracts` in BACKEND-25 because a
 * membership role appears in a response body, and INV-007 says shared contracts
 * originate there. Core keeps the export so existing importers do not change,
 * and so there is one list rather than two that agree by convention.
 */
export {
  WORKSPACE_ROLES, WORKSPACE_NAME_MAX_LENGTH, WORKSPACE_NAME_MIN_LENGTH,
  INVITABLE_WORKSPACE_ROLES, INVITATION_TTL_MS,
};
export type { WorkspaceRole, InvitableWorkspaceRole, InvitationState };

export interface MembershipView {
  readonly memberId: string;
  readonly role: WorkspaceRole;
}

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * A workspace always has exactly one owner.
 *
 * Zero owners means no one can transfer ownership or manage the workspace — an
 * unrecoverable state reachable by an ordinary "remove member" call. Two owners
 * makes "the owner" ambiguous wherever the product says it.
 *
 * **An APPLICATION invariant, not a database constraint.** A relational CHECK
 * cannot express "at least one row in this group satisfies a predicate" without
 * a trigger or a materialized counter, and both are worse than checking it at
 * the one place that can change the answer. No endpoint in BACKEND-25 can
 * violate it: the only membership write is the creator's OWNER row, and there is
 * no removal or role-change endpoint. BACKEND-26/27 must call this before
 * committing any membership removal or role change (§68, §149).
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
 * Whether every role is an eligible target is unresolved — OD-015. Not reachable
 * from any BACKEND-25 endpoint; transfer itself is deferred (§67).
 */
export function canReceiveOwnership(
  members: readonly MembershipView[],
  targetMemberId: string,
): boolean {
  const target = members.find(m => m.memberId === targetMemberId);
  return target !== undefined && target.role !== "owner";
}

// ── Authorization ────────────────────────────────────────────────────────────
//
// BACKEND-25 and BACKEND-26 each carried a narrow role predicate here —
// `canManageWorkspace`, `canManageInvitations`, `canGrantRole` — because
// neither had a role model to consult. All three were `role === "owner"`.
//
// **BACKEND-27 removed them.** Authorization now lives in
// `@lagda/core/authorization` as a capability policy, and reading the product's
// own `ROLE_PERMISSIONS` table corrected the answer: `administrator` holds
// `manage_team` and `manage_workspace`, so owner-only was wrong.
//
// Nothing in this file compares a role any more. The domain rules below are
// about OWNERSHIP as a subject — how many owners a workspace has — which is a
// different question from what a role may do.

// ── Workspace name ───────────────────────────────────────────────────────────

export type WorkspaceNameRejection = "empty" | "too-long" | "control-characters";

export type WorkspaceNameResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: WorkspaceNameRejection };

/**
 * Unicode control (`Cc`) and format (`Cf`) characters.
 *
 * The SAME expression BACKEND-24 uses for profile text, deliberately: a name is
 * a name, and two rules that differ by accident are two behaviours to explain.
 *
 * `Cc` covers NUL, newline and the C1 range — a workspace name containing one
 * is not a name, it is a value that breaks a log line, a CSV export or a PDF
 * header. `Cf` covers zero-width and bidirectional-override characters, which
 * can make a rendered name read as something other than what is stored.
 *
 * Everything else is allowed. An ASCII allowlist would reject accented Spanish
 * surnames, Japanese and Chinese entity names, and Baybayin — a large share of
 * this product's own Philippine customers. Punctuation rejection has never been
 * an XSS defence; output encoding is.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Normalizes and validates a workspace name.
 *
 * **Trims the outside only.** Interior spacing is the customer's, and collapsing
 * `Reyes  &  Co.` to `Reyes & Co.` is the system deciding it knows the name
 * better than the person who typed it. Leading and trailing whitespace, by
 * contrast, is almost always a paste artefact and is invisible in every UI that
 * renders it.
 *
 * Length is measured in CODE POINTS via the string iterator, not `.length`,
 * which counts UTF-16 units — so a name written in a supplementary plane is not
 * silently charged double.
 *
 * Order matters: the control-character check runs BEFORE the length check, so a
 * long name full of NULs is reported as the problem it actually has.
 */
export function validateWorkspaceName(raw: string): WorkspaceNameResult {
  const trimmed = raw.trim();

  if (trimmed.length < WORKSPACE_NAME_MIN_LENGTH) {
    return { ok: false, reason: "empty" };
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > WORKSPACE_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * The states a workspace can be in.
 *
 * **One value.** The product has no archive, suspend or delete action anywhere
 * in its workspace UI — teams and custom roles have them, workspaces do not —
 * so there is no second state to transition to and no transition to model
 * (§57, §133).
 *
 * Declared rather than omitted so the seam is named: when BACKEND-55 settles
 * retention and the product grows a lifecycle action, this union and a
 * `lifecycle_state` column are what it extends. Today it records that ACTIVE is
 * the only state a workspace has ever been in.
 */
export const WORKSPACE_LIFECYCLE_STATES = ["active"] as const;
export type WorkspaceLifecycleState = (typeof WORKSPACE_LIFECYCLE_STATES)[number];

// ── Invitations (BACKEND-26) ─────────────────────────────────────────────────

/**
 * The timestamps an invitation's state is derived from.
 *
 * All nullable except the two that always exist. There is deliberately no
 * `status` field: see `deriveInvitationState`.
 */
export interface InvitationTimestamps {
  readonly expiresAt: number;
  readonly acceptedAt: number | null;
  readonly revokedAt: number | null;
  readonly declinedAt: number | null;
  readonly supersededAt: number | null;
}

/**
 * The invitation's state, computed from its timestamps and the clock.
 *
 * ── Why derived and not stored ─────────────────────────────────────────────
 *
 * A `status` column and a set of timestamps are two representations of one
 * fact, and they drift the first time a code path writes one without the other.
 * `expired` settles it on its own: it is a function of the current time, so a
 * stored value is wrong from the moment the invitation lapses until whatever
 * job noticed — and a security decision made against a stale column is the
 * failure mode worth designing out (§27).
 *
 * ── Precedence ─────────────────────────────────────────────────────────────
 *
 * Terminal states win over expiry, because they are facts about what happened
 * rather than about the clock: an invitation that was accepted on Monday is
 * `accepted` forever, not `expired` next week. Among the terminal states the
 * order is fixed so two timestamps set by different code paths can never
 * produce two different answers on two different reads.
 */
export function deriveInvitationState(
  timestamps: InvitationTimestamps,
  now: number,
): InvitationState {
  if (timestamps.acceptedAt !== null) return "accepted";
  if (timestamps.revokedAt !== null) return "revoked";
  if (timestamps.declinedAt !== null) return "declined";
  if (timestamps.supersededAt !== null) return "superseded";
  if (timestamps.expiresAt <= now) return "expired";
  return "pending";
}

/**
 * Whether this invitation can still be accepted.
 *
 * One predicate, used by acceptance, decline and preview alike, so the four
 * ways an invitation can be dead cannot be checked in three slightly different
 * combinations.
 */
export function isInvitationRedeemable(
  timestamps: InvitationTimestamps,
  now: number,
): boolean {
  return deriveInvitationState(timestamps, now) === "pending";
}
