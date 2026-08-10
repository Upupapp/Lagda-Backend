// Workspace member administration (BACKEND-27).
//
// ── Why these three read the actor's membership INSIDE the transaction ─────
//
// Every other workspace operation resolves authorization first and then opens a
// transaction. That is safe for a read and for a rename. It is not safe here.
//
// The race: an administrator is demoted while their "remove this member"
// request is in flight. A pre-transaction check saw them as an administrator;
// the write lands afterwards, with authority they no longer have. The window is
// small and the operations are the most destructive in the tenant, which is the
// combination worth closing (§149, §150).
//
// So the shape is:
//
//   begin
//     load the ACTOR's membership        ← authority, read now, not earlier
//     require the capability
//     load the TARGET's membership
//     enforce the ownership invariants   ← owner count, read now
//     mutate
//   commit
//
// One transaction. The authority the write commits under is the authority the
// database held when it committed.

import type {
  UserId, WorkspaceId, WorkspaceMemberId, WorkspaceRole,
} from "@lagda/contracts";
import {
  canGrantRole, wouldRemoveLastOwner, type WorkspaceCapability,
} from "@lagda/core";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import { ApplicationError, ResourceNotFoundError } from "../common/errors/index.js";
import { assertCapability, type WorkspaceAccessContext } from "./workspace-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The actor may not hand out the role they asked for.
 *
 * DISTINCT from the hidden 404 that a missing capability produces. The caller
 * has already proved they may change roles at all, so refusing them a specific
 * role tells them nothing they could not infer — and they need to know the
 * attempt failed for a reason retrying will not fix.
 */
export class RoleGrantDeniedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "role_grant_denied";
  constructor() {
    super("You cannot assign that role.");
  }
}

/**
 * The operation would leave the workspace with no owner.
 *
 * Under `SINGLE_OWNER` this is reachable for every attempt to demote or remove
 * the owner, because there is never a second one. The message says what to do
 * instead rather than restating the rule.
 */
export class LastOwnerViolationError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "last_owner_violation";
  constructor() {
    super("A workspace must always have an owner. Transfer ownership first.");
  }
}

/** The actor aimed a member-administration operation at themselves. */
export class CannotAdministerSelfError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "cannot_administer_self";
  constructor(action: string) {
    super(`You cannot ${action} yourself.`);
  }
}

// ── Projections ──────────────────────────────────────────────────────────────

/**
 * A member, as an authorized administrator sees them.
 *
 * The EMAIL is included, and that is a product decision rather than a default:
 * `MembersPage.tsx` renders it under every name, and a directory without it
 * cannot do its job. It is gated behind `membership.view`, which only `owner`
 * and `administrator` hold — an ordinary member cannot obtain the list at all.
 *
 * Never present: password state, session identifiers, MFA state, token
 * digests, or anything about another workspace.
 */
export interface WorkspaceMemberSummary {
  readonly membershipId: WorkspaceMemberId;
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly role: WorkspaceRole;
  readonly joinedAt: number;
  /** So a client can mark the current user without comparing ids itself. */
  readonly isCurrentUser: boolean;
}

export interface MemberAdministrationDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
}

// ── The transactional authorization frame ────────────────────────────────────

/**
 * Resolves the actor's CURRENT authority inside an open transaction.
 *
 * The whole point of this file. It reads the actor's own membership row through
 * the same unit of work the mutation will use, so the role it returns is the
 * role the database holds at commit time — not one read a few milliseconds
 * earlier over a different connection.
 */
async function actorAuthorityInTransaction(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member — or no longer one. Same hidden 404 as everywhere else.
  if (membership === null) throw new ResourceNotFoundError("Workspace");

  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
  assertCapability(access, capability);
  return access;
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listWorkspaceMembers(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  deps: MemberAdministrationDependencies,
): Promise<readonly WorkspaceMemberSummary[]> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await actorAuthorityInTransaction(uow, actor, "membership.view");
    const members = await uow.memberships.listWithAccounts();
    return members.map(member => ({
      membershipId: member.memberId,
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.createdAt,
      isCurrentUser: member.userId === actor.userId,
    }));
  });
}

// ── Role change ──────────────────────────────────────────────────────────────

export type ChangeMemberRoleResult =
  | { readonly outcome: "changed"; readonly member: WorkspaceMemberSummary }
  /** The target already held the requested role. Nothing was written. */
  | { readonly outcome: "unchanged"; readonly member: WorkspaceMemberSummary };

/**
 * Changes another member's role.
 *
 * ── Four rules, in this order ──────────────────────────────────────────────
 *
 *   1. The actor holds `membership.role.change`, read inside the transaction.
 *   2. The actor is not the target. Self-promotion is impossible because there
 *      is no path to it, not because a comparison rejects it late (§116, §117).
 *   3. The actor may grant the requested role. Nobody may grant `owner`.
 *   4. The change does not orphan the workspace.
 *
 * ── Why owner demotion always fails ────────────────────────────────────────
 *
 * Under `SINGLE_OWNER`, demoting the owner always removes the last one — rule 4
 * refuses every attempt. Combined with rule 3, `owner` is a role no operation
 * in the system can enter or leave. That is a real consequence and it is why
 * ownership transfer is the highest-priority gap in the report, not a footnote.
 */
export async function changeWorkspaceMemberRole(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  membershipId: WorkspaceMemberId,
  newRole: WorkspaceRole,
  deps: MemberAdministrationDependencies,
): Promise<ChangeMemberRoleResult> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await actorAuthorityInTransaction(uow, actor, "membership.role.change");

    const target = await uow.memberships.findMember(membershipId);
    // Absent, or in another tenant — the repository is workspace-scoped, so
    // both produce the same null and the same answer. A membership id from
    // another workspace cannot redirect this operation (§146).
    if (target === null) throw new ResourceNotFoundError("Member");

    // Rule 2. Checked BEFORE the grant rule so a self-targeted request is
    // refused for the reason it is actually wrong.
    if (target.userId === actor.userId) {
      throw new CannotAdministerSelfError("change the role of");
    }

    // Rule 3. The grant matrix, not the capability — holding the capability
    // says you may change roles, not which roles you may hand out.
    if (!canGrantRole(access.role, newRole)) throw new RoleGrantDeniedError();

    if (target.role === newRole) {
      // A no-op. Reporting success without writing avoids a spurious audit
      // event for a change that did not happen (§118).
      return {
        outcome: "unchanged" as const,
        member: await summarize(uow, target.memberId, actor.userId),
      };
    }

    // Rule 4. The count is read HERE, in this transaction — not before it.
    if (wouldRemoveLastOwner({
      currentRole: target.role,
      ownerCount: await uow.memberships.countOwners(),
    })) {
      throw new LastOwnerViolationError();
    }

    // Conditional on the role the check was made against. Two administrators
    // acting on one member concurrently would otherwise both proceed, and the
    // second would overwrite a decision made against state it never saw.
    const applied = await uow.memberships.changeRoleIfUnchanged({
      memberId: target.memberId,
      expectedRole: target.role,
      nextRole: newRole,
    });
    // Lost the race. Deliberately ambiguous, and the caller retries against
    // fresh state rather than being told what it lost to.
    if (!applied) throw new ResourceNotFoundError("Member");

    return {
      outcome: "changed" as const,
      member: await summarize(uow, target.memberId, actor.userId),
    };
  });
}

// ── Removal ──────────────────────────────────────────────────────────────────

/**
 * Removes a member from the workspace.
 *
 * ── The persistence model: the row is DELETED ──────────────────────────────
 *
 * Not `removed_at`. The alternative was considered and rejected, and the reason
 * is the invariant BACKEND-25 built the table around: a membership row means
 * ACTUAL ACCESS. A `removed_at` column reintroduces exactly the problem
 * INV-324 exists to prevent — every authorization query in the system would
 * need `AND removed_at IS NULL`, and the one that forgot would authorize
 * someone who was removed.
 *
 * The conditions §51 sets for this being acceptable all hold today:
 *
 *   - the administrative action is recorded as a security event;
 *   - no table references `workspace_memberships`, so nothing is orphaned;
 *   - historical signing evidence references users and snapshots, never a live
 *     membership row, so removing one rewrites no history;
 *   - re-inviting a removed person is an ordinary new invitation, with no
 *     reactivate-or-recreate ambiguity to resolve (§168).
 *
 * Recorded in MEMBER_LIFECYCLE.md. If durable per-tenure history is ever
 * required, the migration is a new table rather than a nullable column on the
 * one that answers "may this person act here".
 *
 * ── What removal does NOT do ───────────────────────────────────────────────
 *
 * It does not delete the account, does not revoke a single login session, and
 * does not touch the person's membership of any other workspace. Their next
 * request to THIS workspace resolves no membership and is refused; every other
 * workspace they belong to is unaffected. That is BACKEND-25's design paying
 * out (§52, §56, §176).
 */
export async function removeWorkspaceMember(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  membershipId: WorkspaceMemberId,
  deps: MemberAdministrationDependencies,
): Promise<{ readonly removed: true; readonly userId: UserId }> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await actorAuthorityInTransaction(uow, actor, "membership.remove");

    const target = await uow.memberships.findMember(membershipId);
    if (target === null) throw new ResourceNotFoundError("Member");

    // Removing yourself is leaving, which has different authorization
    // semantics — and leaving is not in the product (§54). Refusing here is
    // better than quietly treating an administrator's misclick as a departure.
    if (target.userId === actor.userId) {
      throw new CannotAdministerSelfError("remove");
    }

    if (wouldRemoveLastOwner({
      currentRole: target.role,
      ownerCount: await uow.memberships.countOwners(),
    })) {
      throw new LastOwnerViolationError();
    }

    const removed = await uow.memberships.removeIfRole({
      memberId: target.memberId,
      expectedRole: target.role,
    });
    // Lost a race with a concurrent role change or removal.
    if (!removed) throw new ResourceNotFoundError("Member");

    return { removed: true as const, userId: target.userId };
  });
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function summarize(
  uow: WorkspaceUnitOfWork,
  membershipId: WorkspaceMemberId,
  actorUserId: UserId,
): Promise<WorkspaceMemberSummary> {
  const members = await uow.memberships.listWithAccounts();
  const member = members.find(candidate => candidate.memberId === membershipId);
  if (member === undefined) throw new ResourceNotFoundError("Member");
  return {
    membershipId: member.memberId,
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.createdAt,
    isCurrentUser: member.userId === actorUserId,
  };
}

/**
 * Deliberately absent from this module.
 *
 * **Leave workspace** — no control exists anywhere in the product. A member
 * cannot leave; an administrator removes them (OD-102).
 *
 * **Ownership transfer** — the product's control says "demonstration only", so
 * it is deferred exactly as BACKEND-25 deferred it. The consequence is stated
 * plainly rather than hidden: with no transfer, `owner` is a role no operation
 * can enter or leave, and every owner demotion and removal is refused by the
 * last-owner rule. OWNERSHIP_MODEL.md and OD-101.
 *
 * **Suspend, reactivate, deactivate** — three further member states the product
 * exposes. They are a membership STATUS model, not a role or a removal, and
 * adding a status column is the thing INV-324 exists to prevent (OD-103).
 */
export type MemberAdministrationDeferred = never;
