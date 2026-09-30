// 093. Plans belong to people: Free, Personal, Business, Enterprise.
//
// ── What a plan is ────────────────────────────────────────────────────────
//
// A PERSON's plan. A workspace has paid features while its OWNER's plan is
// paid, so a Free member of a paid owner's workspace works there normally.
// `user_plans` holds one row per account that has ever had one; an account
// without a row is Free, which is what a brand-new sign-up is.
//
// `paid_until` ends a paid month; when it passes, the plan reads as Free
// without any job touching the row, and nothing else is deleted — the
// workspace's members, teams and branding simply stop being offered until the
// owner is paid again. `auto_renew` keeps a paid plan current indefinitely
// (the LAGDA company account).
//
// `free_documents_used` counts documents SENT under a Free owner's plan. The
// allowance is one, for life; it is claimed by a conditional update in the
// send path, so two concurrent sends cannot both take it.
//
// ── Upgrade requests ──────────────────────────────────────────────────────
//
// Test mode: a person asks for Personal or Business, and the LAGDA owner
// approves or declines it in the app. At most one pending request per person
// (a partial unique index). No bank details are stored — the form accepts only
// the published sample account, and only the fact that it matched is kept.
//
// ── The release ───────────────────────────────────────────────────────────
//
// Every existing account becomes Free, except the LAGDA company account
// (11corteschristopher@gmail.com), which becomes Business, renewing monthly.
// Documents sent before this migration do not count toward the allowance:
// every counter starts at zero.
//
// ── Notifications ─────────────────────────────────────────────────────────
//
// PLAN_UPGRADE_REQUESTED to the approver; PLAN_UPGRADE_APPROVED and
// PLAN_UPGRADE_DECLINED to the requester. GLOBAL_USER scope: a plan is a fact
// about a person, not a workspace. All three are emailed and listed in-app.

import { type Kysely, sql } from "kysely";

const COMPANY_ACCOUNT = "11corteschristopher@gmail.com";

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
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE, "PLAN_UPGRADE_REQUESTED", "PLAN_UPGRADE_APPROVED", "PLAN_UPGRADE_DECLINED",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
  "WORKSPACE_INVITATION_NOTICE", "CONTACT_CONNECTION",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "PLAN_UPGRADE_REQUEST"] as const;

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
    create table user_plans (
      user_id              varchar(64)  primary key references users (user_id),
      plan                 varchar(16)  not null,
      paid_until           timestamptz,
      auto_renew           boolean      not null default false,
      free_documents_used  integer      not null default 0,
      updated_at           timestamptz  not null,

      constraint user_plans_plan_check
        check (plan in ('free', 'personal', 'business', 'enterprise')),
      constraint user_plans_free_documents_check check (free_documents_used >= 0),
      constraint user_plans_paid_shape
        check (plan = 'free' or paid_until is not null or auto_renew)
    )
  `.execute(db);

  await sql`
    create table plan_upgrade_requests (
      request_id      varchar(64)  primary key,
      user_id         varchar(64)  not null references users (user_id),
      plan            varchar(16)  not null,
      amount_pesos    integer      not null,
      status          varchar(16)  not null,
      created_at      timestamptz  not null,
      expires_at      timestamptz  not null,
      decided_at      timestamptz,
      decided_by      varchar(64)  references users (user_id),

      constraint plan_upgrade_requests_plan_check check (plan in ('personal', 'business')),
      constraint plan_upgrade_requests_status_check
        check (status in ('pending', 'approved', 'declined', 'expired', 'cancelled')),
      constraint plan_upgrade_requests_amount_check check (amount_pesos > 0),
      constraint plan_upgrade_requests_expiry_check check (expires_at > created_at),
      constraint plan_upgrade_requests_decided_shape
        check ((status = 'pending') = (decided_at is null))
    )
  `.execute(db);
  await sql`
    create unique index plan_upgrade_requests_one_pending
      on plan_upgrade_requests (user_id) where status = 'pending'
  `.execute(db);
  await sql`
    create index plan_upgrade_requests_by_user
      on plan_upgrade_requests (user_id, created_at desc)
  `.execute(db);

  for (const table of ["user_plans", "plan_upgrade_requests"]) {
    await sql`grant select, insert, update on table ${sql.table(table)} to lagda_app`.execute(db);
    await sql`revoke delete, truncate on table ${sql.table(table)} from lagda_app`.execute(db);
  }

  // The release: everyone Free, the company account Business, monthly.
  await sql`
    insert into user_plans (user_id, plan, paid_until, auto_renew, free_documents_used, updated_at)
    select user_id, 'free', null, false, 0, now() from users
  `.execute(db);
  await sql`
    update user_plans
       set plan = 'business', paid_until = now() + interval '1 month', auto_renew = true
     where user_id in (select user_id from users where normalized_email = ${COMPANY_ACCOUNT})
  `.execute(db);

  await setVocabularies(db, true);
}

/** Fails, deliberately, while any 093 notice exists. Plans are dropped. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
  await sql`drop table plan_upgrade_requests`.execute(db);
  await sql`drop table user_plans`.execute(db);
}
