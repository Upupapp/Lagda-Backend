// 094. Teams are deleted, not archived.
//
// 039 kept every unit forever, archiving instead of deleting, against links
// from documents, workflows and audit records that were never built: nothing
// references a unit except its own members (cascade) and its sub-units
// (restrict). The product now deletes a team outright — but only an EMPTY
// one: no members and no sub-teams, checked in the same statement that deletes
// it (repositories/organization.ts), so a person added at the same moment is
// never removed with it. Renaming is unchanged.
//
// The activity log keeps the team's name inside each entry, so history still
// reads "Ana added Jose to Finance" after Finance is gone; deleting adds one
// entry of its own, `team.deleted`.
//
// ── The one-time clean-up ──────────────────────────────────────────────────
//
// Every unit archived before this release is deleted, with its old
// memberships (the people stay in their workspaces). Leaf first, because a
// sub-unit restricts its parent's deletion. Row security is relaxed for the
// owner for the length of this transaction only and forced again before it
// ends; the clean-up crosses workspaces, which no tenant session may.

import { type Kysely, sql } from "kysely";

const ACTIONS_BEFORE = [
  "workspace.created", "workspace.renamed",
  "member.role_changed", "member.access_changed", "member.removed",
  "invitation.sent", "invitation.resent", "invitation.revoked",
  "invitation.accepted", "invitation.declined",
  "join_link.created", "join_link.sent", "join_link.withdrawn",
  "join_request.submitted", "join_request.approved", "join_request.declined",
  "team.created", "team.renamed", "team.archived",
  "team.member_added", "team.member_updated", "team.member_removed",
  "workspace.branding_changed",
  "document_share.created", "document_share.updated", "document_share.removed",
  "document_share.accepted", "document_share.rejected", "document_share.rejection_withdrawn",
  "document_share.deleted", "document_share.access_removed",
  "access_request.submitted", "access_request.approved", "access_request.rejected",
  "access_request.rejection_withdrawn", "access_request.deleted", "access_request.access_removed",
  "invitation.decline_withdrawn",
] as const;
const ACTIONS_AFTER = [...ACTIONS_BEFORE, "team.deleted"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setActions(db: Kysely<unknown>, actions: readonly string[]): Promise<void> {
  await sql`
    alter table workspace_activity_events
      drop constraint workspace_activity_events_action_check,
      add constraint workspace_activity_events_action_check
        check (action in (${inList(actions)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setActions(db, ACTIONS_AFTER);

  await sql`alter table organization_unit_members no force row level security`.execute(db);
  await sql`alter table organization_units no force row level security`.execute(db);
  await sql`
    do $$
    declare removed integer;
    begin
      loop
        delete from organization_units u
         where u.archived_at is not null
           and not exists (
             select 1 from organization_units c
              where c.workspace_id = u.workspace_id and c.parent_unit_id = u.unit_id);
        get diagnostics removed = row_count;
        exit when removed = 0;
      end loop;
    end
    $$
  `.execute(db);
  await sql`alter table organization_units force row level security`.execute(db);
  await sql`alter table organization_unit_members force row level security`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Deleted teams cannot come back; only the vocabulary is restored. An entry
  // already written as team.deleted keeps the constraint from narrowing, so
  // those entries are recorded as the archive they replaced.
  await sql`alter table workspace_activity_events no force row level security`.execute(db);
  await sql`update workspace_activity_events set action = 'team.archived' where action = 'team.deleted'`.execute(db);
  await sql`alter table workspace_activity_events force row level security`.execute(db);
  await setActions(db, ACTIONS_BEFORE);
}
