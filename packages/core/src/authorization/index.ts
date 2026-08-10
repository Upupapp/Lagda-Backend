// Workspace authorization policy.
//
// ── The one rule ───────────────────────────────────────────────────────────
//
//   A role is an ASSIGNMENT. A capability is what that assignment permits.
//   Feature code asks for a capability; it never compares a role name.
//
// This file is the only place in the backend that knows which roles have which
// powers. Everything else — routes, use cases, repositories — asks
// `hasCapability` or `requireCapability` and gets a boolean or an error.
//
// ── Pure, and deliberately so ──────────────────────────────────────────────
//
// No Fastify, no PostgreSQL, no clock, no I/O. Every decision is a function of
// its arguments, which is what makes the exhaustive matrix test possible: 7
// roles times 10 capabilities is 70 assertions, and they run in microseconds
// with nothing mocked.

import type { WorkspaceRole } from "@lagda/contracts";
import { WORKSPACE_ROLES } from "@lagda/contracts";
import { InvariantViolationError } from "../common/index.js";

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * Every action the workspace domain currently permits.
 *
 * ── Naming ─────────────────────────────────────────────────────────────────
 *
 * `domain.action`, lower case, dot-separated. ONE convention, chosen here and
 * not mixed with `domain:action` anywhere — these identifiers reach the
 * frontend as a capability projection and become a platform contract the
 * moment a client branches on one.
 *
 * ── Only what exists ───────────────────────────────────────────────────────
 *
 * Ten capabilities, and every one of them governs an operation that is
 * implemented today. There is no `document.create`, no `contact.write`, no
 * `billing.manage` — those arrive with the commands that build the operations
 * they govern (BACKEND-28, 29, 50). A capability with no operation behind it is
 * a promise the policy cannot keep, and this repository has already shipped one
 * contract that nothing consumed.
 *
 * ── Specific, not one `workspace.admin` ────────────────────────────────────
 *
 * Separate capabilities for invite, resend, revoke, role change and removal
 * even though the same two roles hold all five today. A single
 * `workspace.admin` capability would make the matrix uninformative and would
 * have to be split the first time the product differentiates — and splitting a
 * capability that clients already branch on is a breaking change.
 */
export const WORKSPACE_CAPABILITIES = [
  /** Read the workspace and act inside it at all. Every member has this. */
  "workspace.view",
  /** Change workspace metadata — today, the name. */
  "workspace.update",

  /** See who belongs to the workspace, including their email addresses. */
  "membership.view",
  /** Change another member's role. */
  "membership.role.change",
  /** Remove another member from the workspace. */
  "membership.remove",

  /** See the pending invitations. */
  "invitation.view",
  /** Invite someone. */
  "invitation.create",
  /** Rotate an invitation's credential and send it again. */
  "invitation.resend",
  /** Withdraw a pending invitation. */
  "invitation.revoke",

  /**
   * Hand the workspace to someone else.
   *
   * Held by `owner` alone, and there is currently NO OPERATION behind it — the
   * product's transfer control says "demonstration only" (OD-101). It is
   * declared because the ownership model is meaningless without naming who
   * could ever do it, and because `owner` being undemotable is a direct
   * consequence: see OWNERSHIP_MODEL.md.
   *
   * This is the one capability in the list without a live operation, and it is
   * called out here rather than left for a reader to discover.
   */
  "workspace.ownership.transfer",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

// ── The matrix ───────────────────────────────────────────────────────────────

/**
 * The single canonical role-to-capability mapping.
 *
 * ── Where these values come from ───────────────────────────────────────────
 *
 * The product's own `ROLE_PERMISSIONS` table in `models/index.ts`, plus the
 * navigation gate in `platform.nav.ts`. They are not invented and they are not
 * a guess at what feels reasonable.
 *
 * The most consequential line is `administrator`. The product grants it
 * `manage_team` AND `manage_workspace`; BACKEND-25 and BACKEND-26 hardcoded
 * owner-only because neither had a role model to consult. Reading the product
 * corrects that here, which is the whole reason this command exists.
 *
 * ── An explicit total record ───────────────────────────────────────────────
 *
 * `Record<WorkspaceRole, ...>` rather than a partial map with a default. Adding
 * a role to `WORKSPACE_ROLES` without deciding what it can do is then a
 * COMPILE ERROR rather than a role that silently inherits nothing — or worse,
 * silently inherits something.
 *
 * Every list is frozen. A caller that mutated a returned array would change
 * every later decision in the process.
 */
const ROLE_CAPABILITIES: Readonly<Record<WorkspaceRole, readonly WorkspaceCapability[]>> =
  Object.freeze({
    /**
     * The administrative root. Exactly one per workspace.
     *
     * Everything, including the transfer capability nobody can yet exercise.
     */
    owner: Object.freeze([
      "workspace.view",
      "workspace.update",
      "membership.view",
      "membership.role.change",
      "membership.remove",
      "invitation.view",
      "invitation.create",
      "invitation.resend",
      "invitation.revoke",
      "workspace.ownership.transfer",
    ] as const),

    /**
     * Full workspace and member administration, minus ownership.
     *
     * `manage_team` + `manage_workspace` from the product's table. The single
     * withheld capability is `workspace.ownership.transfer` — an administrator
     * runs the workspace and cannot give it away.
     */
    administrator: Object.freeze([
      "workspace.view",
      "workspace.update",
      "membership.view",
      "membership.role.change",
      "membership.remove",
      "invitation.view",
      "invitation.create",
      "invitation.resend",
      "invitation.revoke",
    ] as const),

    /**
     * An ordinary participant. Present in the workspace, administers nothing.
     *
     * NOT "everything except ownership" (§4). The product's `role_member`
     * permission set is view-oriented, and the workspace-administration
     * navigation is gated on `manage_team`, which `member` does not hold — so
     * a member cannot reach the members page at all.
     *
     * `membership.view` is deliberately withheld despite `role_member` listing
     * `members:view` in the SECOND of the product's two permission tables.
     * The two disagree; the navigation gate is what actually controls
     * reachability, and a member directory carries every colleague's email
     * address. Recorded as OD-100 rather than resolved by picking the more
     * permissive reading.
     */
    member: Object.freeze(["workspace.view"] as const),

    /**
     * Template administration. A future-domain role with no capability here yet.
     *
     * Its powers are over templates (BACKEND-47), and `workspace.view` is what
     * lets it be in the workspace at all. Listing only that is not an oversight
     * — it is the honest current answer.
     */
    template_administrator: Object.freeze(["workspace.view"] as const),

    /** Prepares and sends documents. No workspace administration. */
    sender: Object.freeze(["workspace.view"] as const),

    /** Reviews documents. No workspace administration. */
    reviewer: Object.freeze(["workspace.view"] as const),

    /** Reads audit history. No workspace administration. */
    auditor: Object.freeze(["workspace.view"] as const),
  });

/**
 * Whether a role holds a capability.
 *
 * **Default deny**, and the two ways that matters:
 *
 *   - An unrecognised role returns false rather than throwing or defaulting to
 *     anything. A role that reached here without a mapping is a bug, and the
 *     safe behaviour for a bug in an authorization function is to refuse.
 *   - A capability absent from a role's list is denied. There is no wildcard,
 *     no inheritance and no hierarchy — see `ROLE_GRANT_MATRIX.md` for why a
 *     numeric rank was rejected.
 *
 * Side-effect free, and the returned list is never exposed to a caller who
 * could mutate it.
 */
export function hasCapability(
  role: WorkspaceRole,
  capability: WorkspaceCapability,
): boolean {
  const granted = ROLE_CAPABILITIES[role] as readonly WorkspaceCapability[] | undefined;
  if (granted === undefined) return false;
  return granted.includes(capability);
}

/**
 * Every capability a role holds, as a fresh array.
 *
 * For the projection a client uses to hide controls it cannot use. A COPY, so
 * the caller cannot mutate the policy — and a caller that could would change
 * every subsequent authorization decision in the process.
 *
 * This is INFORMATIONAL. The backend re-evaluates on every mutation, and a
 * client that fabricated a capability list would change nothing.
 */
export function capabilitiesFor(role: WorkspaceRole): WorkspaceCapability[] {
  const granted = ROLE_CAPABILITIES[role] as readonly WorkspaceCapability[] | undefined;
  return granted === undefined ? [] : [...granted];
}

// ── Role grants ──────────────────────────────────────────────────────────────

/**
 * Whether an actor holding `actorRole` may assign `targetRole` to someone.
 *
 * ── Separate from capabilities, deliberately ───────────────────────────────
 *
 * Holding `membership.role.change` says you may change roles. It does not say
 * WHICH roles you may hand out, and conflating the two is how an administrator
 * ends up able to mint an owner. Escalation deserves its own matrix and its own
 * review — ROLE_GRANT_MATRIX.md.
 *
 * ── No numeric rank ────────────────────────────────────────────────────────
 *
 * A `roleRank` comparison would be shorter and is rejected (§40). The roles are
 * not a hierarchy: `sender`, `reviewer`, `auditor` and `template_administrator`
 * are PARALLEL — none outranks another — and a rank would have to invent an
 * ordering between them that means nothing. Explicit rules describe the actual
 * shape.
 *
 * ── The two rules ──────────────────────────────────────────────────────────
 *
 *   1. NOBODY may grant `owner`. Ownership moves only through a dedicated
 *      transfer operation, which does not exist yet. An emailed invitation or
 *      a role dropdown must never create a second owner — the workspace has
 *      exactly one, and `assertExactlyOneOwner` depends on it.
 *   2. Otherwise, holding the grant authority is enough.
 *
 * An `administrator` MAY grant `administrator`. That is a considered choice
 * against the conservative default: the product's own table gives
 * `administrator` the `members:invite` permission and its invitation form
 * offers Administrator as a selectable role, so refusing peer promotion would
 * be inventing a restriction the product does not have. The escalation is
 * bounded — an administrator can create peers, never a superior, and the owner
 * can demote any of them.
 */
export function canGrantRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  // Rule 1, checked first and unconditionally. No capability, no role and no
  // caller overrides it.
  if (targetRole === "owner") return false;
  return hasCapability(actorRole, "membership.role.change");
}

/**
 * Whether an actor may issue an INVITATION granting `targetRole`.
 *
 * A separate function from `canGrantRole` because the authority differs:
 * inviting is `invitation.create`, changing an existing member's role is
 * `membership.role.change`. Today the same roles hold both, and the two
 * functions still exist separately so the first product change that
 * distinguishes them is a one-line edit rather than a discovery.
 *
 * `owner` is unreachable here too, and by two further layers: it is absent from
 * `INVITABLE_WORKSPACE_ROLES` so the request schema cannot express it, and a
 * database CHECK refuses it.
 */
export function canGrantInvitationRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  if (targetRole === "owner") return false;
  return hasCapability(actorRole, "invitation.create");
}

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * LAGDA workspaces have EXACTLY ONE owner.
 *
 * Not a configuration flag — a decision, recorded in OWNERSHIP_MODEL.md and
 * enforced by `assertExactlyOneOwner`. It is stated as a constant so the
 * documents and the code cannot disagree about which model is in force.
 */
export const OWNERSHIP_MODEL = "SINGLE_OWNER" as const;
export type OwnershipModel = typeof OWNERSHIP_MODEL;

/**
 * Whether a role change would strip the workspace of its owner.
 *
 * Under `SINGLE_OWNER` the answer for the owner is always yes, because there is
 * never a second one to fall back on. The `ownerCount` argument is not
 * decoration: it is what the caller must read INSIDE the transaction, and it is
 * what makes this function honest if the ownership model ever changes.
 *
 * Pure. The caller supplies the count; this decides what it means.
 */
export function wouldRemoveLastOwner(input: {
  readonly currentRole: WorkspaceRole;
  readonly ownerCount: number;
}): boolean {
  if (input.currentRole !== "owner") return false;
  return input.ownerCount <= 1;
}

/**
 * Asserts the workspace still has its owner.
 *
 * A last line for callers that have already computed the resulting count.
 * Throws rather than returning a boolean because reaching a state with no owner
 * is not a condition to branch on — it is an invariant violation, and the
 * transaction should die.
 */
export function assertOwnerRemains(ownerCount: number): void {
  if (ownerCount < 1) {
    throw new InvariantViolationError(
      "Workspace.ownerRemains",
      "The operation would leave the workspace with no owner.",
    );
  }
}

// ── Guards against the shapes this file exists to prevent ────────────────────

/**
 * Every role, for exhaustive testing.
 *
 * Re-exported so the matrix test iterates the SAME list the policy is keyed on.
 * A test with its own hand-written role list would keep passing after a role
 * was added and left unmapped, which is exactly the drift the total `Record`
 * prevents at compile time and this prevents at test time.
 */
export { WORKSPACE_ROLES };
