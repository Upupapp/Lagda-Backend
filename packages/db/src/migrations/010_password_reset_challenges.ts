// Password-reset challenges.
//
// ── Why a SEPARATE table (§4, Option A) ────────────────────────────────────
//
// `email_verification_challenges` has an identical shape, and sharing it would
// have saved a migration. It is the wrong trade.
//
// A shared table needs a `purpose` discriminator, and every single query then
// has to remember to filter on it. The day one query forgets, an email
// verification code becomes a password-reset credential — which is the exact
// credential-confusion failure this whole feature is built to prevent (§2).
// Two tables make that mistake impossible to write rather than merely
// discouraged: a reset lookup cannot see a verification row because it is not
// in the table being queried.
//
// The cost is a duplicated shape. The benefit is that the strongest guarantee
// in the feature — one credential domain cannot reach another — is enforced by
// the schema instead of by discipline.
//
// Deliberately NOT a generic `tokens` table (§4).

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table password_reset_challenges (
      challenge_id  varchar(64)  primary key,
      user_id       varchar(64)  not null
        references users (user_id) on delete cascade,

      -- A DIGEST, never the token. The raw token is a bearer credential that
      -- authorizes replacing an account's password; storing it would mean a
      -- database read is a takeover primitive for every pending reset (§6, §39).
      token_digest  varchar(64)  not null,

      created_at    timestamptz  not null default now(),
      expires_at    timestamptz  not null,

      -- Set when the token successfully replaces a password. This is the
      -- evidence of prior use, and the row is NOT deleted (§14) — deletion as
      -- the only record of consumption means a replayed token is
      -- indistinguishable from one that never existed.
      consumed_at   timestamptz,

      -- Set when a later reset request rotates this challenge, or when a
      -- successful reset invalidates the others (§15, §72).
      superseded_at timestamptz,

      constraint password_reset_digest_key unique (token_digest),
      constraint password_reset_digest_shape
        check (token_digest ~ '^[a-f0-9]{64}$'),
      constraint password_reset_expiry check (expires_at > created_at),

      -- A challenge cannot be both consumed and superseded. They are different
      -- terminal states with different meanings, and a row carrying both would
      -- make "was this token ever used to change a password?" unanswerable.
      constraint password_reset_single_terminal
        check (consumed_at is null or superseded_at is null)
    )
  `.execute(db);

  // ── At most ONE active challenge per account (§16) ────────────────────────
  //
  // A PARTIAL UNIQUE INDEX, not application logic. Two concurrent
  // forgot-password requests both read "no active challenge" and both insert;
  // only one commits, and the loser retries or fails cleanly. Without this the
  // race leaves two live reset links for one account, doubling the exposure of
  // the single most dangerous credential the system issues (§17).
  //
  // Expiry is NOT part of the predicate: an expired-but-unsuperseded row still
  // occupies the slot, so a new request must supersede it first. That keeps the
  // rotation path identical whether the old challenge died of age or is still
  // live, rather than having two code paths where one is rarely exercised.
  await sql`
    create unique index password_reset_one_active
      on password_reset_challenges (user_id)
      where consumed_at is null and superseded_at is null
  `.execute(db);

  // Supports superseding a user's outstanding challenges and any future
  // account-security review. Digest lookup is already indexed by the unique
  // constraint (§151).
  await sql`
    create index password_reset_user_idx
      on password_reset_challenges (user_id, created_at desc)
  `.execute(db);

  // No RLS: like users and verification challenges, this is a global table with
  // no tenant to scope it by (INV-236).
  await sql`
    grant select, insert, update on password_reset_challenges to lagda_app
  `.execute(db);

  // No DELETE. Retention is a policy question nobody has answered yet, and a
  // runtime role that can erase reset history is a larger blast radius than
  // this feature needs (§133, §134).
  await sql`revoke delete on password_reset_challenges from lagda_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists password_reset_challenges`.execute(db);
}
