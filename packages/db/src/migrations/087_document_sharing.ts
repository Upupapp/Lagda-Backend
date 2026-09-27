// 087 — sharing a completed document, and asking its owner for access.
//
// ── Two tables ────────────────────────────────────────────────────────────
//
//   document_shares            the owner (the member who sent the signing
//       request) or a workspace owner/administrator shares a COMPLETED
//       document with an email address. pending | accepted | rejected |
//       removed. Nothing is emailed: the share waits for an account whose
//       VERIFIED address matches `normalized_email`, and appears in that
//       account's "Shared with me" the moment one exists.
//   document_access_requests   a signed-in account asks the owner for access
//       to a completed document it holds the verification ID of.
//       pending | approved | rejected | removed.
//
// Both are workspace-owned (the DOCUMENT's workspace) and FORCE
// `tenant_isolation`, like every tenant table. `document_id`,
// `signing_request_id` and `verification_id` are snapshots validated by the
// application; there is no foreign key to `verification_records` (append-only
// evidence — an RI row lock on it fails in production, see 065) nor to
// `documents` / `signing_requests` (067's reason).
//
// ── How a recipient reaches rows in someone else's workspace ─────────────
//
// A recipient is usually NOT a member of the document's workspace, so tenant
// context cannot find their rows. Two narrow FOR SELECT realms, shaped exactly
// like 078's join-ticket realm and 083's grant realm — each its own setting,
// never the absence of the workspace one (075's lesson):
//
//   lagda.document_share_recipient   a DIGEST of the account's VERIFIED,
//       normalized email (domain-separated SHA-256, computed in SQL by the
//       repository). Matches `document_shares.recipient_email_digest`.
//   lagda.document_access_requester  the account's own user id. Matches
//       `document_access_requests.requester_user_id`.
//
// Only the recipient repository sets them, from the SESSION's account — never
// from a request body. Any write (accept, reject, remove...) happens only
// after the transaction enters the RESOLVED row's workspace, where
// `tenant_isolation`'s WITH CHECK governs it.
//
// ── One live row per person per document ──────────────────────────────────
//
// Partial unique indexes: one share per (document, address) that is pending,
// accepted, or rejected and not yet deleted by its recipient; one request per
// (document, account) that is pending, approved, or rejected and not yet
// deleted by the owner. The application checks first and answers 409; the
// index is the backstop against a race.
//
// ── "Delete" is a flag, never a DELETE ────────────────────────────────────
//
// A recipient deleting a rejected share sets `recipient_deleted_at`; an owner
// deleting a rejected request sets `deleted_at`. The row stays, so the other
// party's history and the activity log never point at nothing. So `lagda_app`
// gets no DELETE here at all — revoked EXPLICITLY, because a deployment that
// migrates as `lagda_app` makes it the owner (080's lesson).
//
// ── 083's access codes and grants reach the new access list ──────────────
//
// A Verify Document code or grant used to name exactly one PARTICIPANT row.
// It may now name an accepted share or an approved request instead, and a
// signed-in grant may rest on workspace membership alone (the document's
// owner, or a workspace owner/administrator). `access_basis` says which; a
// CHECK keeps the reference columns consistent with it.
//
// ── The account's own feed reads across workspaces ───────────────────────
//
// `/me/notifications` reads USER-audience intents by `audience_user_id`. A
// notice about a workspace's document is WORKSPACE-scoped (`user_id` null), so
// 030's `tenant_isolation` shows it only inside that workspace — and the feed
// ran with no context at all, so as the runtime role it saw nothing (found by
// this migration's integration suite; 086's in-app notices were equally
// invisible). A sharing recipient is usually not a member of the document's
// workspace, so the feed needs the realm 013 already defines for "my own
// rows": `lagda.user_id`. One FOR SELECT policy, matching only intents whose
// audience IS that account.
//
// ── Notifications and activity ────────────────────────────────────────────
//
// Six in-app-only USER notices (share received / accepted / rejected, access
// requested / approved / rejected — suppressed as 086's IN_APP_ONLY) and one
// emailed code for a non-participant on the access list
// (SHARED_DOCUMENT_ACCESS_CODE). The 079 action vocabulary widens by the
// sharing actions.

import { type Kysely, sql } from "kysely";

const SHARE_RECIPIENT_SETTING = "lagda.document_share_recipient";
const ACCESS_REQUESTER_SETTING = "lagda.document_access_requester";

const SHARE_STATUSES = ["pending", "accepted", "rejected", "removed"] as const;
const REQUEST_STATUSES = ["pending", "approved", "rejected", "removed"] as const;
const SHARE_REMOVED_BY = ["owner", "recipient", "email-changed"] as const;
const GRANT_BASES = [
  "participant", "share", "access-request", "document-owner", "workspace-administrator",
] as const;

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED", "VERIFICATION_ACCESS_CODE",
  "CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
  "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED",
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE,
  "DOCUMENT_SHARE_RECEIVED", "DOCUMENT_SHARE_ACCEPTED", "DOCUMENT_SHARE_REJECTED",
  "DOCUMENT_ACCESS_REQUESTED", "DOCUMENT_ACCESS_APPROVED", "DOCUMENT_ACCESS_REJECTED",
  "SHARED_DOCUMENT_ACCESS_CODE",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST"] as const;

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
] as const;
const ACTIONS_AFTER = [
  ...ACTIONS_BEFORE,
  "document_share.created", "document_share.updated", "document_share.removed",
  "document_share.accepted", "document_share.rejected", "document_share.rejection_withdrawn",
  "document_share.deleted", "document_share.access_removed",
  "access_request.submitted", "access_request.approved", "access_request.rejected",
  "access_request.rejection_withdrawn", "access_request.deleted", "access_request.access_removed",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setVocabularies(db: Kysely<unknown>, after: boolean): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check,
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(after ? TYPES_AFTER : TYPES_BEFORE)})),
      add constraint notification_intents_source_kind_check
        check (source_kind in (${inList(after ? SOURCES_AFTER : SOURCES_BEFORE)}))
  `.execute(db);
  await sql`
    alter table workspace_activity_events
      drop constraint workspace_activity_events_action_check,
      add constraint workspace_activity_events_action_check
        check (action in (${inList(after ? ACTIONS_AFTER : ACTIONS_BEFORE)}))
  `.execute(db);
}

async function protect(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`grant select, insert, update on table ${sql.table(table)} to lagda_app`.execute(db);
  // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
  await sql`revoke delete, truncate on table ${sql.table(table)} from lagda_app`.execute(db);
  await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
  await sql`alter table ${sql.table(table)} force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on ${sql.table(table)}
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Shares ────────────────────────────────────────────────────────────────
  await sql`
    create table document_shares (
      share_id                varchar(64)   primary key,
      workspace_id            varchar(64)   not null references workspaces (workspace_id),
      document_id             varchar(64)   not null,
      signing_request_id      varchar(64)   not null,
      verification_id         varchar(64)   not null,
      email                   varchar(320)  not null,
      normalized_email        varchar(320)  not null,
      recipient_email_digest  varchar(64)   not null,
      full_name               varchar(200),
      status                  varchar(16)   not null,
      shared_by_user_id       varchar(64)   not null references users (user_id),
      -- The account that answered (accepted or rejected), once one has.
      recipient_user_id       varchar(64)   references users (user_id),
      -- An email edit ends the old share and starts this one.
      replaces_share_id       varchar(64),
      removed_by              varchar(16),
      removed_by_user_id      varchar(64)   references users (user_id),
      created_at              timestamptz   not null,
      updated_at              timestamptz   not null,
      responded_at            timestamptz,
      removed_at              timestamptz,
      recipient_deleted_at    timestamptz,

      constraint document_shares_workspace_share unique (workspace_id, share_id),
      constraint document_shares_status_check check (status in (${inList(SHARE_STATUSES)})),
      constraint document_shares_email_not_blank check (length(btrim(email)) > 0),
      constraint document_shares_normalized_check check (normalized_email = lower(normalized_email)),
      constraint document_shares_digest_shape check (recipient_email_digest ~ '^[a-f0-9]{64}$'),
      constraint document_shares_name_not_blank
        check (full_name is null or length(btrim(full_name)) > 0),
      constraint document_shares_updated_after_created check (updated_at >= created_at),
      -- Answered exactly when it was accepted or rejected (a removal keeps the
      -- answer it had, so it is not constrained either way).
      constraint document_shares_answered_shape check (
        status not in ('accepted', 'rejected')
        or (responded_at is not null and recipient_user_id is not null)
      ),
      constraint document_shares_pending_unanswered check (
        status <> 'pending' or (responded_at is null and recipient_user_id is null)
      ),
      constraint document_shares_removed_shape check (
        (status = 'removed') = (removed_at is not null)
        and (removed_at is null) = (removed_by is null)
        and (removed_by is null or removed_by in (${inList(SHARE_REMOVED_BY)}))
      ),
      -- Only a rejected share can be deleted by its recipient.
      constraint document_shares_deleted_only_rejected
        check (recipient_deleted_at is null or status = 'rejected')
    )
  `.execute(db);
  await sql`
    create unique index document_shares_one_live
      on document_shares (workspace_id, verification_id, normalized_email)
      where status in ('pending', 'accepted')
         or (status = 'rejected' and recipient_deleted_at is null)
  `.execute(db);
  await sql`
    create index document_shares_by_document
      on document_shares (workspace_id, document_id, created_at desc)
  `.execute(db);
  await sql`
    create index document_shares_by_recipient
      on document_shares (recipient_email_digest, status)
  `.execute(db);

  // ── Access requests ───────────────────────────────────────────────────────
  await sql`
    create table document_access_requests (
      request_id              varchar(64)   primary key,
      workspace_id            varchar(64)   not null references workspaces (workspace_id),
      document_id             varchar(64)   not null,
      signing_request_id      varchar(64)   not null,
      verification_id         varchar(64)   not null,
      requester_user_id       varchar(64)   not null references users (user_id),
      -- The VERIFIED address at request time, normalized: what the public
      -- code flow matches once the request is approved.
      requester_email         varchar(320)  not null,
      requester_name          varchar(200)  not null,
      note                    varchar(500),
      status                  varchar(16)   not null,
      decided_by_user_id      varchar(64)   references users (user_id),
      decided_at              timestamptz,
      removed_by_user_id      varchar(64)   references users (user_id),
      removed_at              timestamptz,
      deleted_by_user_id      varchar(64)   references users (user_id),
      deleted_at              timestamptz,
      created_at              timestamptz   not null,
      updated_at              timestamptz   not null,

      constraint document_access_requests_workspace_request unique (workspace_id, request_id),
      constraint document_access_requests_status_check
        check (status in (${inList(REQUEST_STATUSES)})),
      constraint document_access_requests_email_check
        check (requester_email = lower(requester_email) and length(btrim(requester_email)) > 0),
      constraint document_access_requests_name_not_blank check (length(btrim(requester_name)) > 0),
      constraint document_access_requests_note_not_blank
        check (note is null or length(btrim(note)) > 0),
      constraint document_access_requests_updated_after_created check (updated_at >= created_at),
      constraint document_access_requests_decided_shape check (
        (decided_at is null) = (decided_by_user_id is null)
        and (status not in ('approved', 'rejected') or decided_at is not null)
        and (status <> 'pending' or decided_at is null)
      ),
      constraint document_access_requests_removed_shape check (
        (status = 'removed') = (removed_at is not null)
        and (removed_at is null) = (removed_by_user_id is null)
      ),
      constraint document_access_requests_deleted_shape check (
        (deleted_at is null) = (deleted_by_user_id is null)
        and (deleted_at is null or status = 'rejected')
      )
    )
  `.execute(db);
  await sql`
    create unique index document_access_requests_one_live
      on document_access_requests (workspace_id, verification_id, requester_user_id)
      where status in ('pending', 'approved')
         or (status = 'rejected' and deleted_at is null)
  `.execute(db);
  await sql`
    create index document_access_requests_by_state
      on document_access_requests (workspace_id, status, created_at desc)
  `.execute(db);
  await sql`
    create index document_access_requests_by_requester
      on document_access_requests (requester_user_id, status)
  `.execute(db);

  await protect(db, "document_shares");
  await protect(db, "document_access_requests");

  // ── The two recipient realms ──────────────────────────────────────────────
  await sql`
    create or replace function lagda_current_document_share_recipient() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(SHARE_RECIPIENT_SETTING)}, true), '') $$
  `.execute(db);
  await sql`
    create or replace function lagda_current_document_access_requester() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(ACCESS_REQUESTER_SETTING)}, true), '') $$
  `.execute(db);
  await sql`grant execute on function lagda_current_document_share_recipient() to lagda_app`.execute(db);
  await sql`grant execute on function lagda_current_document_access_requester() to lagda_app`.execute(db);
  await sql`
    create policy document_share_recipient_read on document_shares
    for select
    using (recipient_email_digest = lagda_current_document_share_recipient())
  `.execute(db);
  await sql`
    create policy document_access_requester_read on document_access_requests
    for select
    using (requester_user_id = lagda_current_document_access_requester())
  `.execute(db);

  // ── 083's codes and grants: the access list, not only participants ───────
  for (const table of ["verification_access_challenges", "verification_access_grants"]) {
    await sql`
      alter table ${sql.table(table)}
        alter column request_recipient_id drop not null,
        add column share_id varchar(64),
        add column access_request_id varchar(64),
        add constraint ${sql.raw(`${table}_share_fk`)}
          foreign key (workspace_id, share_id)
          references document_shares (workspace_id, share_id),
        add constraint ${sql.raw(`${table}_access_request_fk`)}
          foreign key (workspace_id, access_request_id)
          references document_access_requests (workspace_id, request_id)
    `.execute(db);
  }
  // A code is always for ONE entry on the access list.
  await sql`
    alter table verification_access_challenges
      add constraint verification_access_challenges_one_subject
        check (num_nonnulls(request_recipient_id, share_id, access_request_id) = 1)
  `.execute(db);
  await sql`
    alter table verification_access_grants
      add column access_basis varchar(24) not null default 'participant',
      add constraint verification_access_grants_basis_check check (
        access_basis in (${inList(GRANT_BASES)})
        and (access_basis = 'participant') = (request_recipient_id is not null)
        and (access_basis = 'share') = (share_id is not null)
        and (access_basis = 'access-request') = (access_request_id is not null)
        -- Membership-based access exists only signed in.
        and (access_basis not in ('document-owner', 'workspace-administrator') or origin = 'member')
      )
  `.execute(db);

  await sql`
    create policy notification_audience_user_read on notification_intents
    for select
    using (audience_kind = 'USER' and audience_user_id = lagda_current_user_id())
  `.execute(db);

  await setVocabularies(db, true);
}

/**
 * Fails, deliberately, while any 087 notification, activity entry, or any
 * code or grant resting on a share, request or membership exists.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists notification_audience_user_read on notification_intents`.execute(db);
  await setVocabularies(db, false);
  await sql`
    alter table verification_access_grants
      drop constraint verification_access_grants_basis_check,
      drop column access_basis
  `.execute(db);
  await sql`
    alter table verification_access_challenges
      drop constraint verification_access_challenges_one_subject
  `.execute(db);
  for (const table of ["verification_access_challenges", "verification_access_grants"]) {
    await sql`
      alter table ${sql.table(table)}
        drop constraint ${sql.raw(`${table}_share_fk`)},
        drop constraint ${sql.raw(`${table}_access_request_fk`)},
        drop column share_id,
        drop column access_request_id,
        alter column request_recipient_id set not null
    `.execute(db);
  }
  await sql`drop table document_access_requests`.execute(db);
  await sql`drop table document_shares`.execute(db);
  await sql`drop function if exists lagda_current_document_share_recipient()`.execute(db);
  await sql`drop function if exists lagda_current_document_access_requester()`.execute(db);
}
