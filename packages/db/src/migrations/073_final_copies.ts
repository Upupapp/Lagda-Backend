// 073 — every participant can download the finished document.
//
// When a request completes, each participant who took part (and each copy
// recipient) is emailed a personal link to the FINAL signed PDF — unless the
// sender switched that off for this document. Viewers are not: their access
// was read-only during signing and ends with it.
//
// ── What this adds ─────────────────────────────────────────────────────────
//
//   signing_requests.share_final_copy   the sender's per-document choice,
//                                       default ON
//   final_copy_grants                   a download credential's DIGEST, per
//                                       participant, shaped exactly like
//                                       signing_access_grants (020)
//   lagda_current_final_copy_digest()   its own credential realm (021's
//                                       pattern): the ONE grant whose
//                                       credential the caller holds
//   + FINAL_COPY_AVAILABLE / FINAL_COPY_GRANT in the notification vocab
//
// ── Why a new credential and not the signing link ──────────────────────────
//
// Completion REVOKES every signing grant and session (final-seal, "the
// lockout, both layers"), and that must stay true: a signing link is a key
// to a ceremony. A download link can do exactly one thing — fetch the sealed
// PDF of a completed request — so it is its own credential, with its own
// digest domain, its own expiry and its own table.

import { type Kysely, sql } from "kysely";

const DIGEST_SETTING = "lagda.final_copy_digest";
const RECIPIENT_SESSION_DIGEST_FN = "lagda_current_recipient_session_digest()";

const values = (allowed: readonly string[]) => {
  for (const value of allowed) {
    if (!/^[A-Z_]+$/u.test(value)) {
      throw new Error(`Refusing to inline an unexpected literal: ${value}`);
    }
  }
  return sql.raw(allowed.map(value => `'${value}'`).join(", "));
};

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "WORKSPACE_INVITATION",
  "SIGNING_INVITATION",
  "SIGNING_COMPLETED",
  "DOCUMENT_UPLOAD_REQUESTED",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "FINAL_COPY_AVAILABLE"] as const;

const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT",
  "SECURITY_CHALLENGE",
  "WORKSPACE_INVITATION",
  "SIGNING_REQUEST",
  "DOCUMENT_UPLOAD_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "FINAL_COPY_GRANT"] as const;

async function setVocabularies(
  db: Kysely<unknown>,
  types: readonly string[],
  sources: readonly string[],
): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
      check (notification_type in (${values(types)}))
  `.execute(db);
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_source_kind_check
      check (source_kind in (${values(sources)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Default ON, so every request sent before this existed, and every send
  // that does not say otherwise, shares the final copy.
  await sql`
    alter table signing_requests
      add column share_final_copy boolean not null default true
  `.execute(db);

  await sql`
    create table final_copy_grants (
      grant_id              varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- SHA-256 of the raw credential under its OWN domain. Never the raw value.
      credential_digest     varchar(64)  not null,

      created_at            timestamptz  not null,
      -- Always explicit: a download key must not sit in an inbox forever.
      expires_at            timestamptz  not null,
      revoked_at            timestamptz,

      constraint final_copy_grants_digest_key unique (credential_digest),
      constraint final_copy_grants_digest_shape
        check (credential_digest ~ '^[a-f0-9]{64}$'),
      constraint final_copy_grants_expiry_after_creation
        check (expires_at > created_at),
      -- One per participant per request: a completion produces exactly one.
      constraint final_copy_grants_one_per_recipient
        unique (workspace_id, signing_request_id, request_recipient_id),
      constraint final_copy_grants_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  await sql`
    grant select, insert, update on table final_copy_grants to lagda_app
  `.execute(db);
  await sql`alter table final_copy_grants enable row level security`.execute(db);
  await sql`alter table final_copy_grants force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on final_copy_grants
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  // The credential realm (021's pattern). Fail closed: an unset setting is
  // NULL and matches nothing. STABLE, never IMMUTABLE.
  await sql`
    create or replace function lagda_current_final_copy_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(DIGEST_SETTING)}, true), '') $$;
  `.execute(db);
  await sql`
    grant execute on function lagda_current_final_copy_digest() to lagda_app
  `.execute(db);
  await sql`
    create policy final_copy_credential_read on final_copy_grants
    for select
    using (credential_digest = lagda_current_final_copy_digest())
  `.execute(db);

  // Never readable from a signing (recipient) session — 024's rule for every
  // bearer-credential table.
  await sql`
    create policy recipient_realm_denied on final_copy_grants
    as restrictive
    using (${sql.raw(`${RECIPIENT_SESSION_DIGEST_FN} is null`)})
    with check (${sql.raw(`${RECIPIENT_SESSION_DIGEST_FN} is null`)})
  `.execute(db);

  await setVocabularies(db, TYPES_AFTER, SOURCES_AFTER);
}

/** Fails if any FINAL_COPY_AVAILABLE intent exists — 049/068's rule. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_BEFORE, SOURCES_BEFORE);
  await sql`drop policy if exists recipient_realm_denied on final_copy_grants`.execute(db);
  await sql`drop policy if exists final_copy_credential_read on final_copy_grants`.execute(db);
  await sql`drop policy if exists tenant_isolation on final_copy_grants`.execute(db);
  await sql`drop table if exists final_copy_grants`.execute(db);
  await sql`drop function if exists lagda_current_final_copy_digest()`.execute(db);
  await sql`alter table signing_requests drop column if exists share_final_copy`.execute(db);
}
