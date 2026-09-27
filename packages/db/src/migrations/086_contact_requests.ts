// 086 — contact requests: asking a contact for a signed copy, an upload, or
// (members only) a document's preparation.
//
// ── The table ─────────────────────────────────────────────────────────────
//
// One row per request, workspace-owned, FORCE `tenant_isolation` like every
// tenant table. The recipient's name and address are SNAPSHOTS of the contact
// at creation, and `contact_id` a tenant-safe reference to it:
// `(workspace_id, contact_id)` is 015's compound-key target, so a request can
// never point at another workspace's contact.
//
// `delivery` is decided once: `in-app` for a contact whose address matched a
// current member (then `recipient_user_id` names them, and no email is sent),
// `email` otherwise (and `recipient_user_id` is null). A CHECK holds that
// pairing, and `preparation` is refused for an emailed request at the table
// too — preparing is workspace work and needs a member.
//
// No foreign key to `documents`, for the reason 067 records (065's scar: an
// RI trigger needs row-lock privilege 003 revoked). The application validates
// both document references.
//
// ── No deletes ────────────────────────────────────────────────────────────
//
// A request is a record of what was asked of whom. `lagda_app` may own the
// table in production and an owner holds every privilege by default, so the
// `revoke delete, truncate` is explicit.
//
// ── Notifications ─────────────────────────────────────────────────────────
//
//   CONTACT_REQUEST_RECEIVED   to the member recipient (USER). In-app only.
//   CONTACT_REQUEST_EMAILED    to an external contact. The audience is the
//                              REQUEST (new kind CONTACT_REQUEST, a real FK),
//                              exactly as 078 addressed a join ticket.
//   CONTACT_REQUEST_COMPLETED  to the requester (USER). In-app only.
//   CONTACT_REQUEST_DECLINED   to the requester (USER). In-app only.
//
// "In-app only" is an intent whose email delivery is stopped at creation as
// SUPPRESSED with the new bounded failure code IN_APP_ONLY — the same
// `stopPendingDelivery` path 084's preferences use — so it is listed by
// `/me/notifications` and never mailed. The vocabulary CHECKs are widened the
// way 078 widened them.

import { type Kysely, sql } from "kysely";

const KINDS = ["signed-document", "upload", "preparation"] as const;
const STATUSES = ["pending", "completed", "declined", "cancelled"] as const;

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED", "VERIFICATION_ACCESS_CODE",
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE, "CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
  "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "CONTACT_REQUEST"] as const;
const AUDIENCES_BEFORE = [
  "USER", "SIGNING_REQUEST_RECIPIENT", "WORKSPACE_INVITEE", "WORKSPACE_JOIN_TICKET",
] as const;
const AUDIENCES_AFTER = [...AUDIENCES_BEFORE, "CONTACT_REQUEST"] as const;
const FAILURE_CODES_BEFORE = [
  "SECRET_EXPIRED", "SECRET_REVOKED", "SOURCE_CANCELLED", "DESTINATION_INVALID",
  "RECIPIENT_PREFERENCE",
] as const;
const FAILURE_CODES_AFTER = [...FAILURE_CODES_BEFORE, "IN_APP_ONLY"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setVocabularies(db: Kysely<unknown>, after: boolean): Promise<void> {
  const types = after ? TYPES_AFTER : TYPES_BEFORE;
  const sources = after ? SOURCES_AFTER : SOURCES_BEFORE;
  const audiences = after ? AUDIENCES_AFTER : AUDIENCES_BEFORE;
  const codes = after ? FAILURE_CODES_AFTER : FAILURE_CODES_BEFORE;
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
  if (after) {
    await sql`
      alter table notification_intents add constraint notification_intents_audience_match check (
        (audience_kind = 'USER' and audience_user_id is not null
          and audience_recipient_id is null and audience_invitation_id is null
          and audience_join_ticket_id is null and audience_contact_request_id is null)
        or (audience_kind = 'SIGNING_REQUEST_RECIPIENT' and audience_recipient_id is not null
          and audience_user_id is null and audience_invitation_id is null
          and audience_join_ticket_id is null and audience_contact_request_id is null)
        or (audience_kind = 'WORKSPACE_INVITEE' and audience_invitation_id is not null
          and audience_user_id is null and audience_recipient_id is null
          and audience_join_ticket_id is null and audience_contact_request_id is null)
        or (audience_kind = 'WORKSPACE_JOIN_TICKET' and audience_join_ticket_id is not null
          and audience_user_id is null and audience_recipient_id is null
          and audience_invitation_id is null and audience_contact_request_id is null)
        or (audience_kind = 'CONTACT_REQUEST' and audience_contact_request_id is not null
          and audience_user_id is null and audience_recipient_id is null
          and audience_invitation_id is null and audience_join_ticket_id is null)
      )
    `.execute(db);
  } else {
    // 078's four-way match, exactly.
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
  }
  await sql`
    alter table notification_deliveries
      drop constraint if exists notification_deliveries_failure_code_check
  `.execute(db);
  await sql`
    alter table notification_deliveries
      add constraint notification_deliveries_failure_code_check
        check (failure_code is null or failure_code in (${inList(codes)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table contact_requests (
      request_id            varchar(64)   primary key,
      workspace_id          varchar(64)   not null references workspaces (workspace_id),
      kind                  varchar(32)   not null,
      contact_id            varchar(64)   not null,
      recipient_name        varchar(200)  not null,
      recipient_email       varchar(320)  not null,
      delivery              varchar(16)   not null,
      recipient_user_id     varchar(64)   references users (user_id),
      title                 varchar(200)  not null,
      message               varchar(2000),
      document_id           varchar(64),
      due_at                timestamptz,
      status                varchar(16)   not null,
      response_document_id  varchar(64),
      decline_reason        varchar(500),
      requested_by_user_id  varchar(64)   not null references users (user_id),
      completed_by_user_id  varchar(64)   references users (user_id),
      created_at            timestamptz   not null,
      updated_at            timestamptz   not null,
      completed_at          timestamptz,
      declined_at           timestamptz,
      cancelled_at          timestamptz,

      constraint contact_requests_workspace_request_unique unique (workspace_id, request_id),
      constraint contact_requests_contact_fk
        foreign key (workspace_id, contact_id) references contacts (workspace_id, contact_id),
      constraint contact_requests_kind_check check (kind in (${inList(KINDS)})),
      constraint contact_requests_status_check check (status in (${inList(STATUSES)})),
      constraint contact_requests_delivery_check check (
        (delivery = 'in-app' and recipient_user_id is not null)
        or (delivery = 'email' and recipient_user_id is null)
      ),
      -- Preparing a document is workspace work: members only.
      constraint contact_requests_preparation_members_only
        check (kind <> 'preparation' or delivery = 'in-app'),
      constraint contact_requests_preparation_document
        check (kind <> 'preparation' or document_id is not null),
      constraint contact_requests_upload_no_subject
        check (kind <> 'upload' or document_id is null),
      constraint contact_requests_title_not_blank check (length(btrim(title)) > 0),
      constraint contact_requests_updated_after_created check (updated_at >= created_at),
      constraint contact_requests_completed_shape check (
        (status = 'completed') = (completed_at is not null and completed_by_user_id is not null)
      ),
      constraint contact_requests_declined_shape check ((status = 'declined') = (declined_at is not null)),
      constraint contact_requests_cancelled_shape check ((status = 'cancelled') = (cancelled_at is not null)),
      constraint contact_requests_response_only_completed
        check (response_document_id is null or status = 'completed'),
      constraint contact_requests_reason_only_declined
        check (decline_reason is null or status = 'declined')
    )
  `.execute(db);
  await sql`
    create index contact_requests_recipient
      on contact_requests (workspace_id, recipient_user_id, status, created_at desc)
  `.execute(db);
  await sql`
    create index contact_requests_requester
      on contact_requests (workspace_id, requested_by_user_id, created_at desc)
  `.execute(db);
  await sql`
    create index contact_requests_contact
      on contact_requests (workspace_id, contact_id, created_at desc)
  `.execute(db);

  await sql`grant select, insert, update on table contact_requests to lagda_app`.execute(db);
  // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
  await sql`revoke delete, truncate on table contact_requests from lagda_app`.execute(db);
  await sql`alter table contact_requests enable row level security`.execute(db);
  await sql`alter table contact_requests force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on contact_requests
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  await sql`alter table notification_intents add column audience_contact_request_id varchar(64)`.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_audience_contact_request_fk
      foreign key (workspace_id, audience_contact_request_id)
      references contact_requests (workspace_id, request_id)
  `.execute(db);
  await setVocabularies(db, true);
}

/** Fails, deliberately, while any 086 notification or IN_APP_ONLY delivery exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
  await sql`
    alter table notification_intents
      drop constraint notification_intents_audience_contact_request_fk,
      drop column audience_contact_request_id
  `.execute(db);
  await sql`drop table contact_requests`.execute(db);
}
