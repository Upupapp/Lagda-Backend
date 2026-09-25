// 072 — a profile photo per account.
//
// The profile page let a person pick a photo and showed it — in that tab,
// until reload — and said so ("not uploaded or stored"). Every other page
// showed initials. This stores it.
//
// ── Shaped like `user_signatures` (050), on purpose ────────────────────────
//
// An account's own image, owned by the account and not by any workspace, so
// no tenant RLS: the only reader is the account itself, by its session's user
// id. Decoded bytes, never a data URL. A digest computed here, never taken
// from the client. Bounds in CHECK constraints, not only in the validator —
// a validator can be bypassed by a future caller; a CHECK cannot.
//
// PNG only. The browser crops and scales the photo to a small square before
// upload, so a PNG is always what arrives, and a PNG's shape can be verified
// from its header without an image library parsing untrusted bytes.

import { type Kysely, sql } from "kysely";

/** Enough for a 512x512 PNG photo; the client sends 256x256. */
export const MAX_AVATAR_BYTES = 400 * 1024;
export const MAX_AVATAR_DIMENSION = 512;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_avatars (
      user_id       varchar(64)  primary key
        references users (user_id) on delete cascade,
      media_type    varchar(32)  not null,
      image_bytes   bytea        not null,
      width         integer      not null,
      height        integer      not null,
      digest        varchar(64)  not null,
      updated_at    timestamptz  not null,

      constraint user_avatars_media_type_check check (media_type = 'image/png'),
      constraint user_avatars_digest_shape check (digest ~ '^[a-f0-9]{64}$'),
      constraint user_avatars_bounds check (
        octet_length(image_bytes) > 0
        and octet_length(image_bytes) <= ${sql.lit(MAX_AVATAR_BYTES)}
        and width  between 1 and ${sql.lit(MAX_AVATAR_DIMENSION)}
        and height between 1 and ${sql.lit(MAX_AVATAR_DIMENSION)}
      )
    )
  `.execute(db);

  // Replacing and removing your photo are the whole point, so all four verbs.
  await sql`
    grant select, insert, update, delete on table user_avatars to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists user_avatars`.execute(db);
}
