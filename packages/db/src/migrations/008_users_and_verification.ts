// Account identity and email verification.
//
// The first GLOBAL, non-tenant tables in the schema. A user exists before any
// workspace and may belong to several, so these carry no `workspace_id` and no
// RLS policy — requiring a tenant to look up an account would make login
// impossible (INV-236).
//
// `user_sessions` (migration 004) was written anticipating this: it holds a
// `user_id` with no foreign key and a comment saying the FK arrives here.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      user_id           varchar(64)  primary key,

      -- What the user typed. For display and for addressing mail.
      email             varchar(254) not null,

      -- CANONICAL IDENTITY: trim + lowercase, produced by normalizeEmail and
      -- never by this layer. A database that lowercased independently would be
      -- a second normalization rule, and the two would drift (INV-231).
      normalized_email  varchar(254) not null,

      -- Argon2id, PHC-encoded: algorithm, version, parameters, salt and hash in
      -- one string. No separate salt column - inventing one would mean managing
      -- salt generation by hand.
      --
      -- NOT NULL: every account today is a password account. If SSO or
      -- passwordless identities arrive, this becomes nullable in an additive
      -- migration - deliberately not made nullable now for a feature that does
      -- not exist.
      password_hash     text         not null,

      display_name      varchar(200) not null,
      -- Optional context from the real registration form. BACKEND-24 owns
      -- profile and may move these; they are here rather than dropped because
      -- silently discarding what a user typed is worse than storing it.
      organization      varchar(200),
      intended_use      varchar(64),

      -- NULL means unverified. A timestamp means verified, and when.
      --
      -- Preferred over a boolean plus a separate date, which can disagree, and
      -- over an account-status enum, which would invent PENDING/SUSPENDED/
      -- LOCKED states the product has not defined.
      email_verified_at timestamptz,

      -- WHICH terms were accepted, not merely that some were. A bare boolean is
      -- worthless the day the documents change.
      terms_version     varchar(32)  not null,
      terms_accepted_at timestamptz  not null,

      created_at        timestamptz  not null default now(),

      -- THE duplicate guarantee. An application pre-check improves behaviour but
      -- races with itself; this is what makes two simultaneous registrations
      -- impossible (INV-232).
      constraint users_normalized_email_key unique (normalized_email),

      constraint users_email_present check (length(email) > 0),
      constraint users_normalized_present check (length(normalized_email) > 0),
      -- The stored hash must actually be Argon2id. A row holding a plaintext
      -- password, or a hash from a weaker algorithm, is refused by the database
      -- rather than discovered later (INV-243).
      constraint users_password_argon2id check (password_hash like '$argon2id$%'),
      constraint users_display_name_present check (length(display_name) > 0)
    )
  `.execute(db);

  // Sessions can now reference a real account. Done here rather than in 004
  // because an applied migration is never edited.
  await sql`
    alter table user_sessions
      add constraint user_sessions_user_fk
      foreign key (user_id) references users (user_id) on delete cascade
  `.execute(db);

  // ── Email verification challenges ────────────────────────────────────────
  await sql`
    create table email_verification_challenges (
      challenge_id  varchar(64)  primary key,
      user_id       varchar(64)  not null
        references users (user_id) on delete cascade,

      -- A DIGEST of the token, never the token. The raw value is a bearer
      -- credential emailed to the user; storing it would mean a database read
      -- verifies every pending account (INV-237). Same rule as sessions.
      token_digest  varchar(64)  not null,

      created_at    timestamptz  not null default now(),
      expires_at    timestamptz  not null,
      -- Set by BACKEND-21 when the token is redeemed. Registration only creates
      -- the challenge; it never consumes one.
      consumed_at   timestamptz,

      constraint email_verification_digest_key unique (token_digest),
      constraint email_verification_digest_shape
        check (token_digest ~ '^[a-f0-9]{64}$'),
      constraint email_verification_expiry check (expires_at > created_at)
    )
  `.execute(db);

  // Lookup by digest is how BACKEND-21 will redeem a token; the unique
  // constraint already indexes it. This one supports finding a user's
  // outstanding challenges, which resend will need.
  await sql`
    create index email_verification_user_idx
      on email_verification_challenges (user_id, created_at desc)
  `.execute(db);

  // ── Grants ───────────────────────────────────────────────────────────────
  //
  // No RLS: these are global tables and there is no tenant to scope them by.
  // That is deliberate and documented, so a tenancy audit does not read it as
  // an oversight (INV-236).
  await sql`grant select, insert, update on users to lagda_app`.execute(db);
  await sql`
    grant select, insert, update on email_verification_challenges to lagda_app
  `.execute(db);

  // No DELETE. Account erasure is BACKEND-55's, with its own policy and audit;
  // a runtime role that can delete accounts is a much larger blast radius than
  // anything registration needs.
  await sql`revoke delete on users from lagda_app`.execute(db);
  await sql`
    revoke delete on email_verification_challenges from lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table user_sessions drop constraint if exists user_sessions_user_fk
  `.execute(db);
  await sql`drop table if exists email_verification_challenges`.execute(db);
  await sql`drop table if exists users`.execute(db);
}
