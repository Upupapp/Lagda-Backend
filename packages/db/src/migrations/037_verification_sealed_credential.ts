// 037 — the verification token, recoverable while the challenge is live.
//
// The third and last of the OD-184 pattern, and identical to 035 for a reason:
// `email_verification_challenges` and `password_reset_challenges` were
// deliberately built as separate types with the same shape, so that a
// verification challenge cannot be passed where a reset challenge is expected.
// The same separation applies to their credentials, which is why this is its
// own migration and its own constraints rather than a shared abstraction over
// two tables.
//
// A verification email must contain the raw token. The flow persists a digest
// and drops the raw value, so by send time the value the renderer needs exists
// nowhere. The ciphertext lives here, beside `expires_at`, `consumed_at` and
// `superseded_at`, so its life is bounded by the credential's own.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table email_verification_challenges
      add column sealed_secret      text,
      add column sealed_key_version varchar(32)
  `.execute(db);

  await sql`
    alter table email_verification_challenges
      add constraint email_verification_sealed_pairing check (
        (sealed_secret is null and sealed_key_version is null)
        or (sealed_secret is not null and sealed_key_version is not null)
      )
  `.execute(db);

  await sql`
    alter table email_verification_challenges
      add constraint email_verification_sealed_only_while_active check (
        sealed_secret is null
        or (consumed_at is null and superseded_at is null)
      )
  `.execute(db);

  await sql`
    create index email_verification_sealed_expired_idx
      on email_verification_challenges (expires_at)
      where sealed_secret is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists email_verification_sealed_expired_idx`.execute(db);
  await sql`
    alter table email_verification_challenges
      drop constraint if exists email_verification_sealed_only_while_active,
      drop constraint if exists email_verification_sealed_pairing,
      drop column if exists sealed_key_version,
      drop column if exists sealed_secret
  `.execute(db);
}
