// 078 — joining a workspace by a single-use join link, always approved.
//
// ── The rules this schema holds ──────────────────────────────────────────
//
//   * A join TICKET is one link for one person. It is Draft (no live link),
//     Sent (a live link, whose digest is stored) or Withdrawn (the link is dead,
//     the ticket kept on record and able to be sent again with a NEW link).
//   * The first request submitted through a sent link USES it (`used_at`);
//     nobody else can use that link. There is no time-based expiry.
//   * Nobody joins directly. Every join — through a ticket or an emailed
//     invitation — is a pending REQUEST an owner or administrator approves
//     or declines.
//   * A membership can carry a typed role title and the two privileges an
//     owner or administrator grants: request documents from others, and
//     assign people for document signing.
//
// ── How a non-member reaches a ticket ────────────────────────────────────
//
// Exactly as 014 lets a non-member resolve an invitation: a dedicated setting,
// `lagda.join_ticket_digest`, and a FOR SELECT policy matching the one row
// whose UNIQUE digest equals it. Holding the setting is holding the link. The
// write that follows (the request, the ticket's `used_at`) happens only after
// the transaction enters the RESOLVED workspace's tenant context.

import { type Kysely, sql } from "kysely";

const DIGEST_SETTING = "lagda.join_ticket_digest";
const ROLES = [
  "owner", "member", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE",
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE, "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED", "WORKSPACE_JOIN_DECIDED",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST"] as const;
const AUDIENCES_BEFORE = ["USER", "SIGNING_REQUEST_RECIPIENT", "WORKSPACE_INVITEE"] as const;
const AUDIENCES_AFTER = [...AUDIENCES_BEFORE, "WORKSPACE_JOIN_TICKET"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setVocabularies(
  db: Kysely<unknown>,
  types: readonly string[], sources: readonly string[], audiences: readonly string[],
  withTicketAudience: boolean,
): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check,
      drop constraint if exists notification_intents_source_kind_check,
      drop constraint if exists notification_intents_audience_kind_check,
      drop constraint if exists notification_intents_audience_match
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(types)})),
      add constraint notification_intents_source_kind_check
        check (source_kind in (${inList(sources)})),
      add constraint notification_intents_audience_kind_check
        check (audience_kind in (${inList(audiences)}))
  `.execute(db);
  if (withTicketAudience) {
    await sql`
      alter table notification_intents add constraint notification_intents_audience_match check (
        (audience_kind = 'USER' and audience_user_id is not null
          and audience_recipient_id is null and audience_invitation_id is null
          and audience_join_ticket_id is null)
        or (audience_kind = 'SIGNING_REQUEST_RECIPIENT' and audience_recipient_id is not null
          and audience_user_id is null and audience_invitation_id is null
          and audience_join_ticket_id is null)
        or (audience_kind = 'WORKSPACE_INVITEE' and audience_invitation_id is not null
          and audience_user_id is null and audience_recipient_id is null
          and audience_join_ticket_id is null)
        or (audience_kind = 'WORKSPACE_JOIN_TICKET' and audience_join_ticket_id is not null
          and audience_user_id is null and audience_recipient_id is null
          and audience_invitation_id is null)
      )
    `.execute(db);
  } else {
    await sql`
      alter table notification_intents add constraint notification_intents_audience_match check (
        (audience_kind = 'USER' and audience_user_id is not null
          and audience_recipient_id is null and audience_invitation_id is null)
        or (audience_kind = 'SIGNING_REQUEST_RECIPIENT' and audience_recipient_id is not null
          and audience_user_id is null and audience_invitation_id is null)
        or (audience_kind = 'WORKSPACE_INVITEE' and audience_invitation_id is not null
          and audience_user_id is null and audience_recipient_id is null)
      )
    `.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Membership access ────────────────────────────────────────────────────
  await sql`
    alter table workspace_memberships
      add column role_title varchar(120),
      add column can_request_documents boolean not null default false,
      add column can_assign_signers boolean not null default false,
      add constraint workspace_memberships_role_title_check
        check (role_title is null or length(btrim(role_title)) > 0)
  `.execute(db);

  // ── Tickets ──────────────────────────────────────────────────────────────
  await sql`
    create table workspace_join_tickets (
      ticket_id                  varchar(64)  primary key,
      workspace_id               varchar(64)  not null references workspaces (workspace_id),
      label                      varchar(120) not null,
      recipient_email            varchar(320),
      state                      varchar(16)  not null,
      token_digest               varchar(64)  unique,
      sealed_token               text,
      sealed_key_version         varchar(32),
      -- Snapshotted when sent, so the join page can say where and from whom
      -- without reading the workspace or the sender's account.
      workspace_name             varchar(200),
      sent_by_name               varchar(200),
      sent_by_user_id            varchar(64)  references users (user_id),
      sent_at                    timestamptz,
      withdrawn_at               timestamptz,
      used_at                    timestamptz,
      used_by_user_id            varchar(64)  references users (user_id),
      created_by_user_id         varchar(64)  not null references users (user_id),
      created_at                 timestamptz  not null,
      updated_at                 timestamptz  not null,

      constraint workspace_join_tickets_workspace_ticket unique (workspace_id, ticket_id),
      constraint workspace_join_tickets_state_check
        check (state in ('draft', 'sent', 'withdrawn')),
      constraint workspace_join_tickets_label_check check (length(btrim(label)) > 0),
      constraint workspace_join_tickets_digest_shape
        check (token_digest is null or token_digest ~ '^[a-f0-9]{64}$'),
      -- A live link exists exactly while the ticket is Sent.
      constraint workspace_join_tickets_live_link check (
        (state = 'sent') = (token_digest is not null)
        and (token_digest is null) = (sealed_token is null)
        and (sealed_token is null) = (sealed_key_version is null)
      ),
      constraint workspace_join_tickets_sent_check
        check (state <> 'sent' or sent_at is not null),
      constraint workspace_join_tickets_withdrawn_check
        check ((state = 'withdrawn') = (withdrawn_at is not null)),
      constraint workspace_join_tickets_used_pair
        check ((used_at is null) = (used_by_user_id is null))
    )
  `.execute(db);

  // ── Requests ─────────────────────────────────────────────────────────────
  await sql`
    create table workspace_join_requests (
      request_id           varchar(64)  primary key,
      workspace_id         varchar(64)  not null references workspaces (workspace_id),
      source_kind          varchar(16)  not null,
      ticket_id            varchar(64),
      invitation_id        varchar(64)  references workspace_invitations (invitation_id),
      user_id              varchar(64)  not null references users (user_id),
      full_name            varchar(200) not null,
      email                varchar(320) not null,
      reason               varchar(500),
      requested_role       varchar(32)  not null,
      state                varchar(16)  not null,
      decided_by_user_id   varchar(64)  references users (user_id),
      decided_at           timestamptz,
      created_at           timestamptz  not null,

      constraint workspace_join_requests_ticket_fk
        foreign key (workspace_id, ticket_id)
        references workspace_join_tickets (workspace_id, ticket_id),
      constraint workspace_join_requests_source_check check (
        (source_kind = 'ticket' and ticket_id is not null and invitation_id is null)
        or (source_kind = 'invitation' and invitation_id is not null and ticket_id is null)
      ),
      constraint workspace_join_requests_state_check
        check (state in ('pending', 'approved', 'declined')),
      constraint workspace_join_requests_decided_check check (
        (state = 'pending') = (decided_at is null)
        and (decided_at is null) = (decided_by_user_id is null)
      ),
      constraint workspace_join_requests_role_check
        check (requested_role in (${inList(ROLES)}) and requested_role <> 'owner'),
      constraint workspace_join_requests_name_check check (length(btrim(full_name)) > 1)
    )
  `.execute(db);
  // One open request per person per workspace.
  await sql`
    create unique index workspace_join_requests_one_pending
      on workspace_join_requests (workspace_id, user_id) where state = 'pending'
  `.execute(db);
  await sql`
    create index workspace_join_requests_by_state
      on workspace_join_requests (workspace_id, state, created_at desc)
  `.execute(db);

  // ── Tenancy and the ticket credential realm ──────────────────────────────
  for (const table of ["workspace_join_tickets", "workspace_join_requests"]) {
    await sql`grant select, insert, update on table ${sql.table(table)} to lagda_app`.execute(db);
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.table(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }
  await sql`
    create or replace function lagda_current_join_ticket_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(DIGEST_SETTING)}, true), '') $$
  `.execute(db);
  await sql`grant execute on function lagda_current_join_ticket_digest() to lagda_app`.execute(db);
  await sql`
    create policy join_ticket_credential_read on workspace_join_tickets
    for select
    using (token_digest = lagda_current_join_ticket_digest())
  `.execute(db);

  // ── Notifications ────────────────────────────────────────────────────────
  await sql`alter table notification_intents add column audience_join_ticket_id varchar(64)`.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_audience_join_ticket_fk
      foreign key (workspace_id, audience_join_ticket_id)
      references workspace_join_tickets (workspace_id, ticket_id)
  `.execute(db);
  await setVocabularies(db, TYPES_AFTER, SOURCES_AFTER, AUDIENCES_AFTER, true);
}

/** Fails, deliberately, while any 078 notification or join row exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_BEFORE, SOURCES_BEFORE, AUDIENCES_BEFORE, false);
  await sql`
    alter table notification_intents
      drop constraint notification_intents_audience_join_ticket_fk,
      drop column audience_join_ticket_id
  `.execute(db);
  await sql`drop table workspace_join_requests`.execute(db);
  await sql`drop table workspace_join_tickets`.execute(db);
  await sql`drop function if exists lagda_current_join_ticket_digest()`.execute(db);
  await sql`
    alter table workspace_memberships
      drop constraint workspace_memberships_role_title_check,
      drop column role_title,
      drop column can_request_documents,
      drop column can_assign_signers
  `.execute(db);
}
