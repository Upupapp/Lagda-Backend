// 095. Messages from the public website: a demo request, a contact message,
// an eNotary waitlist sign-up.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// The three public forms validated their input and then discarded it. This
// table is where a submission goes instead. A row is written by a visitor with
// NO account and no credential, so it belongs to no workspace and no user:
// there is no tenant policy, and it is read only by the LAGDA owner's account
// (the application decides who that is; see `public-inquiries.ts`).
//
// Kept: what the visitor typed, and when. NOT kept: an IP address or a device
// — the limiter needs the address for a minute, the record does not need it
// at all.
//
// A waitlist row is a request to be told about LAGDA eNotary. It is not an
// account, an appointment or an eligibility decision.
//
// ── The notice ────────────────────────────────────────────────────────────
//
// PUBLIC_INQUIRY_RECEIVED to the LAGDA owner, emailed and listed in-app.
// GLOBAL_USER scope: the inbox is one account's, not a workspace's.

import { type Kysely, sql } from "kysely";

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED", "VERIFICATION_ACCESS_CODE",
  "CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
  "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED",
  "DOCUMENT_SHARE_RECEIVED", "DOCUMENT_SHARE_ACCEPTED", "DOCUMENT_SHARE_REJECTED",
  "DOCUMENT_ACCESS_REQUESTED", "DOCUMENT_ACCESS_APPROVED", "DOCUMENT_ACCESS_REJECTED",
  "SHARED_DOCUMENT_ACCESS_CODE",
  "WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED",
  "CONTACT_CONNECTION_REQUESTED", "CONTACT_CONNECTION_ACCEPTED",
  "PLAN_UPGRADE_REQUESTED", "PLAN_UPGRADE_APPROVED", "PLAN_UPGRADE_DECLINED",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "PUBLIC_INQUIRY_RECEIVED"] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
  "WORKSPACE_INVITATION_NOTICE", "CONTACT_CONNECTION", "PLAN_UPGRADE_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "PUBLIC_INQUIRY"] as const;

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
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table public_inquiries (
      inquiry_id         varchar(64)   primary key,
      kind               varchar(16)   not null,
      name               varchar(120)  not null,
      email              varchar(254)  not null,
      organization       varchar(160),
      role               varchar(120),
      organization_size  varchar(40),
      industry           varchar(120),
      phone              varchar(40),
      topic              varchar(120),
      subject            varchar(200),
      message            varchar(4000),
      created_at         timestamptz   not null,

      constraint public_inquiries_kind_check
        check (kind in ('demo', 'contact', 'waitlist')),
      constraint public_inquiries_name_check check (length(btrim(name)) > 0),
      constraint public_inquiries_email_check check (position('@' in email) > 1)
    )
  `.execute(db);
  await sql`
    create index public_inquiries_by_time on public_inquiries (created_at desc, inquiry_id)
  `.execute(db);
  await sql`
    create index public_inquiries_by_kind on public_inquiries (kind, created_at desc)
  `.execute(db);

  // Written and read; never changed and never removed by the application.
  await sql`grant select, insert on table public_inquiries to lagda_app`.execute(db);
  await sql`revoke update, delete, truncate on table public_inquiries from lagda_app`.execute(db);

  await setVocabularies(db, true);
}

/** Fails, deliberately, while any 095 notice exists. Inquiries are dropped. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
  await sql`drop table public_inquiries`.execute(db);
}
