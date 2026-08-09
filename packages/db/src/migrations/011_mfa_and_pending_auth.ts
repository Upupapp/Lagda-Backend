// Multi-factor authentication: TOTP factors, recovery codes, and the
// pre-authentication transaction that sits between the two login factors.
//
// ── Why there is no otp_challenges table ───────────────────────────────────
//
// BACKEND-23 describes an issued-and-delivered OTP challenge with a stored
// verifier, delivery intent, resend and supersession. The product's factor is
// TOTP: codes are COMPUTED from a shared secret on the user's phone. Nothing is
// generated server-side per login, nothing is sent, and there is nothing to
// resend.
//
// A challenge table for a delivered code would have no writer and no reader —
// the "foundation without callers" failure this codebase has recorded before.
// See MFA_OTP_PRODUCT_INVENTORY.md.
//
// What TOTP actually needs is here: a recoverable secret, an attempt-limited
// ceremony, replay prevention, and a loss path.

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── MFA factors ─────────────────────────────────────────────────────────
  //
  // A factor TABLE rather than a `users.mfa_enabled` boolean, because the
  // secret, its key version, the enrolment timestamp and the replay watermark
  // all belong to the factor rather than to the account. A boolean would need
  // four more nullable user columns to say the same thing.
  await sql`
    create table mfa_factors (
      factor_id     varchar(64)  primary key,
      user_id       varchar(64)  not null
        references users (user_id) on delete cascade,

      -- Closed set, enforced by CHECK. An unsupported value cannot be routed
      -- silently because it cannot be stored (§7).
      factor_type   varchar(16)  not null,

      -- ── The one credential in this system the server must RECOVER ───────
      --
      -- Sessions, verification codes, reset tokens and recovery codes are all
      -- stored as one-way digests: the server only ever needs to COMPARE.
      -- TOTP is different — computing the expected code requires the secret
      -- itself, so a digest is not an option and plaintext is not acceptable.
      --
      -- Stored as AES-256-GCM ciphertext. The key lives in configuration and
      -- never in this database, so a dump of this table yields nothing usable
      -- without separately compromising the application's environment.
      secret_ciphertext text,
      -- Which key encrypted it. Rotation replaces the ciphertext and bumps
      -- this; the key itself is NEVER stored here (§17).
      secret_key_version varchar(32),

      created_at    timestamptz  not null default now(),
      -- Null until the user proves the factor works by submitting a code from
      -- it. Enrolment is not enabling (§93, §188).
      verified_at   timestamptz,
      disabled_at   timestamptz,

      -- ── Replay watermark (§191) ─────────────────────────────────────────
      --
      -- A TOTP code stays valid for its whole time step plus the skew window.
      -- Without this, a code observed over the user's shoulder — or replayed
      -- from a proxy — works again for up to a minute. Storing the last
      -- accepted step makes each code usable exactly once.
      last_used_time_step bigint,

      constraint mfa_factor_type_known
        check (factor_type in ('TOTP')),
      -- A verified factor must carry a secret and a key version. A verified
      -- factor with no secret could never produce a code, so it would be an
      -- account locked out of its own login.
      constraint mfa_factor_verified_has_secret
        check (verified_at is null
               or (secret_ciphertext is not null and secret_key_version is not null)),
      constraint mfa_factor_disabled_after_created
        check (disabled_at is null or disabled_at >= created_at)
    )
  `.execute(db);

  // At most ONE active factor of a type per user. Partial, so disabled factors
  // accumulate as history without blocking re-enrolment.
  await sql`
    create unique index mfa_factor_one_active
      on mfa_factors (user_id, factor_type)
      where disabled_at is null
  `.execute(db);

  await sql`
    create index mfa_factor_user_idx on mfa_factors (user_id, created_at desc)
  `.execute(db);

  // ── Recovery codes ──────────────────────────────────────────────────────
  //
  // The loss path. 14 characters in `XXXX-XXXX-XXXX`, matching what
  // `RecoveryCodes.tsx` tells the user to expect.
  //
  // Digest-only, like every other high-entropy credential here. Unlike the
  // TOTP secret these are only ever COMPARED, so there is nothing to recover
  // and no reason to keep them reversible.
  await sql`
    create table mfa_recovery_codes (
      recovery_code_id varchar(64) primary key,
      user_id          varchar(64) not null
        references users (user_id) on delete cascade,
      code_digest      varchar(64) not null,
      created_at       timestamptz not null default now(),
      consumed_at      timestamptz,

      constraint mfa_recovery_digest_key unique (code_digest),
      constraint mfa_recovery_digest_shape
        check (code_digest ~ '^[a-f0-9]{64}$')
    )
  `.execute(db);

  // Finding a user's unused codes, and counting what remains.
  await sql`
    create index mfa_recovery_user_idx
      on mfa_recovery_codes (user_id) where consumed_at is null
  `.execute(db);

  // ── Pending authentications ─────────────────────────────────────────────
  //
  // The password factor has succeeded; the second factor has not. This is NOT
  // a session: it authorizes completing one MFA ceremony and nothing else
  // (§42, §46).
  await sql`
    create table pending_authentications (
      pending_id        varchar(64)  primary key,
      user_id           varchar(64)  not null
        references users (user_id) on delete cascade,

      -- A DIGEST of the pre-auth credential, never the credential. Same rule
      -- sessions follow — a database read must not yield a usable credential,
      -- and this one carries a completed password proof.
      credential_digest varchar(64)  not null,

      created_at        timestamptz  not null default now(),
      -- ── The ABSOLUTE bound on a password proof (§85, §86) ──────────────
      --
      -- Deliberately not extendable. Whatever happens inside the ceremony,
      -- entering a password once must not let someone finish authenticating
      -- days later.
      expires_at        timestamptz  not null,
      consumed_at       timestamptz,
      revoked_at        timestamptz,

      -- ── The brute-force bound (§27, §28) ───────────────────────────────
      --
      -- A 6-digit code is one million possibilities — a number a distributed
      -- attacker can cover if the only limit is per-IP rate limiting. The
      -- counter lives HERE, on the ceremony, because TOTP has no per-code
      -- challenge row to hang it on.
      failed_attempts   integer      not null default 0,
      max_attempts      integer      not null,

      -- How the first factor was proved. Recorded so a future assurance model
      -- has something true to read (§98).
      authentication_method varchar(32) not null,

      constraint pending_auth_credential_key unique (credential_digest),
      constraint pending_auth_credential_shape
        check (credential_digest ~ '^[a-f0-9]{64}$'),
      constraint pending_auth_expiry check (expires_at > created_at),
      constraint pending_auth_single_terminal
        check (consumed_at is null or revoked_at is null),
      constraint pending_auth_attempts_bounded
        check (failed_attempts >= 0 and max_attempts > 0
               and failed_attempts <= max_attempts)
    )
  `.execute(db);

  // Deliberately NOT unique per user: a person may legitimately begin login on
  // a phone and a laptop at once, and forcing one global ceremony would let
  // either browser silently kill the other's (§218).
  await sql`
    create index pending_auth_user_idx
      on pending_authentications (user_id)
      where consumed_at is null and revoked_at is null
  `.execute(db);

  await sql`
    grant select, insert, update on mfa_factors to lagda_app
  `.execute(db);
  await sql`
    grant select, insert, update on mfa_recovery_codes to lagda_app
  `.execute(db);
  await sql`
    grant select, insert, update on pending_authentications to lagda_app
  `.execute(db);

  // Recovery codes are the exception: regenerating a set REPLACES the old one,
  // and leaving spent-but-present rows would make "how many codes remain" a
  // question with two answers. Nothing else here may be deleted at runtime.
  await sql`grant delete on mfa_recovery_codes to lagda_app`.execute(db);
  await sql`revoke delete on mfa_factors from lagda_app`.execute(db);
  await sql`revoke delete on pending_authentications from lagda_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists pending_authentications`.execute(db);
  await sql`drop table if exists mfa_recovery_codes`.execute(db);
  await sql`drop table if exists mfa_factors`.execute(db);
}
