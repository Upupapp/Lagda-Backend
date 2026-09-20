// 050 — a signature a user saves for reuse.
//
// ── What this is, and what it is emphatically not ─────────────────────────
//
// `signing_representations` (023) is EVIDENCE OF AN ACT: the mark a specific
// recipient adopted, in a specific ceremony, at a specific instant. It is
// select+insert only, because an accepted signing value must not be
// rewritable by anything the runtime role can issue.
//
// This table is a PREFERENCE. It is a picture a signed-in user chose to keep
// so they do not have to redraw it. It is mutable and deletable, because a
// preference that cannot be changed or removed is not a preference.
//
// Merging the two was considered and rejected. Every column of
// `signing_representations` is request-scoped — workspace_id,
// signing_request_id, request_recipient_id, submission_id, all NOT NULL with
// foreign keys — and a personal signature has none of those. Worse, merging
// would make "did she sign?" answerable by a row nobody signed with.
//
// ── Applying a saved signature does NOT reference this table ──────────────
//
// When a saved signature is used in a ceremony, a FRESH `signing_representations`
// row is inserted, with its own server-computed digest over its own copy of the
// bytes. The evidence never points here.
//
// That is deliberate. `signing_representations` has no DELETE grant precisely
// so accepted values cannot vanish. If evidence referenced this table, a user
// deleting a saved signature would defeat that guarantee through a table that
// DOES have a DELETE grant — the immutability would be real only until someone
// tidied up their signature library.
//
// The link is recorded the other way round: a provenance value on the
// evidence row says a saved signature was applied, and the evidence event's
// details carry which one and its digest. Enough to audit, not enough to
// dangle. (That column arrives with the ceremony work; this table does not
// depend on it.)
//
// ── Why there is no row-level security here ───────────────────────────────
//
// There is no tenant to scope by. This follows the precedent `users` set in
// 008, quoted so a tenancy audit does not read the absence as an oversight:
//
//   "No RLS: these are global tables and there is no tenant to scope them by.
//    That is deliberate and documented (INV-236)."
//
// The boundary that stops user A reading user B's signature is the same one
// that stops user A editing user B's profile, and it is structural rather than
// a policy: no route carries a `:userId` segment, no schema carries a `userId`
// field, and the repository is constructed with the caller's own id. "User A
// edits user B" is not a request that can be expressed.
//
// A policy on `user_id = current_setting('lagda.user_id')` was considered. It
// would be satisfied only by `runForUser`, which is documented as read-only by
// policy — so every write would have to run in a scope where the setting is
// unset, and the policy would deny it. A control that the writing path cannot
// satisfy is not a control.
//
// ── Bounds are copied from 023, not paraphrased ───────────────────────────
//
// Same 64 KiB, same 512 px, same digest shape, same one-shape-populated CHECK.
// Written out literally rather than imported, because these two tables must
// agree and the failure mode of a paraphrase is that the looser one wins and
// nobody notices until a signature that a library accepted is refused by a
// ceremony — at the moment of signing.

import { sql, type Kysely } from "kysely";

const REPRESENTATION_PURPOSES = ["signature", "initials"] as const;

const REPRESENTATION_TYPES = [
  "TYPED_SIGNATURE_V1",
  "RASTER_SIGNATURE_V1",
] as const;

const MAX_RASTER_BYTES = 64 * 1024;
const MAX_RASTER_DIMENSION = 512;

function inList(values: readonly string[]) {
  return sql.join(values.map(value => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_signatures (
      user_signature_id     varchar(64)  primary key,
      user_id               varchar(64)  not null
        references users (user_id) on delete cascade,

      purpose               varchar(16)  not null,
      representation_type   varchar(32)  not null,

      -- TYPED_SIGNATURE_V1
      typed_text            varchar(200),
      typed_style_index     integer,

      -- RASTER_SIGNATURE_V1. Decoded bytes, never a data URL — the base64
      -- prefix is transport formatting and is not evidence of anything.
      raster_bytes          bytea,
      raster_media_type     varchar(64),
      raster_width          integer,
      raster_height         integer,

      -- SHA-256 over the bytes AS STORED. Computed here; a client-supplied
      -- hash is a claim.
      digest                varchar(64)  not null,

      -- Set when the bytes passed the format checks. NULL means "stored but
      -- not yet usable", which is the state an unvalidated row must be in
      -- rather than being silently treated as good.
      validated_at          timestamptz,

      created_at            timestamptz  not null,
      updated_at            timestamptz  not null,

      constraint user_signatures_purpose_check
        check (purpose in (${inList(REPRESENTATION_PURPOSES)})),
      constraint user_signatures_type_check
        check (representation_type in (${inList(REPRESENTATION_TYPES)})),
      constraint user_signatures_digest_shape
        check (digest ~ '^[a-f0-9]{64}$'),

      -- Exactly one shape is populated, decided by the type.
      constraint user_signatures_shape check (
        (representation_type = 'TYPED_SIGNATURE_V1'
          and typed_text is not null and typed_style_index is not null
          and raster_bytes is null and raster_media_type is null
          and raster_width is null and raster_height is null)
        or
        (representation_type = 'RASTER_SIGNATURE_V1'
          and raster_bytes is not null and raster_media_type is not null
          and raster_width is not null and raster_height is not null
          and typed_text is null and typed_style_index is null)
      ),
      constraint user_signatures_typed_style
        check (typed_style_index is null
               or (typed_style_index >= 0 and typed_style_index <= 3)),

      -- Bounds in the DATABASE, not only in the validator. A validator can be
      -- bypassed by a future caller; a CHECK cannot.
      constraint user_signatures_raster_bounds check (
        raster_bytes is null
        or (octet_length(raster_bytes) > 0
            and octet_length(raster_bytes) <= ${sql.lit(MAX_RASTER_BYTES)}
            and raster_width  between 1 and ${sql.lit(MAX_RASTER_DIMENSION)}
            and raster_height between 1 and ${sql.lit(MAX_RASTER_DIMENSION)})
      ),

      -- One saved signature and one saved set of initials per user.
      --
      -- A UNIQUE constraint rather than a count checked in application code:
      -- "at most one per purpose" then survives a concurrent double-POST,
      -- which a SELECT-then-INSERT does not. It is also what makes "the
      -- default" a question with no answer needed — there is only ever one.
      constraint user_signatures_one_per_purpose unique (user_id, purpose)
    )
  `.execute(db);

  // Every lookup is "this user's saved signatures", so that is the index.
  await sql`
    create index user_signatures_by_user
      on user_signatures (user_id, purpose)
  `.execute(db);

  // Unlike the evidence tables, this one gets UPDATE and DELETE: replacing
  // your signature and removing it are the whole point.
  await sql`
    grant select, insert, update, delete on table user_signatures to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists user_signatures`.execute(db);
}
