// 053 — a saved signature, handed to one ceremony.
//
// ── The problem this solves ───────────────────────────────────────────────
//
// A saved signature lives in `user_signatures`, which belongs to an ACCOUNT.
// The ceremony runs in the recipient realm, which has no account and must not
// acquire one — five separate controls exist to keep it from reading workspace
// data, and a signer with no account must stay unreachable from that side.
//
// So the ceremony cannot fetch a saved signature. The signature has to be
// HANDED to it, by the side that legitimately holds it, at a moment the
// account holder chose.
//
// That moment is the claim. When someone proves — with a signing link, a
// session, and their password — that they are the account for this recipient,
// the claim copies their saved mark into this table, scoped to that one
// recipient of that one request. The ceremony reads only from here.
//
// The direction matters more than the mechanism: workspace → ceremony, pushed,
// once, deliberately. Never ceremony → workspace, pulled, whenever it likes.
//
// ── Why a COPY and not a reference ────────────────────────────────────────
//
// `user_signatures` is a preference: mutable, deletable. If this table held a
// foreign key into it, deleting a saved signature mid-ceremony would empty a
// row the ceremony was about to sign with, and changing one would change what
// a signer had already been shown and approved.
//
// A copy freezes it. What the signer previews is what the signer signs, even
// if they edit their library in another tab while the ceremony is open.
//
// `source_digest` records WHICH saved signature it came from, for audit,
// without depending on that row continuing to exist.
//
// ── Scoped to one recipient, of one request ───────────────────────────────
//
// The primary key is (signing_request_id, request_recipient_id). A prepared
// signature cannot be reused on another document, because there is nowhere to
// put a second one — claiming for a different request writes a different row,
// and claiming twice for the same one replaces it.
//
// ── Deleted when it is spent ──────────────────────────────────────────────
//
// The submission deletes the row in the same transaction that writes the
// evidence. A prepared signature that outlived its use would be a stored copy
// of someone's handwriting sitting in a table nobody reads — and the point of
// a handoff is that it ends.

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
    create table prepared_signatures (
      signing_request_id        varchar(64)  not null,
      request_recipient_id      varchar(64)  not null,
      purpose                   varchar(16)  not null,

      representation_type       varchar(32)  not null,
      typed_text                varchar(200),
      typed_style_index         integer,
      raster_bytes              bytea,
      raster_media_type         varchar(64),
      raster_width              integer,
      raster_height             integer,

      -- Over the bytes AS COPIED. Recomputed on the way in rather than carried
      -- over, so this row's digest describes this row.
      digest                    varchar(64)  not null,

      -- WHICH saved signature this came from. For audit only; there is no
      -- foreign key, because the library entry may be edited or deleted and
      -- this copy must not change or vanish when it is.
      source_digest             varchar(64)  not null,

      -- The account that handed it over, recorded so the evidence can say who.
      prepared_by_user_id       varchar(64)  not null
        references users (user_id) on delete cascade,

      -- The ceremony session this was handed to, carried from the intent.
      --
      -- A prepared signature is offered ONLY back to the browser that asked
      -- for it. A signing link can be forwarded, and the credential in it
      -- proves the holder may open the document — not that they are the
      -- person whose account was verified a moment ago. Without this, a
      -- forwarded link after a claim would inherit someone else's handwriting
      -- and the right to apply it.
      prepared_for_session_id   varchar(64)  not null,

      prepared_at               timestamptz  not null,

      constraint prepared_signatures_pkey
        primary key (signing_request_id, request_recipient_id, purpose),

      constraint prepared_signatures_purpose_check
        check (purpose in (${inList(REPRESENTATION_PURPOSES)})),
      constraint prepared_signatures_type_check
        check (representation_type in (${inList(REPRESENTATION_TYPES)})),
      constraint prepared_signatures_digest_shape
        check (digest ~ '^[a-f0-9]{64}$'),
      constraint prepared_signatures_source_digest_shape
        check (source_digest ~ '^[a-f0-9]{64}$'),

      -- The same one-shape-populated rule the other two signature tables
      -- carry, written out rather than paraphrased. Three tables must agree
      -- about what a representation is, and the failure mode of a paraphrase
      -- is that the loosest one wins.
      constraint prepared_signatures_shape check (
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
      constraint prepared_signatures_typed_style
        check (typed_style_index is null
               or (typed_style_index >= 0 and typed_style_index <= 3)),
      constraint prepared_signatures_raster_bounds check (
        raster_bytes is null
        or (octet_length(raster_bytes) > 0
            and octet_length(raster_bytes) <= ${sql.lit(MAX_RASTER_BYTES)}
            and raster_width  between 1 and ${sql.lit(MAX_RASTER_DIMENSION)}
            and raster_height between 1 and ${sql.lit(MAX_RASTER_DIMENSION)})
      )
    )
  `.execute(db);

  // DELETE is granted, unlike the evidence tables: this row is spent when the
  // submission consumes it, and a handoff that cannot end is not a handoff.
  await sql`
    grant select, insert, update, delete on table prepared_signatures to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists prepared_signatures`.execute(db);
}
