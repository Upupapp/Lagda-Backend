// The workspace tenant contract.
//
// ── Why the role vocabulary lives HERE and not in @lagda/core ───────────────
//
// A membership role appears in a response body: the workspace switcher renders
// it, and `GET /workspaces` returns it. That makes it a SHARED API CONTRACT, and
// INV-007 says shared contracts originate from this package. `@lagda/core`
// re-exports it so there is still exactly ONE declaration — a second list would
// be two vocabularies that agree until someone adds a role to one of them.
//
// ── What is NOT here ────────────────────────────────────────────────────────
//
// No permission matrix, no capability set, no `canX` flags. BACKEND-27 owns
// role semantics; publishing a speculative capability shape now would be a
// contract the frontend starts consuming before anyone has decided what it
// means (§194, §203).

import { Type } from "@sinclair/typebox";

/**
 * Canonical membership roles, taken from the frontend's `PlatformRole`.
 *
 * NOT invented here and NOT reduced to `owner` alone. The product already ships
 * a nine-value `PlatformRole` union and a role-to-permission table; six of those
 * values were adopted by BACKEND-05 and are already a database CHECK constraint
 * and a mapping guard. Narrowing the list in BACKEND-25 would be a migration
 * that removes vocabulary the product uses, to satisfy a "keep it minimal" rule
 * whose purpose is to stop roles being INVENTED — which is the opposite problem.
 *
 * BACKEND-25 only ever WROTE `owner`, because the only membership it created was
 * the creator's. BACKEND-26 adds `member` and makes every non-owner value
 * reachable through an invitation.
 *
 * `member` was NOT invented: `InvitationsPage.tsx` defaults its role selector to
 * `role_member`, and the product's own `SYSTEM_ROLE_PERMISSIONS` table defines
 * `role_member`. It is the product's default invited role and had no backend
 * equivalent — §14 anticipates exactly this case.
 *
 * BACKEND-27 gives every value its permission semantics. Until then a role is a
 * stored label that only `canManageWorkspace` reads.
 */
export const WORKSPACE_ROLES = [
  "owner", "member", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * The wire schema for a role.
 *
 * A closed union, so a response carrying an unrecognised role fails the
 * serializer rather than reaching a client that has no branch for it.
 */
export const WorkspaceRoleSchema = Type.Union(
  WORKSPACE_ROLES.map(role => Type.Literal(role)),
  { title: "WorkspaceRole", description: "The caller's role in this workspace." },
);

/**
 * The roles an invitation may grant. **Every role except `owner`.**
 *
 * Ownership is not invitable, and the exclusion is structural rather than a
 * check: `owner` is absent from this list, so the request schema built from it
 * cannot express it and the database CHECK on `workspace_invitations` refuses
 * it independently.
 *
 * Why: a workspace has exactly one owner (`assertExactlyOneOwner`), and an
 * invitation that granted a second one would break that invariant days after it
 * was sent, in a transaction the inviter is not present for. Ownership TRANSFER
 * is a deliberate, authenticated, two-sided operation — BACKEND-27 — and an
 * emailed link is not it (§14, §15, §138).
 */
export const INVITABLE_WORKSPACE_ROLES = WORKSPACE_ROLES
  .filter((role): role is Exclude<WorkspaceRole, "owner"> => role !== "owner");

export type InvitableWorkspaceRole = (typeof INVITABLE_WORKSPACE_ROLES)[number];

export const InvitableWorkspaceRoleSchema = Type.Union(
  INVITABLE_WORKSPACE_ROLES.map(role => Type.Literal(role)),
  {
    title: "InvitableWorkspaceRole",
    description: "The membership role an invitation grants. Never `owner`.",
  },
);

/** A workspace invitation. Opaque, and NOT the invitation credential. */
export type WorkspaceInvitationId = string & {
  readonly __brand: "WorkspaceInvitationId";
};

/**
 * The states an invitation can be in.
 *
 * DERIVED from timestamps, never stored as a mutable column — see
 * INVITATION_STATE_MACHINE.md. `expired` in particular cannot be a column: it
 * is a function of the clock, and a stored value would be wrong between the
 * moment it lapses and whatever job noticed.
 */
export const INVITATION_STATES = [
  "pending", "accepted", "revoked", "declined", "superseded", "expired",
] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const InvitationStateSchema = Type.Union(
  INVITATION_STATES.map(state => Type.Literal(state)),
  { title: "InvitationState" },
);

/**
 * How long an invitation credential stays usable.
 *
 * Seven days. Not specified by the product or the handoff, so it is CHOSEN and
 * says so: long enough that an invitation sent on a Friday survives a holiday
 * week, short enough that a forwarded or archived mailbox does not carry a live
 * credential for months. The frontend's own list flags an invitation as
 * "expiring" inside two days, which is consistent with a lifetime of this order
 * and inconsistent with a much shorter one.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The maximum a workspace name may be, in Unicode code points.
 *
 * Matches the `varchar(200)` column. Stated in code points rather than bytes
 * because that is what a person composing a name experiences — a 200-character
 * limit that rejects a 90-character name because it is written in Baybayin is a
 * limit expressed in the wrong unit.
 */
export const WORKSPACE_NAME_MAX_LENGTH = 200;

/** The minimum, after trimming. One character is a legitimate name. */
export const WORKSPACE_NAME_MIN_LENGTH = 1;
