// 004 — browser sessions.
//
// ── What this table is, and is not ─────────────────────────────────────────
//
// A session answers exactly one question: **which user is this?**
//
// It does NOT answer "may this user access workspace X". That is membership,
// resolved per operation (BACKEND-27). So there is no `workspace_id` column,
// and adding one later would be a design error rather than a feature: a user
// belongs to several workspaces, and the handoff itself says "the session must
// include all accessible workspace IDs" — plural.
//
// ── Tenancy: deliberately NOT workspace-scoped ─────────────────────────────
//
// Every other tenant table carries `workspace_id` with RLS. This one carries
// none, on purpose. Authentication happens BEFORE any workspace is known, so a
// workspace-scoped session table could never be read at the moment it is
// needed. Classified GLOBAL_AUTHENTICATION in TENANCY_MODEL.md so tenancy
// tooling does not read it as an accidental omission.
//
// ── The raw token is never here ────────────────────────────────────────────
//
// The browser cookie holds a high-entropy random token. The database holds only
// its SHA-256 digest. A database compromise therefore does not hand an attacker
// a set of working session cookies — they would have to invert the digest.

import { type Kysely, sql } from "kysely";

/**
 * Why bother recording a reason.
 *
 * "This session ended" and "this session was killed because the password was
 * reset" are different facts during an incident review, and the difference is
 * unrecoverable if not written at the time. Bounded, not free text.
 */
const REVOCATION_REASONS = [
  "logout",
  "rotation",
  "password-change",
  "security-action",
  "account-disabled",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_sessions (
      session_id        varchar(64)  primary key,

      -- No foreign key: the "users" table does not exist yet (BACKEND-19).
      -- Staged deliberately rather than inventing a fake user table to satisfy
      -- referential integrity. BACKEND-19 must create "users" with
      -- UNIQUE (user_id) so this becomes a pure ALTER TABLE.
      user_id           varchar(64)  not null,

      -- SHA-256 of the raw token, lowercase hex. The raw token exists only in
      -- the browser cookie and in memory during one request.
      token_hash        varchar(64)  not null,

      -- SHA-256 of the CSRF token for this session. Same reasoning: the raw
      -- CSRF token lives in a readable cookie, its digest lives here, so the
      -- database cannot hand out working CSRF tokens either.
      csrf_token_hash   varchar(64)  not null,

      created_at        timestamptz  not null default now(),

      -- Sliding window. Handoff §3 specifies "default 8 hours idle" and §4
      -- "sliding expiry", so idle expiry is a product requirement, not a guess.
      last_seen_at      timestamptz  not null default now(),

      -- The ceiling. A session must die eventually even if used constantly —
      -- idle timeout alone means an attacker with a stolen cookie can keep it
      -- alive forever simply by using it.
      expires_at        timestamptz  not null,

      revoked_at        timestamptz,
      revocation_reason varchar(32),

      constraint user_sessions_token_hash_unique unique (token_hash),

      -- Format-checked, not just length-checked: a bug that stored a raw token
      -- here would almost certainly not be 64 lowercase hex characters, so this
      -- constraint is a tripwire for exactly the mistake that matters most.
      constraint user_sessions_token_hash_format
        check (token_hash ~ '^[a-f0-9]{64}$'),
      constraint user_sessions_csrf_hash_format
        check (csrf_token_hash ~ '^[a-f0-9]{64}$'),

      constraint user_sessions_reason_check check (
        revocation_reason is null
        or revocation_reason in (${sql.join(
          REVOCATION_REASONS.map(r => sql.lit(r)), sql`, `,
        )})
      ),
      -- A reason without a revocation, or a revocation without a reason, is a
      -- half-written record.
      constraint user_sessions_revocation_pair
        check ((revoked_at is null) = (revocation_reason is null))
    )
  `.execute(db);

  // The hot path. Every authenticated request resolves a session by digest, so
  // this must be an index lookup and never a scan. The UNIQUE constraint above
  // already provides it; named here so the intent is not lost.

  // Revoke-all-for-user (password reset, security action) and a future account
  // security screen listing a user's sessions.
  await sql`
    create index user_sessions_user_idx
      on user_sessions (user_id, expires_at desc)
  `.execute(db);

  // Cleanup of expired rows (BACKEND-16). Partial, because only unrevoked rows
  // are candidates and the index stays small.
  await sql`
    create index user_sessions_expiry_idx
      on user_sessions (expires_at)
      where revoked_at is null
  `.execute(db);

  // ── Privileges ─────────────────────────────────────────────────────────────
  //
  // UPDATE is granted, unlike the evidence tables: sessions legitimately change
  // — last_seen_at slides, revoked_at is set, rotation supersedes a row.
  // DELETE is granted for the future cleanup job.
  //
  // No RLS. There is no tenant column to scope by, and a policy that always
  // matched would be decorative.
  await sql`
    grant select, insert, update, delete on table user_sessions to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists user_sessions`.execute(db);
}
