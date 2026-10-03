// 089. The signed-in invitee's inbox: "my invitations".
//
// ── Matched by the VERIFIED address, never by a link ───────────────────────
//
// The emailed link (014) proves the offer reached a mailbox. The inbox proves
// the same thing a different way: the account's CURRENT normalized address,
// verified, equals the one the invitation was addressed to. An unverified
// account sees nothing and is told why (403 `account_email_unverified`); an
// invitation addressed to anybody else is simply not found (404) — the realm
// cannot read it, so there is nothing to compare.
//
// ── Reads across workspaces, writes inside one ─────────────────────────────
//
// The invitee is not a member of the inviting workspace. The realm (089's FOR
// SELECT policy on a digest of the address) lists the invitations addressed to
// the account in every workspace; every write — accept, decline, withdraw a
// decline — happens only after the transaction enters the RESOLVED
// invitation's own workspace, where `tenant_isolation` governs it.
//
// ── The same outcomes as the link ──────────────────────────────────────────
//
// Accepting consumes the invitation and creates the membership through the
// SAME body the token acceptance runs. Declining needs a reason,
// which the inviter is told in-app. A decline can be withdrawn while the
// invitation is neither expired nor ended some other way.

import type { UserId, WorkspaceId, InvitableWorkspaceRole } from "@lagda/contracts";
import { deriveInvitationState } from "@lagda/core";
import type { NormalizedEmail } from "../auth/email-identity.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type {
  WorkspaceInvitationRecord, InviteeInboxUnitOfWork,
} from "../common/ports/invitations.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import { recordActivity } from "./activity.js";
import {
  consumeInvitation, announceInvitationDeclined,
  type AcceptInvitationResult, type InvitationNoticeDependencies,
} from "./invitations.js";
import type { JoinNotifyDependencies } from "./workspace-join.js";

/** The decline reason's bounds, after trimming. */
export const INVITATION_DECLINE_REASON_MAX_LENGTH = 500;

// ── Errors ───────────────────────────────────────────────────────────────────

/** 403: the inbox is matched by a VERIFIED address, and this one is not. */
export class InvitationInboxEmailUnverifiedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "account_email_unverified";
  constructor() {
    super("Verify your account email address to see the invitations sent to it.");
  }
}

/** 409: the invitation is addressed to the caller but not in a state that allows this. */
export class InvitationStateConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "invitation_state_conflict";
  constructor(message: string) {
    super(message);
  }
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/** The signed-in account's CURRENT address, read from the account itself. */
export interface InviteeAccount {
  readonly normalizedEmail: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface MyInvitationDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  /** 078. Accepting files a join request; this tells the owners and administrators. */
  readonly joinRequests: JoinNotifyDependencies;
  /** Tells the inviter about a decline. */
  readonly notices: InvitationNoticeDependencies;
  readonly currentAccount: (userId: UserId) => Promise<InviteeAccount | null>;
}

// ── Views ────────────────────────────────────────────────────────────────────

export type MyInvitationStatus = "pending" | "declined" | "accepted";
export const MY_INVITATION_STATUSES: readonly MyInvitationStatus[] = ["pending", "declined", "accepted"];

export interface MyInvitationView {
  readonly invitationId: string;
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  readonly role: InvitableWorkspaceRole;
  readonly invitedBy: { readonly displayName: string };
  readonly status: MyInvitationStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly declinedAt: number | null;
  readonly declineReason: string | null;
  readonly branding: {
    /** The workspace's sender name when it set one, else its name. */
    readonly displayName: string;
    readonly primaryColor: string | null;
    /** Fetch it from the recipient-safe logo route; `version` changes with the logo. */
    readonly logo: { readonly version: string } | null;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const UNKNOWN_WORKSPACE = "A workspace";
const UNKNOWN_PERSON = "Someone";

function bounded(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

/** The inbox status of one invitation, or null when it is not listed at all. */
function statusOf(record: WorkspaceInvitationRecord, now: number): MyInvitationStatus | null {
  const state = deriveInvitationState(record, now);
  return state === "pending" || state === "declined" || state === "accepted" ? state : null;
}

async function inviteeOf(
  userId: UserId, deps: Pick<MyInvitationDependencies, "currentAccount">,
): Promise<{ readonly verifiedEmail: NormalizedEmail; readonly displayName: string }> {
  const account = await deps.currentAccount(userId);
  if (account === null || !account.emailVerified) throw new InvitationInboxEmailUnverifiedError();
  return { verifiedEmail: account.normalizedEmail as NormalizedEmail, displayName: account.displayName };
}

/** The caller's own invitation, by id — anything else is not found. */
async function mine(
  ruow: InviteeInboxUnitOfWork, invitationId: string,
): Promise<WorkspaceInvitationRecord> {
  const record = await ruow.findInvitation(invitationId);
  // Stated twice: the realm only shows invitations to this digest, and the
  // normalized address must equal the verified one.
  if (record === null || record.inviteeNormalizedEmail !== ruow.invitee.verifiedEmail) {
    throw new ResourceNotFoundError("Invitation");
  }
  return record;
}

async function present(
  uow: WorkspaceUnitOfWork, record: WorkspaceInvitationRecord, status: MyInvitationStatus,
): Promise<MyInvitationView> {
  const workspace = await uow.workspaces.find();
  const branding = await uow.branding.find();
  const inviter = await uow.actorProfiles.displayNameOf(record.invitedByUserId);
  const workspaceName = bounded(workspace?.name, UNKNOWN_WORKSPACE);
  return {
    invitationId: String(record.invitationId),
    workspaceId: record.workspaceId,
    workspaceName,
    role: record.requestedRole,
    invitedBy: { displayName: bounded(inviter, UNKNOWN_PERSON) },
    status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    declinedAt: record.declinedAt,
    declineReason: record.declineReason,
    branding: {
      displayName: bounded(branding?.senderDisplayName, workspaceName),
      primaryColor: branding?.primaryColor ?? null,
      logo: branding?.logo === null || branding?.logo === undefined ? null : { version: branding.logo.digest },
    },
  };
}

function validReason(value: string | null | undefined): string {
  const reason = (value ?? "").trim();
  if (reason.length === 0) {
    throw new ApplicationValidationError("Give a reason for declining.", ["reason: required"]);
  }
  if (reason.length > INVITATION_DECLINE_REASON_MAX_LENGTH) {
    throw new ApplicationValidationError("Keep the reason to 500 characters.",
      [`reason: at most ${String(INVITATION_DECLINE_REASON_MAX_LENGTH)} characters`]);
  }
  return reason;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The invitations addressed to the caller's verified address, by status, newest first. */
export async function listMyInvitations(
  userId: UserId, status: MyInvitationStatus,
  deps: Pick<MyInvitationDependencies, "transactions" | "clock" | "currentAccount">,
): Promise<readonly MyInvitationView[]> {
  const invitee = await inviteeOf(userId, deps);
  const now = deps.clock.now();
  return deps.transactions.runForInviteeInbox({ userId, verifiedEmail: invitee.verifiedEmail }, async ruow => {
    const records = (await ruow.listInvitations())
      .filter(record => record.inviteeNormalizedEmail === invitee.verifiedEmail)
      .filter(record => statusOf(record, now) === status);
    const views: MyInvitationView[] = [];
    for (const record of records) {
      views.push(await ruow.enterWorkspace(record.workspaceId, uow => present(uow, record, status)));
    }
    return views.sort((a, b) => b.createdAt - a.createdAt || a.invitationId.localeCompare(b.invitationId));
  });
}

/**
 * The inviting workspace's logo, for an invitee who is NOT a member of it —
 * reachable only through an invitation the inbox lists for this account.
 */
export async function getMyInvitationLogo(
  userId: UserId, invitationId: string,
  deps: Pick<MyInvitationDependencies, "transactions" | "clock" | "currentAccount">,
): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly mediaType: "image/png" } | null> {
  const invitee = await inviteeOf(userId, deps);
  const now = deps.clock.now();
  return deps.transactions.runForInviteeInbox({ userId, verifiedEmail: invitee.verifiedEmail }, async ruow => {
    const record = await mine(ruow, invitationId);
    if (statusOf(record, now) === null) throw new ResourceNotFoundError("Invitation");
    return ruow.enterWorkspace(record.workspaceId, async uow => {
      const logo = await uow.branding.findLogo();
      return logo === null ? null : { bytes: logo.bytes, digest: logo.digest, mediaType: logo.mediaType };
    });
  });
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Accepts from the inbox: exactly what the emailed link's acceptance does. */
export async function acceptMyInvitation(
  actor: AuthenticatedActor, invitationId: string, deps: MyInvitationDependencies,
): Promise<AcceptInvitationResult> {
  const invitee = await inviteeOf(actor.userId, deps);
  const now = deps.clock.now();
  return deps.transactions.runForInviteeInbox(
    { userId: actor.userId, verifiedEmail: invitee.verifiedEmail }, async ruow => {
      const record = await mine(ruow, invitationId);
      if (deriveInvitationState(record, now) !== "pending") {
        throw new InvitationStateConflictError("This invitation can no longer be accepted.");
      }
      return ruow.enterWorkspace(record.workspaceId, ws =>
        consumeInvitation(ws, record, actor.userId, invitee.verifiedEmail, deps, now));
    });
}

/** Declines from the inbox. The reason is required and the inviter is told it. */
export async function declineMyInvitation(
  actor: AuthenticatedActor, invitationId: string, input: { readonly reason: string },
  deps: MyInvitationDependencies,
): Promise<MyInvitationView> {
  const reason = validReason(input.reason);
  const invitee = await inviteeOf(actor.userId, deps);
  const now = deps.clock.now();
  return deps.transactions.runForInviteeInbox(
    { userId: actor.userId, verifiedEmail: invitee.verifiedEmail }, async ruow => {
      const record = await mine(ruow, invitationId);
      if (deriveInvitationState(record, now) !== "pending") {
        throw new InvitationStateConflictError("This invitation can no longer be declined.");
      }
      return ruow.enterWorkspace(record.workspaceId, async ws => {
        const declined = await ws.invitations.declineIfLive({ invitationId: record.invitationId, now, reason });
        if (!declined) throw new InvitationStateConflictError("This invitation can no longer be declined.");
        await recordActivity(ws, {
          action: "invitation.declined", actorUserId: actor.userId, occurredAt: now,
          actorName: bounded(invitee.displayName, record.inviteeEmail),
          details: { email: record.inviteeEmail, reason },
        });
        await announceInvitationDeclined(ws, deps.notices, record, { displayName: invitee.displayName, reason });
        return present(ws, { ...record, declinedAt: now, declineReason: reason }, "declined");
      });
    });
}

/**
 * Takes a decline back: the invitation is pending again and the reason gone.
 * 409 once the invitation has expired, was revoked or replaced, or when it is
 * not declined at all.
 */
export async function withdrawMyInvitationDecline(
  actor: AuthenticatedActor, invitationId: string, deps: MyInvitationDependencies,
): Promise<MyInvitationView> {
  const invitee = await inviteeOf(actor.userId, deps);
  const now = deps.clock.now();
  return deps.transactions.runForInviteeInbox(
    { userId: actor.userId, verifiedEmail: invitee.verifiedEmail }, async ruow => {
      const record = await mine(ruow, invitationId);
      const reopenable = record.declinedAt !== null && record.acceptedAt === null
        && record.revokedAt === null && record.supersededAt === null && record.expiresAt > now;
      if (!reopenable) {
        throw new InvitationStateConflictError(
          "This invitation can no longer be reopened — it has expired or was withdrawn by the workspace.");
      }
      return ruow.enterWorkspace(record.workspaceId, async ws => {
        let applied: boolean;
        try {
          applied = await ws.invitations.withdrawDeclineIfDeclined({ invitationId: record.invitationId, now });
        } catch (error) {
          // A newer invitation for this address now holds the one live slot.
          if (error instanceof ApplicationError && error.category === "conflict") {
            throw new InvitationStateConflictError(
              "This workspace has sent you a newer invitation. Answer that one instead.");
          }
          throw error;
        }
        if (!applied) {
          throw new InvitationStateConflictError(
            "This invitation can no longer be reopened — it has expired or was withdrawn by the workspace.");
        }
        await recordActivity(ws, {
          action: "invitation.decline_withdrawn", actorUserId: actor.userId, occurredAt: now,
          actorName: bounded(invitee.displayName, record.inviteeEmail),
          details: { email: record.inviteeEmail },
        });
        return present(ws, { ...record, declinedAt: null, declineReason: null }, "pending");
      });
    });
}
