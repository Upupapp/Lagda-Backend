// Workspace invitations (BACKEND-26).
//
// ── The one sentence this file exists to enforce ───────────────────────────
//
//   An invitation is an OFFER. It grants nothing until acceptance creates a
//   membership, and acceptance requires an authenticated account whose
//   canonical email matches the one the offer was addressed to.
//
// Everything below is a consequence. The token proves the offer reached the
// right mailbox; the session proves who is asking; only both together create
// access. A forwarded link is useless to whoever receives it, and that is the
// single most valuable property in the design.

import type {
  UserId, WorkspaceId, WorkspaceInvitationId, InvitableWorkspaceRole,
  IdempotencyKey, InvitationState,
} from "@lagda/contracts";
import { INVITATION_TTL_MS } from "@lagda/contracts";
import {
  canManageInvitations, canGrantRole, deriveInvitationState,
  isInvitationRedeemable,
} from "@lagda/core";
import { normalizeEmail, type NormalizedEmail } from "../auth/email-identity.js";
import type {
  Clock, TransactionManager, WorkspaceInvitationRecord,
  WorkspaceInvitationIdGenerator, WorkspaceMemberIdGenerator,
  InvitationTokenFactory, InvitationLinkBuilder, InvitationDeliveryScheduler,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  createIdempotencyService, type IdempotencyDependencies,
} from "../idempotency/service.js";
import {
  requireWorkspaceAccess, type WorkspaceAccessDependencies,
} from "./workspace-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The invitee already belongs to this workspace.
 *
 * Safe to tell the INVITER: they are an authorized manager of this workspace and
 * already permitted to know who is in it. It would not be safe on the
 * acceptance path, where the caller has proved nothing about the workspace.
 */
export class AlreadyWorkspaceMemberError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "already_workspace_member";
  constructor() {
    super("That person is already a member of this workspace.");
  }
}

/** A live invitation for this address already occupies the slot. */
export class InvitationAlreadyPendingError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "invitation_already_pending";
  constructor() {
    super("An invitation for that address is already pending. Resend it instead.");
  }
}

/** The inviter may not grant the role they asked for. */
export class InvitationRoleNotAllowedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "invitation_role_not_allowed";
  constructor() {
    super("You cannot grant that role.");
  }
}

/**
 * ONE error for unknown, expired, revoked, superseded and consumed.
 *
 * Deliberately undifferentiated on the public path (§55, §163). Telling an
 * anonymous caller that a token was *revoked* rather than *unknown* confirms it
 * once existed, which turns the preview endpoint into an oracle for guessed
 * tokens — and no legitimate invitee needs the distinction: every one of those
 * states means "ask for a new invitation".
 */
export class InvitationInvalidError extends ApplicationError {
  readonly category = "not-found" as const;
  readonly code = "invalid_or_expired_invitation";
  constructor() {
    super("That invitation is no longer valid.");
  }
}

/**
 * A valid invitation, but the signed-in account is not the invitee.
 *
 * DISTINCT from `InvitationInvalidError`, and the distinction is deliberate
 * where the others are collapsed. The caller has already proved possession of a
 * live credential, so they learn nothing new about the invitation's existence —
 * and they genuinely need to be told to switch accounts, because otherwise the
 * only available advice is "your valid link does not work" (§64, §164).
 *
 * It carries no detail about the invited address. The frontend may show a
 * masked hint if the product asks for one; this error does not supply it.
 */
export class InvitationAccountMismatchError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "invitation_account_mismatch";
  constructor() {
    super("This invitation was sent to a different email address.");
  }
}

// ── Projections ──────────────────────────────────────────────────────────────

/** What an authorized workspace manager sees. */
export interface InvitationSummary {
  readonly invitationId: WorkspaceInvitationId;
  /** The DISPLAY address, as typed. Managers are entitled to see it. */
  readonly email: string;
  readonly role: InvitableWorkspaceRole;
  readonly state: InvitationState;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * What the holder of a valid credential sees, before authenticating.
 *
 * The workspace NAME is included, and that is a considered exception to
 * treating names as business-sensitive: the invitee was deliberately given this
 * credential by someone authorized to do so, and an invitation page that cannot
 * say which workspace it is for is useless. Nothing else about the tenant
 * appears — no members, no counts, no documents, no settings (§53, §54).
 *
 * `inviteeEmail` is echoed because the page must let a signed-in user see which
 * account to switch to. It is the address the recipient's own mailbox received.
 */
export interface InvitationPreview {
  readonly workspaceName: string;
  readonly role: InvitableWorkspaceRole;
  readonly inviteeEmail: string;
  readonly expiresAt: number;
}

function toSummary(
  record: WorkspaceInvitationRecord, now: number,
): InvitationSummary {
  return {
    invitationId: record.invitationId,
    email: record.inviteeEmail,
    role: record.requestedRole,
    state: deriveInvitationState(record, now),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface InvitationDependencies extends WorkspaceAccessDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly invitationIds: WorkspaceInvitationIdGenerator;
  readonly tokens: InvitationTokenFactory;
  readonly links: InvitationLinkBuilder;
  /**
   * Persists the intent to deliver, INSIDE the transaction.
   *
   * Optional only because there is no notification infrastructure yet — the
   * same seam email verification and password reset carry, for the same reason
   * (OD-003). Where it is absent the invitation is created correctly and the raw
   * token is discarded, which means nobody can accept it. Delivery is reported
   * as BLOCKED rather than implied to work.
   */
  readonly scheduleDelivery?: InvitationDeliveryScheduler;
  readonly idempotency: Omit<IdempotencyDependencies, "repository">;
}

export interface AcceptInvitationDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly tokens: InvitationTokenFactory;
  readonly memberIds: WorkspaceMemberIdGenerator;
  /**
   * The authenticated caller's CURRENT canonical email.
   *
   * Read from the account at acceptance time, never from the session and never
   * from the request. A session carries no email claim, and if it did it would
   * be stale the moment the user changed their address (§108, §109).
   */
  readonly currentNormalizedEmail: (userId: UserId) => Promise<NormalizedEmail | null>;
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateInvitationInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly email: string;
  readonly role: InvitableWorkspaceRole;
  readonly idempotencyKey?: IdempotencyKey;
}

export async function createWorkspaceInvitation(
  input: CreateInvitationInput,
  deps: InvitationDependencies,
): Promise<InvitationSummary> {
  // Authorization FIRST, before the email is even parsed. A caller who is not a
  // manager of this workspace must not be able to learn whether an address is
  // well-formed, let alone whether it is already a member.
  const access = await requireWorkspaceAccess(input.actor.userId, input.workspaceId, deps);
  if (!canManageInvitations(access.role)) throw new ResourceNotFoundError("Workspace");

  // The grant seam. Today: an owner may grant any invitable role, and `owner`
  // is not invitable. BACKEND-27 replaces the body, not the call site.
  if (!canGrantRole(access.role, input.role)) throw new InvitationRoleNotAllowedError();

  // The SAME normalizer registration, login and recovery use. An address that
  // resolves to one account at login and another at invitation would be a way
  // to send someone else's invitation to a mailbox you control.
  const normalized = normalizeEmail(input.email);
  if (normalized.outcome !== "ok") {
    throw new ApplicationValidationError("Enter a valid email address.", ["email"]);
  }

  const now = deps.clock.now();
  // Generated BEFORE the transaction: cheap, and a rolled-back transaction
  // discards it. An unsent raw token is inert.
  const token = deps.tokens.issue();
  const invitationId = deps.invitationIds.nextWorkspaceInvitationId();
  const expiresAt = now + INVITATION_TTL_MS;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const write = async (): Promise<{ statusCode: number; body: unknown }> => {
      // ── Already a member? ────────────────────────────────────────────────
      //
      // Checked here rather than left to the acceptance path, so no email is
      // sent to someone who would only be told they are already in (§17, §116).
      // The database's UNIQUE(workspace_id, user_id) remains the final
      // authority — this is a courtesy check, not the guarantee.
      const existingMember = await uow.memberships.findByNormalizedEmail(
        normalized.normalized);
      if (existingMember !== null) throw new AlreadyWorkspaceMemberError();

      // ── Already invited? ─────────────────────────────────────────────────
      //
      // CREATE DOES NOT SILENTLY RESEND (§117, §118). A form submitted twice
      // would otherwise email the recipient twice, rotate a credential the
      // first email already delivered, and make "create" and "resend"
      // indistinguishable to the rate limiter and to the audit log.
      const pending = await uow.invitations.findActiveByNormalizedEmail(
        normalized.normalized);
      if (pending !== null && isInvitationRedeemable(pending, now)) {
        throw new InvitationAlreadyPendingError();
      }

      // A logically EXPIRED row still occupies the partial unique index slot,
      // because the index cannot filter on the clock. Retire it explicitly
      // (§179) — this is the code that means to free the slot.
      if (pending !== null) {
        await uow.invitations.supersedeActiveForEmail({
          email: normalized.normalized, now,
        });
      }

      await uow.invitations.insert({
        invitationId,
        workspaceId: input.workspaceId,
        inviteeEmail: normalized.display,
        inviteeNormalizedEmail: normalized.normalized,
        requestedRole: input.role,
        invitedByUserId: input.actor.userId,
        // The DIGEST. The raw token never reaches persistence.
        tokenDigest: token.digest,
        createdAt: now,
        expiresAt,
      });

      // INSIDE the transaction. If delivery cannot be durably scheduled, the
      // invitation does not exist — better than a pending row in the manager's
      // list that no email will ever match (§129).
      await scheduleIfConfigured(deps, {
        invitationId, workspaceId: input.workspaceId,
        inviteeEmail: normalized.display, requestedRole: input.role,
        rawToken: token.raw, expiresAt,
      });

      const summary: InvitationSummary = {
        invitationId, email: normalized.display, role: input.role,
        state: "pending", createdAt: now, expiresAt,
      };
      return { statusCode: 201, body: summary };
    };

    if (input.idempotencyKey === undefined) {
      const result = await write();
      return result.body as InvitationSummary;
    }

    // Scoped to the WORKSPACE, not the user: two managers of one workspace
    // inviting the same person are the same logical operation, and the handoff
    // named `workspace.invitation.create` as workspace-scoped.
    const outcome = await createIdempotencyService({
      ...deps.idempotency, repository: uow.idempotency,
    }).execute({
      key: input.idempotencyKey,
      operation: "workspace.invitation.create",
      scope: { type: "workspace", workspaceId: input.workspaceId },
      // The NORMALIZED email and the role. Casing differences between two
      // retries are the same logical request; a different address or a
      // different role is not, and conflicts.
      request: { email: normalized.normalized, role: input.role },
      execute: write,
    });
    return outcome.body as InvitationSummary;
  });
}

/** Builds the link and hands it to delivery. Never logs it, never stores it. */
async function scheduleIfConfigured(
  deps: InvitationDependencies,
  input: {
    invitationId: WorkspaceInvitationId; workspaceId: WorkspaceId;
    inviteeEmail: string; requestedRole: InvitableWorkspaceRole;
    rawToken: string; expiresAt: number;
  },
): Promise<void> {
  if (deps.scheduleDelivery === undefined) return;
  await deps.scheduleDelivery({
    invitationId: input.invitationId,
    workspaceId: input.workspaceId,
    inviteeEmail: input.inviteeEmail,
    requestedRole: input.requestedRole,
    // Built from CONFIGURED origin. The builder has no request in scope, so a
    // Host header cannot reach it.
    invitationUrl: deps.links.build(input.rawToken),
    expiresAt: input.expiresAt,
  });
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listWorkspaceInvitations(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  deps: InvitationDependencies,
): Promise<readonly InvitationSummary[]> {
  const access = await requireWorkspaceAccess(actor.userId, workspaceId, deps);
  // Ordinary members do not see who has been invited. That is management state
  // about people who are not yet in the workspace (§91).
  if (!canManageInvitations(access.role)) throw new ResourceNotFoundError("Workspace");

  const now = deps.clock.now();
  const records = await deps.transactions.runForWorkspace(
    workspaceId, uow => uow.invitations.list());
  return records.map(record => toSummary(record, now));
}

// ── Resend ───────────────────────────────────────────────────────────────────

export interface ResendInvitationInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly invitationId: WorkspaceInvitationId;
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * Rotates the credential and schedules a fresh delivery.
 *
 * ── The rotation model (§34) ───────────────────────────────────────────────
 *
 * ONE invitation row, whose credential is replaced in place. Not a new row
 * superseding the old one.
 *
 * Why: the invitation's identity is "this workspace offered this address this
 * role", and a resend does not change any of that — it replaces the *link*. A
 * new row per resend would make the manager's list grow one entry per click and
 * make "when were they invited" ambiguous. The old digest stops resolving the
 * moment the UPDATE commits, which is exactly one valid link at all times
 * (§32, §128).
 *
 * The cost is that credential history is not retained per generation. That is
 * acceptable because a superseded digest is unusable and unrecoverable — there
 * is nothing about it worth keeping — and the operational events are on the
 * audit trail.
 *
 * Neither the address nor the role can change here: there is no field for
 * either (§89, §90, §123). Changing the target is a different invitation.
 */
export async function resendWorkspaceInvitation(
  input: ResendInvitationInput,
  deps: InvitationDependencies,
): Promise<InvitationSummary> {
  const access = await requireWorkspaceAccess(input.actor.userId, input.workspaceId, deps);
  if (!canManageInvitations(access.role)) throw new ResourceNotFoundError("Workspace");

  const now = deps.clock.now();
  const token = deps.tokens.issue();
  const expiresAt = now + INVITATION_TTL_MS;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const write = async (): Promise<{ statusCode: number; body: unknown }> => {
      const existing = await uow.invitations.findById(input.invitationId);
      // Absent, or belonging to another tenant — the repository is scoped, so
      // both produce the same null and the same answer.
      if (existing === null) throw new ResourceNotFoundError("Invitation");
      // Already accepted, revoked, declined or expired. Resending a dead
      // invitation would quietly resurrect it; create a new one instead.
      if (!isInvitationRedeemable(existing, now)) throw new InvitationInvalidError();

      const rotated = await uow.invitations.rotateCredentialIfLive({
        invitationId: input.invitationId,
        tokenDigest: token.digest,
        expiresAt,
        now,
      });
      // Lost a race with a concurrent revoke or accept. The conditional UPDATE
      // is what makes that safe rather than a lost update.
      if (!rotated) throw new InvitationInvalidError();

      // INSIDE the transaction, and this is the case that makes the placement
      // matter most: if scheduling fails after the rotation, committing would
      // leave the recipient's existing link dead and the replacement unsent —
      // an invitee with no way in and a manager who thinks they resent it
      // (§33, §260).
      await scheduleIfConfigured(deps, {
        invitationId: existing.invitationId,
        workspaceId: input.workspaceId,
        inviteeEmail: existing.inviteeEmail,
        requestedRole: existing.requestedRole,
        rawToken: token.raw,
        expiresAt,
      });

      const summary: InvitationSummary = {
        invitationId: existing.invitationId,
        email: existing.inviteeEmail,
        role: existing.requestedRole,
        state: "pending",
        createdAt: existing.createdAt,
        expiresAt,
      };
      return { statusCode: 200, body: summary };
    };

    if (input.idempotencyKey === undefined) {
      const result = await write();
      return result.body as InvitationSummary;
    }

    // A network retry of ONE resend must not rotate twice. Two deliberate
    // resends carry two different keys and both rotate — which is the
    // distinction §43 asks for, and it is the client's key that draws it.
    const outcome = await createIdempotencyService({
      ...deps.idempotency, repository: uow.idempotency,
    }).execute({
      key: input.idempotencyKey,
      operation: "workspace.invitation.resend",
      scope: { type: "workspace", workspaceId: input.workspaceId },
      request: { invitationId: input.invitationId },
      execute: write,
    });
    return outcome.body as InvitationSummary;
  });
}

// ── Revoke ───────────────────────────────────────────────────────────────────

export type RevokeInvitationResult =
  | { readonly outcome: "revoked" }
  /** Already accepted, revoked, declined or expired. Nothing to do. */
  | { readonly outcome: "not-pending"; readonly state: InvitationState };

export async function revokeWorkspaceInvitation(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  invitationId: WorkspaceInvitationId,
  deps: InvitationDependencies,
): Promise<RevokeInvitationResult> {
  const access = await requireWorkspaceAccess(actor.userId, workspaceId, deps);
  if (!canManageInvitations(access.role)) throw new ResourceNotFoundError("Workspace");

  const now = deps.clock.now();
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const existing = await uow.invitations.findById(invitationId);
    if (existing === null) throw new ResourceNotFoundError("Invitation");

    const applied = await uow.invitations.revokeIfLive({ invitationId, now });
    if (applied) return { outcome: "revoked" as const };

    // Not an error. Revoking an already-accepted invitation cannot undo the
    // membership — removing a member is a different operation that does not
    // exist yet (§86) — and revoking an expired one changes nothing (§87).
    // Reporting the state is more useful to the UI than a failure.
    return {
      outcome: "not-pending" as const,
      state: deriveInvitationState(existing, now),
    };
  });
}

// ── Preview ──────────────────────────────────────────────────────────────────

/**
 * Resolves an invitation from its credential, for the invitation page.
 *
 * UNAUTHENTICATED, deliberately: the recipient may not have an account yet, and
 * the page has to tell them what they are being invited to before it can ask
 * them to register (§185).
 *
 * Creates nothing and consumes nothing. It is a read, and it is reached by POST
 * rather than GET only so the credential stays out of the URL and therefore out
 * of access logs and referrers — not because it mutates.
 */
export async function getWorkspaceInvitationPreview(
  rawToken: string,
  deps: AcceptInvitationDependencies,
): Promise<InvitationPreview> {
  const digest = deps.tokens.digest(rawToken);
  // Refused by SHAPE, before any database round trip. A malformed submission
  // never becomes a query, and never has to be echoed to explain why.
  if (digest === null) throw new InvitationInvalidError();

  const now = deps.clock.now();
  return deps.transactions.runForInvitationCredential(digest, async uow => {
    const invitation = await uow.invitation.find();
    if (invitation === null) throw new InvitationInvalidError();
    if (!isInvitationRedeemable(invitation, now)) throw new InvitationInvalidError();

    // Entering the workspace to read its NAME, and nothing else. The tenant
    // transition is what makes even this one field readable, and the invitation
    // is what authorized the transition.
    const workspace = await uow.enterWorkspace(
      invitation.workspaceId, ws => ws.workspaces.find());
    if (workspace === null) throw new InvitationInvalidError();

    return {
      workspaceName: workspace.name,
      role: invitation.requestedRole,
      inviteeEmail: invitation.inviteeEmail,
      expiresAt: invitation.expiresAt,
    };
  });
}

// ── Accept ───────────────────────────────────────────────────────────────────

export interface AcceptInvitationResult {
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  readonly role: InvitableWorkspaceRole;
  /** True when this call created the membership; false when it already existed. */
  readonly joined: boolean;
}

/**
 * Consumes an invitation and creates the membership, in ONE transaction.
 *
 * ── The two proofs ─────────────────────────────────────────────────────────
 *
 *   the credential  proves the offer reached the invited mailbox
 *   the session     proves who is claiming it
 *
 * Requiring both is what makes a forwarded or stolen link worthless: whoever
 * holds it still cannot authenticate as the invited address (§189, §190).
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not create an account, does not issue a session, does not bypass
 * email verification or MFA, and does not set `email_verified_at`. An
 * invitation is an authorization offer, not an authentication ceremony
 * (§57, §67, §113).
 */
export async function acceptWorkspaceInvitation(
  actor: AuthenticatedActor,
  rawToken: string,
  deps: AcceptInvitationDependencies,
): Promise<AcceptInvitationResult> {
  const digest = deps.tokens.digest(rawToken);
  if (digest === null) throw new InvitationInvalidError();

  // The caller's CURRENT canonical address. Read now, from the account — not
  // from the session, which carries no email, and not from the request, which
  // would let the caller nominate an identity.
  const callerEmail = await deps.currentNormalizedEmail(actor.userId);
  if (callerEmail === null) throw new InvitationInvalidError();

  const now = deps.clock.now();

  return deps.transactions.runForInvitationCredential(digest, async uow => {
    const invitation = await uow.invitation.find();
    if (invitation === null) throw new InvitationInvalidError();
    if (!isInvitationRedeemable(invitation, now)) throw new InvitationInvalidError();

    // ── Identity match ──────────────────────────────────────────────────────
    //
    // Canonical against canonical, so `Juan.Cruz@Example.com` accepts an
    // invitation addressed to `juan.cruz@example.com` — one mailbox, one
    // identity.
    //
    // After an account email CHANGE this deliberately fails: the invitation was
    // addressed to a mailbox, and matching by the UserId that mailbox once
    // belonged to would let an invitation follow a person to an address the
    // inviter never chose (§109, §110).
    if (invitation.inviteeNormalizedEmail !== callerEmail) {
      throw new InvitationAccountMismatchError();
    }

    // Tenant context, from the RESOLVED invitation. The client never supplies a
    // workspace, so there is nothing to tamper with (§144, §195).
    return uow.enterWorkspace(invitation.workspaceId, async ws => {
      const workspace = await ws.workspaces.find();
      // A workspace that cannot be read has no lifecycle state permitting a new
      // member. Today unreachable — a foreign key guarantees it exists — and
      // handled because "cannot happen" is a claim about a constraint.
      if (workspace === null) throw new InvitationInvalidError();

      const existing = await ws.memberships.findByUser(actor.userId);
      if (existing !== null) {
        // ── Converge, do not fail ─────────────────────────────────────────
        //
        // The membership arrived by another route — a second invitation, or a
        // concurrent acceptance. Consuming the invitation and reporting success
        // is right: the desired end state holds, and leaving the invitation
        // live would dangle a credential for access that already exists (§75,
        // §115, §165).
        await ws.invitations.acceptIfLive({
          invitationId: invitation.invitationId,
          acceptedByUserId: actor.userId,
          now,
        });
        return {
          workspaceId: invitation.workspaceId,
          workspaceName: workspace.name,
          role: invitation.requestedRole,
          joined: false,
        };
      }

      // ── Consume FIRST, then insert ──────────────────────────────────────
      //
      // The conditional UPDATE is the serialization point. Of two concurrent
      // acceptances of one token, exactly one matches a row here; the other
      // gets `false` and stops without ever attempting a membership insert.
      //
      // Ordering it before the insert is safe because both are in one
      // transaction: if the insert then fails, the consumption rolls back with
      // it and the invitation is live again (§73).
      const consumed = await ws.invitations.acceptIfLive({
        invitationId: invitation.invitationId,
        acceptedByUserId: actor.userId,
        now,
      });
      if (!consumed) throw new InvitationInvalidError();

      await ws.memberships.insert({
        memberId: deps.memberIds.nextWorkspaceMemberId(),
        workspaceId: invitation.workspaceId,
        userId: actor.userId,
        // From the PERSISTED invitation. There is no role field on the accept
        // request, so the invitee cannot choose their own (§78, §194).
        role: invitation.requestedRole,
        createdAt: now,
      });

      return {
        workspaceId: invitation.workspaceId,
        workspaceName: workspace.name,
        role: invitation.requestedRole,
        joined: true,
      };
    });
  });
}

// ── Decline ──────────────────────────────────────────────────────────────────

/**
 * The invitee refuses the offer.
 *
 * In the product: `AcceptInvitation.tsx` has a Decline button and a declined
 * screen. Distinct from revocation — one is the recipient saying no, the other
 * is the workspace withdrawing — so it gets `declined_at` rather than
 * overloading `revoked_at`, and the manager's list can tell the two apart
 * (§102, §104).
 *
 * Requires the same two proofs as acceptance. Otherwise anyone holding a
 * forwarded link could burn someone else's invitation (§103).
 *
 * Declining does not blocklist the address: a manager may invite them again
 * (§105).
 */
export async function declineWorkspaceInvitation(
  actor: AuthenticatedActor,
  rawToken: string,
  deps: AcceptInvitationDependencies,
): Promise<{ readonly declined: true }> {
  const digest = deps.tokens.digest(rawToken);
  if (digest === null) throw new InvitationInvalidError();

  const callerEmail = await deps.currentNormalizedEmail(actor.userId);
  if (callerEmail === null) throw new InvitationInvalidError();

  const now = deps.clock.now();
  return deps.transactions.runForInvitationCredential(digest, async uow => {
    const invitation = await uow.invitation.find();
    if (invitation === null) throw new InvitationInvalidError();
    if (!isInvitationRedeemable(invitation, now)) throw new InvitationInvalidError();
    if (invitation.inviteeNormalizedEmail !== callerEmail) {
      throw new InvitationAccountMismatchError();
    }

    const applied = await uow.enterWorkspace(invitation.workspaceId, ws =>
      ws.invitations.declineIfLive({ invitationId: invitation.invitationId, now }));
    if (!applied) throw new InvitationInvalidError();

    return { declined: true as const };
  });
}
