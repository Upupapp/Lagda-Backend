// 082. Workspace branding: the sender name, footer tagline, brand colour and
// logo a workspace shows. One row per workspace, created on first save.
//
// The display name is NOT here — it is `workspaces.name`, so branding and a
// rename can never disagree.
//
// The logo is a PNG the BROWSER produced (it scales the chosen PNG or JPEG
// down before upload), validated from its bytes the way 072's profile photos
// are. Stored inline: bounded to 512 KB, one per workspace.
//
// Grants: SELECT, INSERT, UPDATE. Reset and "remove logo" are updates; no path
// deletes a row. DELETE and TRUNCATE are revoked EXPLICITLY, because a
// deployment that migrates as `lagda_app` makes it the owner (080's lesson).
//
// Also widens 079's activity vocabulary by `workspace.branding_changed`.

import { type Kysely, sql } from "kysely";

const MAX_LOGO_BYTES = 512 * 1024;
const MAX_LOGO_DIMENSION = 1024;

const ACTIONS_BEFORE = [
  "workspace.created", "workspace.renamed",
  "member.role_changed", "member.access_changed", "member.removed",
  "invitation.sent", "invitation.resent", "invitation.revoked",
  "invitation.accepted", "invitation.declined",
  "join_link.created", "join_link.sent", "join_link.withdrawn",
  "join_request.submitted", "join_request.approved", "join_request.declined",
  "team.created", "team.renamed", "team.archived",
  "team.member_added", "team.member_updated", "team.member_removed",
] as const;
const ACTIONS_AFTER = [...ACTIONS_BEFORE, "workspace.branding_changed"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setActions(db: Kysely<unknown>, actions: readonly string[]): Promise<void> {
  await sql`
    alter table workspace_activity_events
      drop constraint workspace_activity_events_action_check,
      add constraint workspace_activity_events_action_check check (action in (${inList(actions)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workspace_branding (
      workspace_id          varchar(64)  primary key references workspaces (workspace_id),
      sender_display_name   varchar(120),
      footer_tagline        varchar(160),
      primary_color         char(7),
      logo_media_type       varchar(32),
      logo_bytes            bytea,
      logo_width            integer,
      logo_height           integer,
      logo_digest           varchar(64),
      logo_updated_at       timestamptz,
      updated_at            timestamptz  not null,

      constraint workspace_branding_color_check
        check (primary_color is null or primary_color ~ '^#[0-9A-F]{6}$'),
      constraint workspace_branding_text_check check (
        (sender_display_name is null or length(btrim(sender_display_name)) > 0)
        and (footer_tagline is null or length(btrim(footer_tagline)) > 0)
      ),
      -- The logo columns move together: all present or all absent.
      constraint workspace_branding_logo_together check (
        (logo_bytes is null) = (logo_media_type is null)
        and (logo_bytes is null) = (logo_width is null)
        and (logo_bytes is null) = (logo_height is null)
        and (logo_bytes is null) = (logo_digest is null)
        and (logo_bytes is null) = (logo_updated_at is null)
      ),
      constraint workspace_branding_logo_check check (
        logo_bytes is null or (
          logo_media_type = 'image/png'
          and octet_length(logo_bytes) between 1 and ${sql.lit(MAX_LOGO_BYTES)}
          and logo_width between 1 and ${sql.lit(MAX_LOGO_DIMENSION)}
          and logo_height between 1 and ${sql.lit(MAX_LOGO_DIMENSION)}
          and logo_digest ~ '^[a-f0-9]{64}$'
        )
      )
    )
  `.execute(db);

  await sql`grant select, insert, update on table workspace_branding to lagda_app`.execute(db);
  await sql`revoke delete, truncate on table workspace_branding from lagda_app`.execute(db);
  await sql`alter table workspace_branding enable row level security`.execute(db);
  await sql`alter table workspace_branding force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workspace_branding
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  await setActions(db, ACTIONS_AFTER);
}

/** Fails, deliberately, while any branding activity entry exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setActions(db, ACTIONS_BEFORE);
  await sql`drop table workspace_branding`.execute(db);
}
