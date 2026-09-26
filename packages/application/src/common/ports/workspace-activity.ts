// 079. The workspace activity log: what an owner or administrator did to the
// workspace itself — members, invitations, join links, teams, the name.
//
// Append-only. A row stores a machine ACTION and the facts it needs (names
// snapshotted at the time, so a later rename does not rewrite history); the
// sentence a person reads is produced at read time by the presenter in
// workspaces/activity.ts — the same rule the signing audit trail follows.
//
// Document and signing history is NOT here; it lives in evidence_events.

import type { UserId, WorkspaceId } from "@lagda/contracts";

export const WORKSPACE_ACTIVITY_CATEGORIES = ["people", "access", "links", "teams", "workspace"] as const;
export type WorkspaceActivityCategory = (typeof WORKSPACE_ACTIVITY_CATEGORIES)[number];

/** Every action, and the one category it files under. Total, so a new action must choose. */
export const WORKSPACE_ACTIVITY_ACTIONS = Object.freeze({
  "workspace.created": "workspace",
  "workspace.renamed": "workspace",
  "workspace.branding_changed": "workspace",
  "member.role_changed": "access",
  "member.access_changed": "access",
  "member.removed": "people",
  "invitation.sent": "people",
  "invitation.resent": "people",
  "invitation.revoked": "people",
  "invitation.accepted": "people",
  "invitation.declined": "people",
  "join_link.created": "links",
  "join_link.sent": "links",
  "join_link.withdrawn": "links",
  "join_request.submitted": "people",
  "join_request.approved": "people",
  "join_request.declined": "people",
  "team.created": "teams",
  "team.renamed": "teams",
  "team.archived": "teams",
  "team.member_added": "teams",
  "team.member_updated": "teams",
  "team.member_removed": "teams",
} as const satisfies Record<string, WorkspaceActivityCategory>);

export type WorkspaceActivityAction = keyof typeof WORKSPACE_ACTIVITY_ACTIONS;
export const WORKSPACE_ACTIVITY_ACTION_NAMES = Object.keys(WORKSPACE_ACTIVITY_ACTIONS) as WorkspaceActivityAction[];

/** Flat facts only: names, roles, labels. Never a token, digest or secret. */
export type WorkspaceActivityDetails = Readonly<Record<string, string | boolean | null>>;

export interface NewWorkspaceActivity {
  readonly action: WorkspaceActivityAction;
  readonly actorUserId: UserId | null;
  readonly occurredAt: number;
  readonly details: WorkspaceActivityDetails;
}

export interface WorkspaceActivityRecord extends NewWorkspaceActivity {
  readonly eventId: string;
  readonly workspaceId: WorkspaceId;
}

export interface WorkspaceActivityPosition {
  readonly occurredAt: number;
  readonly eventId: string;
}

export interface ScopedWorkspaceActivityRepository {
  /** The repository assigns the id; the row can never be updated or deleted. */
  append(entry: NewWorkspaceActivity): Promise<void>;
  /** Newest first, strictly older than `before` when given. */
  list(input: {
    readonly limit: number;
    readonly before: WorkspaceActivityPosition | null;
    readonly actions: readonly WorkspaceActivityAction[] | null;
  }): Promise<readonly WorkspaceActivityRecord[]>;
}
