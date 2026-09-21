// 056 — "Documents I must sign", and continuing to sign from inside the app.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE RULE THESE TABLES MUST NOT OUTLIVE
// ══════════════════════════════════════════════════════════════════════════
//
//  `user_signing_inbox` is WRITTEN WHEN A RECIPIENT IS INVITED and READ ONLY
//  BY ITS OWNER. Like 055, it must never become a join key for a workspace
//  list, a sender dashboard or a report, and `workspace_id` on it is for
//  reference only, never a filter.
//
//  Its authorization story, stated because 051 requires one:
//
//    WHO MAY WRITE   the invitation itself. The row is written by the one
//                    provisioner that issues a signing credential and queues
//                    the invitation email, in the same transaction, and only
//                    when an account exists whose VERIFIED address equals the
//                    address the invitation is sent to.
//
//    WHO MAY READ    that account, by its own user id. It learns exactly what
//                    the invitation email already told that inbox — that a
//                    document is waiting for it — and nothing about anyone
//                    else on the request.
//
//  A verified address is the same proof the emailed link relies on: control
//  of that mailbox. Nothing here is visible to an account that could not
//  have read the email.
//
// ── Continuing from the app: a handoff in the other direction ─────────────
//
// 051's intents carry a claim FROM the ceremony TO the account. Continuing to
// sign from the app goes the other way: the account asks to enter the
// ceremony. `signing_resume_intents` is that message, with the same shape and
// the same protections — a short-lived, single-use code, digested at rest,
// minted only after the account re-proves its password.
//
// The ceremony is still entered through the RECIPIENT'S OWN CREDENTIAL. The
// intent carries the digest of the grant the invitation was issued under, and
// consuming it bootstraps exactly as the emailed link does. So everything
// that ends a link ends this too: a revoked grant, an expired one, a
// cancelled or completed request, a recipient not yet active.
//
// ── Why the grant digest is stored here ───────────────────────────────────
//
// The workspace realm cannot hand the recipient realm a grant id, because
// grant rows are readable only under a credential-digest RLS setting. The
// digest is what that setting keys on. It is a digest, not the credential:
// a copy of this table does not open a ceremony, any more than a copy of
// `signing_access_grants` does. It is never projected to a client.
//
// ── The method is recorded as what happened ───────────────────────────────
//
// A session entered this way was authenticated by an account and a password,
// not by possession of the link. `recipient_signing_sessions` records that as
// `account-password`, so the evidence and the completion certificate say what
// actually happened rather than "signing link".

import { sql, type Kysely } from "kysely";

const METHODS_BEFORE = ["link-only", "email-otp"] as const;
const METHODS_AFTER = ["link-only", "email-otp", "account-password"] as const;

function inList(values: readonly string[]) {
  return sql.join(values.map(value => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_signing_inbox (
      user_id                     varchar(64)  not null
        references users (user_id) on delete cascade,

      signing_request_id          varchar(64)  not null,
      request_recipient_id        varchar(64)  not null,

      -- FOR REFERENCE ONLY. Never a filter. See the rule above.
      workspace_id                varchar(64)  not null,

      -- The invitation's address, and the one the account must still hold,
      -- verified, when it asks to continue.
      recipient_normalized_email  varchar(254) not null,

      -- The grant this invitation was issued under. See the header.
      grant_credential_digest     varchar(64)  not null,

      -- As the invitation described them.
      document_title              varchar(500) not null,
      sender_name                 varchar(200),
      sender_email                varchar(254),
      workspace_name              varchar(200),

      invited_at                  timestamptz  not null,
      -- The grant's own expiry. Past it, the invitation cannot be used.
      expires_at                  timestamptz  not null,

      -- Set when the recipient's part is over: signed, declined, cancelled.
      closed_at                   timestamptz,
      closed_reason               varchar(16),

      constraint user_signing_inbox_pkey
        primary key (signing_request_id, request_recipient_id),
      constraint user_signing_inbox_email_normalized
        check (recipient_normalized_email = lower(recipient_normalized_email)),
      constraint user_signing_inbox_digest_shape
        check (grant_credential_digest ~ '^[a-f0-9]{64}$'),
      constraint user_signing_inbox_closed_pair
        check ((closed_at is null) = (closed_reason is null)),
      constraint user_signing_inbox_closed_reason
        check (closed_reason is null
               or closed_reason in ('signed', 'declined', 'cancelled'))
    )
  `.execute(db);

  // The owner's open items, newest first.
  await sql`
    create index user_signing_inbox_open_by_owner
      on user_signing_inbox (user_id, invited_at desc)
      where closed_at is null
  `.execute(db);

  // Closing by request, when a sender cancels. The request id is the key the
  // cancellation holds; this reads no workspace scope and returns nothing.
  await sql`
    create index user_signing_inbox_by_request
      on user_signing_inbox (signing_request_id)
      where closed_at is null
  `.execute(db);

  await sql`
    grant select, insert, update on table user_signing_inbox to lagda_app
  `.execute(db);

  await sql`
    create table signing_resume_intents (
      intent_digest               varchar(64)  primary key,

      user_id                     varchar(64)  not null
        references users (user_id) on delete cascade,
      signing_request_id          varchar(64)  not null,
      request_recipient_id        varchar(64)  not null,

      grant_credential_digest     varchar(64)  not null,
      -- Allocated when the code is minted, so the account's saved marks can be
      -- handed to exactly the session this code will open, and to no other.
      signing_session_id          varchar(64)  not null,

      created_at                  timestamptz  not null,
      expires_at                  timestamptz  not null,
      consumed_at                 timestamptz,

      constraint signing_resume_intents_digest_shape
        check (intent_digest ~ '^[a-f0-9]{64}$'),
      constraint signing_resume_intents_grant_digest_shape
        check (grant_credential_digest ~ '^[a-f0-9]{64}$'),
      constraint signing_resume_intents_expiry_after_creation
        check (expires_at > created_at)
    )
  `.execute(db);

  await sql`
    create index signing_resume_intents_by_expiry
      on signing_resume_intents (expires_at)
      where consumed_at is null
  `.execute(db);

  await sql`
    grant select, insert, update, delete on table signing_resume_intents to lagda_app
  `.execute(db);

  await sql`
    alter table recipient_signing_sessions
      drop constraint recipient_sessions_method_check
  `.execute(db);
  await sql`
    alter table recipient_signing_sessions
      add constraint recipient_sessions_method_check
        check (authentication_method in (${inList(METHODS_AFTER)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table recipient_signing_sessions
      drop constraint recipient_sessions_method_check
  `.execute(db);
  await sql`
    alter table recipient_signing_sessions
      add constraint recipient_sessions_method_check
        check (authentication_method in (${inList(METHODS_BEFORE)}))
  `.execute(db);
  await sql`drop table if exists signing_resume_intents`.execute(db);
  await sql`drop table if exists user_signing_inbox`.execute(db);
}
