// 079. The workspace activity log.
//
// What an owner or administrator did to the workspace itself: members,
// invitations, join links and requests, teams, the name. Written by the use
// case in the SAME transaction as the change, so an entry exists exactly when
// the change committed.
//
// APPEND-ONLY. The runtime role gets SELECT and INSERT and nothing else — no
// UPDATE, no DELETE — so history cannot be edited from the application.
//
// `actor_user_id` deliberately has NO foreign key: the record of who did
// something must outlive that person's account. The name is snapshotted in
// `details` for the same reason. The sentence a person reads is composed at
// read time from `action` + `details`; the row stores no English.

import { type Kysely, sql } from "kysely";

const ACTIONS = [
  "workspace.created", "workspace.renamed",
  "member.role_changed", "member.access_changed", "member.removed",
  "invitation.sent", "invitation.resent", "invitation.revoked",
  "invitation.accepted", "invitation.declined",
  "join_link.created", "join_link.sent", "join_link.withdrawn",
  "join_request.submitted", "join_request.approved", "join_request.declined",
  "team.created", "team.renamed", "team.archived",
  "team.member_added", "team.member_updated", "team.member_removed",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workspace_activity_events (
      event_id       varchar(64)  primary key,
      workspace_id   varchar(64)  not null references workspaces (workspace_id),
      action         varchar(48)  not null,
      actor_user_id  varchar(64),
      occurred_at    timestamptz  not null,
      details        jsonb        not null default '{}'::jsonb,
      recorded_at    timestamptz  not null default now(),
      constraint workspace_activity_events_action_check check (action in (${inList(ACTIONS)})),
      constraint workspace_activity_events_details_check check (jsonb_typeof(details) = 'object')
    )
  `.execute(db);
  // Newest first within a workspace, with the id as the tie-breaker the
  // cursor relies on.
  await sql`
    create index workspace_activity_events_timeline
      on workspace_activity_events (workspace_id, occurred_at desc, event_id desc)
  `.execute(db);

  await sql`grant select, insert on table workspace_activity_events to lagda_app`.execute(db);
  await sql`alter table workspace_activity_events enable row level security`.execute(db);
  await sql`alter table workspace_activity_events force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workspace_activity_events
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table workspace_activity_events`.execute(db);
}
