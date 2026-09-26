// 083 — the Verify Document unlock becomes a six-digit emailed code.
//
// OD-135 (075) unlocked a completed document's PDF for anyone who typed a
// participant's email next to its verification ID. Knowing an address is not
// holding it, so this replaces that with proof of the mailbox: a short-lived
// code sent to the participant's own address, redeemed for a short-lived
// access grant that the document and details routes then require.
//
// ── Two tables ────────────────────────────────────────────────────────────
//
//   verification_access_challenges   one emailed code. Stores a domain-
//       separated SHA-256 DIGEST of the code (never the code), plus the code
//       SEALED with the delivery key while the challenge is live, so the
//       notification worker can render it later — exactly the OD-184 shape
//       `email_verification_challenges` uses (037). The sealed copy is cleared
//       the moment the challenge is consumed, superseded or exhausted.
//   verification_access_grants       one unlock. A random 256-bit token whose
//       digest alone is stored; 30 minutes; bound to ONE verification ID and
//       ONE participant.
//
// ── Tenancy and credential realms ─────────────────────────────────────────
//
// Both tables are workspace-owned (the completed document's workspace) and
// FORCE `tenant_isolation`, like every tenant table. An anonymous caller
// reaches them only after 075's public-verification realm resolved the
// verification ID to its workspace; the repository then enters THAT
// workspace's tenant context (`lagda.current_workspace`, local) before it
// reads or writes a challenge — the same "resolve, then enter the resolved
// tenant" order 078 uses for join tickets.
//
// A grant is presented with nothing but its token, so it gets its own narrow
// realm, shaped exactly like 078's `join_ticket_credential_read`: a stable
// function over `lagda.verification_access_grant_digest`, and a FOR SELECT
// policy matching the one row whose UNIQUE digest equals it. Holding the
// setting is holding the token; no other realm sets it.
//
// ── No deletes ────────────────────────────────────────────────────────────
//
// `lagda_app` may OWN these tables in production (075's header), and an owner
// holds every privilege by default. The explicit `revoke delete, truncate`
// is what keeps a challenge or grant — the record of who unlocked what —
// from being erased by the application.
//
// ── Notifications ─────────────────────────────────────────────────────────
//
// `VERIFICATION_ACCESS_CODE`, sourced by `VERIFICATION_ACCESS_CHALLENGE`,
// addressed to the SIGNING_REQUEST_RECIPIENT that matched. The vocabulary
// CHECKs are widened the same way 078 widened them.

import { type Kysely, sql } from "kysely";

const GRANT_DIGEST_SETTING = "lagda.verification_access_grant_digest";

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "VERIFICATION_ACCESS_CODE"] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "VERIFICATION_ACCESS_CHALLENGE"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setVocabularies(
  db: Kysely<unknown>, types: readonly string[], sources: readonly string[],
): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check,
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(types)})),
      add constraint notification_intents_source_kind_check
        check (source_kind in (${inList(sources)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table verification_access_challenges (
      challenge_id          varchar(64)  primary key,
      workspace_id          varchar(64)  not null references workspaces (workspace_id),
      -- No foreign key to verification_records: it is append-only evidence,
      -- and an FK row lock on it fails in production (see 065 and the
      -- workflow-templates suite). Every read re-derives the record instead.
      verification_id       varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,
      normalized_email      varchar(320) not null,
      code_digest           varchar(64)  not null,
      sealed_code           text,
      sealed_key_version    varchar(32),
      attempts              integer      not null default 0,
      expires_at            timestamptz  not null,
      consumed_at           timestamptz,
      superseded_at         timestamptz,
      created_at            timestamptz  not null,

      constraint verification_access_challenges_recipient_fk
        foreign key (workspace_id, request_recipient_id)
        references signing_request_recipients (workspace_id, request_recipient_id),
      constraint verification_access_challenges_digest_shape
        check (code_digest ~ '^[a-f0-9]{64}$'),
      constraint verification_access_challenges_sealed_pair
        check ((sealed_code is null) = (sealed_key_version is null)),
      constraint verification_access_challenges_attempts_check
        check (attempts >= 0 and attempts <= 5),
      constraint verification_access_challenges_expiry_check
        check (expires_at > created_at),
      -- A challenge ends ONE way: consumed or superseded, never both.
      constraint verification_access_challenges_single_end
        check (consumed_at is null or superseded_at is null),
      -- The sealed code exists only while the challenge can still be redeemed.
      constraint verification_access_challenges_sealed_only_live
        check (sealed_code is null or (consumed_at is null and superseded_at is null))
    )
  `.execute(db);
  // Resending supersedes: at most one live challenge per address per document.
  await sql`
    create unique index verification_access_challenges_one_live
      on verification_access_challenges (verification_id, normalized_email)
      where consumed_at is null and superseded_at is null
  `.execute(db);

  await sql`
    create table verification_access_grants (
      grant_id              varchar(64)  primary key,
      workspace_id          varchar(64)  not null references workspaces (workspace_id),
      -- No foreign key to verification_records: it is append-only evidence,
      -- and an FK row lock on it fails in production (see 065 and the
      -- workflow-templates suite). Every read re-derives the record instead.
      verification_id       varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,
      token_digest          varchar(64)  not null unique,
      origin                varchar(16)  not null,
      challenge_id          varchar(64)  references verification_access_challenges (challenge_id),
      user_id               varchar(64)  references users (user_id),
      expires_at            timestamptz  not null,
      created_at            timestamptz  not null,

      constraint verification_access_grants_recipient_fk
        foreign key (workspace_id, request_recipient_id)
        references signing_request_recipients (workspace_id, request_recipient_id),
      constraint verification_access_grants_digest_shape
        check (token_digest ~ '^[a-f0-9]{64}$'),
      constraint verification_access_grants_origin_check check (
        (origin = 'code' and challenge_id is not null and user_id is null)
        or (origin = 'member' and user_id is not null and challenge_id is null)
      ),
      constraint verification_access_grants_expiry_check
        check (expires_at > created_at)
    )
  `.execute(db);

  for (const table of ["verification_access_challenges", "verification_access_grants"]) {
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

  await sql`
    create or replace function lagda_current_verification_access_grant_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(GRANT_DIGEST_SETTING)}, true), '') $$
  `.execute(db);
  await sql`
    grant execute on function lagda_current_verification_access_grant_digest() to lagda_app
  `.execute(db);
  await sql`
    create policy verification_access_grant_credential_read on verification_access_grants
    for select
    using (token_digest = lagda_current_verification_access_grant_digest())
  `.execute(db);

  await setVocabularies(db, TYPES_AFTER, SOURCES_AFTER);
}

/** Fails, deliberately, while any 083 notification exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_BEFORE, SOURCES_BEFORE);
  await sql`drop table verification_access_grants`.execute(db);
  await sql`drop table verification_access_challenges`.execute(db);
  await sql`drop function if exists lagda_current_verification_access_grant_digest()`.execute(db);
}
