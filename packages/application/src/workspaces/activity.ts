// 079. The workspace activity log.
//
// ── Written in the SAME transaction as the change ──────────────────────────
//
// `recordActivity` takes the unit of work the change itself is using, so the
// entry commits with the change or not at all. A log written afterwards could
// record a change that rolled back, or miss one that committed.
//
// ── The wording lives HERE, not in the row ─────────────────────────────────
//
// A row stores an action and the facts it needs, with names snapshotted when
// the change happened. The sentence is produced by `describe` when the log is
// read, so rewording it never rewrites history — the signing audit trail's rule.

import type { UserId, WorkspaceId } from "@lagda/contracts";
import { assertCapability, privilegesOf, type WorkspaceAccessContext } from "./workspace-access.js";
import { ResourceNotFoundError, ApplicationValidationError } from "../common/errors/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import {
  WORKSPACE_ACTIVITY_ACTIONS, WORKSPACE_ACTIVITY_ACTION_NAMES,
  type WorkspaceActivityAction, type WorkspaceActivityCategory, type WorkspaceActivityDetails,
  type WorkspaceActivityRecord, type WorkspaceActivityPosition,
} from "../common/ports/workspace-activity.js";

// ── Recording ────────────────────────────────────────────────────────────────

/** A member's name as the roster shows it, or null when they are not (or no longer) a member. */
export async function memberNameOf(uow: WorkspaceUnitOfWork, userId: UserId): Promise<string | null> {
  const members = await uow.memberships.listWithAccounts();
  return members.find(m => m.userId === userId)?.displayName ?? null;
}

export interface RecordActivityInput {
  readonly action: WorkspaceActivityAction;
  /** Who did it. Null only for the system itself; there is no such caller yet. */
  readonly actorUserId: UserId | null;
  /** The actor's name when the caller already has it (a requester who is not a member yet). */
  readonly actorName?: string | null;
  readonly occurredAt?: number;
  readonly details?: WorkspaceActivityDetails;
}

export async function recordActivity(uow: WorkspaceUnitOfWork, input: RecordActivityInput): Promise<void> {
  const actorName = input.actorName !== undefined
    ? input.actorName
    : input.actorUserId === null ? null : await memberNameOf(uow, input.actorUserId);
  await uow.activity.append({
    action: input.action,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt ?? Date.now(),
    details: { ...input.details, actorName },
  });
}

// ── Presenting ───────────────────────────────────────────────────────────────

const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  owner: "Owner",
  administrator: "Administrator",
  template_administrator: "Template administrator",
  sender: "Sender",
  reviewer: "Reviewer",
  auditor: "Auditor",
  member: "New Comer",
});

export function roleLabel(role: string | null | undefined): string {
  if (role === null || role === undefined) return "member";
  return ROLE_LABELS[role] ?? role;
}

function text(details: WorkspaceActivityDetails, key: string, fallback = ""): string {
  const value = details[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

function privilegeList(details: WorkspaceActivityDetails): string {
  const granted: string[] = [];
  if (details["canRequestDocuments"] === true) granted.push("request documents");
  if (details["canAssignSigners"] === true) granted.push("assign signers");
  return granted.length === 0 ? "no extra privileges" : granted.join(" and ");
}

/** The sentence and the subject a person reads for one entry. */
export function describeActivity(record: Pick<WorkspaceActivityRecord, "action" | "details">): {
  readonly summary: string;
  readonly subjectLabel: string | null;
} {
  const d = record.details;
  const who = text(d, "actorName", "Someone");
  const target = text(d, "targetName", text(d, "targetEmail", "a member"));
  const label = text(d, "label", "a join link");
  const team = text(d, "teamName", "a team");
  const q = (value: string) => `“${value}”`;

  switch (record.action) {
    case "workspace.created":
      return { summary: `${who} created the workspace ${q(text(d, "name"))}`, subjectLabel: text(d, "name") || null };
    case "workspace.renamed":
      return { summary: `${who} renamed the workspace from ${q(text(d, "from"))} to ${q(text(d, "to"))}`, subjectLabel: text(d, "to") || null };
    case "member.role_changed":
      return {
        summary: `${who} changed ${target}'s role from ${roleLabel(text(d, "fromRole"))} to ${roleLabel(text(d, "toRole"))}`,
        subjectLabel: target,
      };
    case "member.access_changed": {
      const title = text(d, "roleTitle");
      return {
        summary: `${who} updated ${target}'s access: ${title === "" ? "no role title" : `title ${q(title)}`}, ${privilegeList(d)}`,
        subjectLabel: target,
      };
    }
    case "member.removed":
      return { summary: `${who} removed ${target} (${roleLabel(text(d, "role"))}) from the workspace`, subjectLabel: target };
    case "invitation.sent":
      return { summary: `${who} invited ${target} as ${roleLabel(text(d, "role"))}`, subjectLabel: target };
    case "invitation.resent":
      return { summary: `${who} resent the invitation to ${target}`, subjectLabel: target };
    case "invitation.revoked":
      return { summary: `${who} revoked the invitation to ${target}`, subjectLabel: target };
    case "invitation.accepted":
      return { summary: `${who} accepted the invitation and is waiting for approval`, subjectLabel: who };
    case "invitation.declined":
      return { summary: `${who} declined the invitation`, subjectLabel: who };
    case "join_link.created":
      return { summary: `${who} created the join link ${q(label)}`, subjectLabel: label };
    case "join_link.sent": {
      const to = text(d, "emailedTo");
      return {
        summary: `${who} sent the join link ${q(label)}${d["again"] === true ? " again with a new link" : ""}${to === "" ? "" : ` by email to ${to}`}`,
        subjectLabel: label,
      };
    }
    case "join_link.withdrawn":
      return { summary: `${who} withdrew the join link ${q(label)}`, subjectLabel: label };
    case "join_request.submitted": {
      const via = text(d, "label");
      return {
        summary: `${who} (${text(d, "email")}) asked to join${via === "" ? " through an email invitation" : ` using the join link ${q(via)}`}`,
        subjectLabel: who,
      };
    }
    case "join_request.approved": {
      const title = text(d, "roleTitle");
      return {
        summary: `${who} approved ${target}'s join request as ${title === "" ? roleLabel(text(d, "role")) : title}, with ${privilegeList(d)}`,
        subjectLabel: target,
      };
    }
    case "join_request.declined":
      return { summary: `${who} declined ${target}'s join request`, subjectLabel: target };
    case "team.created":
      return { summary: `${who} created the team ${q(team)}`, subjectLabel: team };
    case "team.renamed":
      return { summary: `${who} renamed the team ${q(text(d, "from"))} to ${q(team)}`, subjectLabel: team };
    case "team.archived":
      return { summary: `${who} archived the team ${q(team)}`, subjectLabel: team };
    case "team.member_added":
      return { summary: `${who} added ${target} to ${q(team)}`, subjectLabel: target };
    case "team.member_updated": {
      const title = text(d, "title");
      return {
        summary: title === ""
          ? `${who} cleared ${target}'s title in ${q(team)}`
          : `${who} set ${target}'s title in ${q(team)} to ${q(title)}`,
        subjectLabel: target,
      };
    }
    case "team.member_removed":
      return { summary: `${who} removed ${target} from ${q(team)}`, subjectLabel: target };
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

export const ACTIVITY_PAGE_MAX = 100;
export const ACTIVITY_PAGE_DEFAULT = 50;

export class ActivityCursorInvalidError extends ApplicationValidationError {
  constructor() {
    super("This page of the activity log is no longer available. Reload it.", ["cursor"]);
  }
}

export interface WorkspaceActivityView {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly category: WorkspaceActivityCategory;
  readonly action: WorkspaceActivityAction;
  readonly actorName: string | null;
  readonly summary: string;
  readonly subjectLabel: string | null;
}

export interface WorkspaceActivityPage {
  readonly events: readonly WorkspaceActivityView[];
  readonly nextCursor: string | null;
}

export function encodeActivityCursor(position: WorkspaceActivityPosition): string {
  return Buffer.from(`${String(position.occurredAt)}.${position.eventId}`, "utf8").toString("base64url");
}

export function decodeActivityCursor(cursor: string): WorkspaceActivityPosition {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/u.exec(decoded);
  if (match === null) throw new ActivityCursorInvalidError();
  return { occurredAt: Number(match[1]), eventId: match[2] ?? "" };
}

export async function listWorkspaceActivity(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  input: { readonly limit?: number; readonly cursor?: string | null; readonly category?: WorkspaceActivityCategory | null },
  deps: { readonly transactions: TransactionManager },
): Promise<WorkspaceActivityPage> {
  const limit = Math.min(Math.max(input.limit ?? ACTIVITY_PAGE_DEFAULT, 1), ACTIVITY_PAGE_MAX);
  const before = input.cursor === undefined || input.cursor === null ? null : decodeActivityCursor(input.cursor);
  const actions = input.category === undefined || input.category === null
    ? null
    : WORKSPACE_ACTIVITY_ACTION_NAMES.filter(a => WORKSPACE_ACTIVITY_ACTIONS[a] === input.category);

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(actor.userId);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const access: WorkspaceAccessContext = {
      workspaceId: membership.workspaceId, userId: membership.userId,
      membershipId: membership.memberId, role: membership.role, privileges: privilegesOf(membership),
    };
    assertCapability(access, "activity.view");

    // One extra row says whether there is a next page without a count query.
    const rows = await uow.activity.list({ limit: limit + 1, before, actions });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map(row => ({
        eventId: row.eventId,
        occurredAt: row.occurredAt,
        category: WORKSPACE_ACTIVITY_ACTIONS[row.action],
        action: row.action,
        actorName: typeof row.details["actorName"] === "string" ? row.details["actorName"] : null,
        ...describeActivity(row),
      })),
      nextCursor: rows.length > limit && last !== undefined
        ? encodeActivityCursor({ occurredAt: last.occurredAt, eventId: last.eventId })
        : null,
    };
  });
}
