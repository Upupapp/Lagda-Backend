// 035 — the reset token, recoverable for exactly as long as it is usable.
//
// ── What this closes (OD-184) ──────────────────────────────────────────────
//
// A password-reset email must contain the raw token. The reset flow persists a
// DIGEST and drops the raw value, which is correct and is why the credential is
// strong — but it means that by the time the delivery worker renders the
// message, the value it needs does not exist anywhere.
//
// So four of LAGDA's five message types could be created and never sent.
//
// ── Why the ciphertext lives HERE and not on the notification ──────────────
//
// `notification_intents` is immutable (INV-647, enforced by having no UPDATE
// grant). A ciphertext written there could never be cleared, so a reset token
// would sit at rest for as long as the notification record does — which is
// indefinitely, since nothing prunes intents and retention is still open under
// BACKEND-55.
//
// This table already has the lifecycle the ciphertext needs: `expires_at`,
// `consumed_at`, `superseded_at`. Putting the sealed value beside them bounds
// its life to the credential's own life BY CONSTRUCTION, rather than by a
// retention policy somebody has to remember to write.
//
// `mfa_factors.secret_ciphertext` established the pattern: a recoverable secret
// belongs in the domain that owns it, sealed with the established SecretBox.
//
// ── What is still not stored ───────────────────────────────────────────────
//
// The raw token. `token_digest` remains the only thing any lookup uses, so the
// raw value still never reaches a query or a statement log. The ciphertext is
// write-once, read-once-at-send, and cleared the moment the credential stops
// being usable.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table password_reset_challenges
      -- AES-256-GCM, from the established SecretBox. Text rather than bytea,
      -- matching mfa_factors: the box emits a self-describing string whose
      -- parts include the key version it was sealed under.
      add column sealed_secret      text,
      add column sealed_key_version varchar(32)
  `.execute(db);

  // Both or neither. A ciphertext with no key version cannot be opened after a
  // rotation, and a version with no ciphertext is a row that claims to carry a
  // credential it does not have -- which a renderer would report as UNUSABLE
  // and an operator would spend an afternoon on.
  await sql`
    alter table password_reset_challenges
      add constraint password_reset_sealed_pairing check (
        (sealed_secret is null and sealed_key_version is null)
        or (sealed_secret is not null and sealed_key_version is not null)
      )
  `.execute(db);

  // A consumed or superseded challenge must not still carry an openable
  // credential. Enforced in the database rather than trusted to every writer:
  // this is the constraint that turns "we clear it on consume" from a habit
  // into a property, and the one that makes the OD-184 argument true rather
  // than intended.
  await sql`
    alter table password_reset_challenges
      add constraint password_reset_sealed_only_while_active check (
        sealed_secret is null
        or (consumed_at is null and superseded_at is null)
      )
  `.execute(db);

  // How the scrub finds expired rows that still carry a credential. Partial, so
  // it is the size of the leak rather than the size of history -- and it is
  // empty in a healthy system, which makes a non-empty scan itself a signal.
  await sql`
    create index password_reset_sealed_expired_idx
      on password_reset_challenges (expires_at)
      where sealed_secret is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists password_reset_sealed_expired_idx`.execute(db);
  await sql`
    alter table password_reset_challenges
      drop constraint if exists password_reset_sealed_only_while_active,
      drop constraint if exists password_reset_sealed_pairing,
      drop column if exists sealed_key_version,
      drop column if exists sealed_secret
  `.execute(db);
}
