// 023 — authoritative recipient signature submission.
//
// ── The three facts this stores ────────────────────────────────────────────
//
//   RecipientSubmission   ONE per recipient per request. The signing act, and
//                         the authoritative instant it happened.
//   SigningRepresentation The adopted signature or initials, stored once and
//                         referenced by every field that uses it.
//   SigningFieldValue     ONE per field. Immutable.
//
// All three are SELECT + INSERT only. There is no statement the runtime role
// can issue that would rewrite an accepted signing value, which is a stronger
// guarantee than a rule about not writing one.
//
// ── The constraint that matters most ───────────────────────────────────────
//
// A FOUR-column foreign key from every value to the field ASSIGNMENT:
//
//   (workspace_id, signing_request_id, request_field_id, request_recipient_id)
//
// It requires a new unique key on `signing_request_fields`, added below. With
// it, submitting another recipient's field is not "rejected by a check" - it
// has no referent. Recipient A can know Recipient B's field id, send it, and
// defeat every application-layer bug, and PostgreSQL still refuses the row.
//
// ── Where the drawn signature lives ────────────────────────────────────────
//
// In this database, as `bytea`, bounded at 64 KiB.
//
// Not because blobs in PostgreSQL are elegant, but because the alternative is
// worse HERE: object storage and PostgreSQL are not atomic together, so a
// binary asset needs a pending row, a claim step, a commit-order window and an
// orphan sweeper. This is the most legally consequential write in the product.
// Removing an entire class of failure window is worth more than tidiness, and
// a 420x120 signature PNG is single-digit kilobytes.
//
// SIGNATURE_SUBMISSION_PRODUCT_INVENTORY.md records the threshold at which the
// pending/claim model becomes the right answer instead.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No recipient state column, no request completion, no routing advancement, no
// signed PDF, no seal. BACKEND-37 owns the workflow transition and must reuse
// `accepted_at` rather than inventing a second signing time for one act.

import { type Kysely, sql } from "kysely";

const RECIPIENT_SESSION_DIGEST_FN = "lagda_current_recipient_session_digest()";

/**
 * What an adopted representation is FOR.
 *
 * The ceremony adopts one signature and one set of initials, separately, and
 * the dialog treats them as different things. So does this.
 */
const REPRESENTATION_PURPOSES = ["signature", "initials"] as const;

/**
 * How a representation is encoded, VERSIONED from the first row.
 *
 * A rendering change later must be able to tell what it is looking at
 * (§119). Version 1 of each is what the product can produce today; `UPLOAD`
 * has no member because the product has no upload path.
 */
const REPRESENTATION_TYPES = [
  "TYPED_SIGNATURE_V1",
  "RASTER_SIGNATURE_V1",
] as const;

/** Who supplied the final value. Never accepted from a client (§118). */
const VALUE_SOURCES = ["RECIPIENT_PROVIDED", "SERVER_DERIVED"] as const;

/**
 * The shape a stored value takes, which decides which column is populated.
 *
 * Explicit columns rather than one JSONB blob (§111): a `text_value` that must
 * be a string is enforced by the column, and a checkbox that must be a boolean
 * cannot arrive as the string "yes".
 */
const VALUE_KINDS = ["text", "boolean", "instant", "representation"] as const;

/** 420x120 is the product's canvas. This is generous headroom, not a target. */
const MAX_RASTER_BYTES = 64 * 1024;
const MAX_RASTER_DIMENSION = 512;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The assignment key ──────────────────────────────────────────────────────
  //
  // `request_field_id` is already the primary key, so this adds no new
  // uniqueness - what it adds is a REFERENCEABLE key that includes the
  // recipient, which is what lets a value row point at an assignment rather
  // than merely at a field.
  await sql`
    alter table signing_request_fields
      add constraint signing_request_fields_assignment_key
      unique (workspace_id, signing_request_id, request_field_id,
              request_recipient_id)
  `.execute(db);

  // ── The submission ──────────────────────────────────────────────────────────
  await sql`
    create table recipient_submissions (
      submission_id         varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- THE authoritative signing instant, from the backend Clock.
      --
      -- One column, not two. created_at would carry the same semantic moment
      -- under a different name (§104), and two timestamps for one act is how a
      -- later reader ends up unsure which one the signature happened at.
      --
      -- BACKEND-37 MUST reuse this as the recipient's signed-at. Generating a
      -- second Date.now() at transition time would give one signing act two
      -- different times, and the difference would be a scheduling artefact
      -- presented as a fact (§166).
      accepted_at           timestamptz  not null,

      -- Attribution, deliberately NOT foreign keys. A signing record is legal
      -- evidence and must outlive operational rows; the same argument the
      -- consent table makes.
      signing_session_id    varchar(64)  not null,
      authentication_method varchar(32)  not null,
      -- The consent that was in force. NULL only for recipient types the
      -- disclosure does not apply to, which today cannot hold fields anyway.
      consent_id            varchar(64),

      -- ONE accepted submission per recipient per request (§109).
      --
      -- This is the no-amendment policy expressed where it cannot be bypassed:
      -- a second deliberate submission does not overwrite, it violates.
      constraint recipient_submissions_one_per_recipient
        unique (workspace_id, signing_request_id, request_recipient_id),

      constraint recipient_submissions_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  // ── The adopted representation ──────────────────────────────────────────────
  //
  // Stored ONCE per purpose per submission and referenced by every field that
  // uses it (§65). The ceremony adopts one signature and applies it to every
  // signature field; duplicating the raster per field would multiply the most
  // sensitive bytes in the row set for no reason.
  await sql`
    create table signing_representations (
      representation_id     varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,
      submission_id         varchar(64)  not null,

      purpose               varchar(16)  not null,
      representation_type   varchar(32)  not null,

      -- TYPED_SIGNATURE_V1. typed_style_index selects one of the FOUR
      -- server-known styles; a client cannot name a font, a family or a
      -- stylesheet, because there is nowhere to put one (§60).
      typed_text            varchar(200),
      typed_style_index     integer,

      -- RASTER_SIGNATURE_V1. Decoded bytes, never a data URL - the base64
      -- prefix is transport formatting and is not evidence of anything (§199).
      raster_bytes          bytea,
      raster_media_type     varchar(64),
      raster_width          integer,
      raster_height         integer,

      -- SHA-256 over the bytes AS STORED, or over the canonical typed payload.
      -- A client-supplied hash is a claim; this is computed here (§56).
      digest                varchar(64)  not null,

      constraint signing_representations_purpose_check
        check (purpose in (${inList(REPRESENTATION_PURPOSES)})),
      constraint signing_representations_type_check
        check (representation_type in (${inList(REPRESENTATION_TYPES)})),
      constraint signing_representations_digest_shape
        check (digest ~ '^[a-f0-9]{64}$'),

      -- Exactly one shape is populated, decided by the type. A typed row with
      -- raster bytes, or a raster row with no bytes, cannot exist.
      constraint signing_representations_shape check (
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
      constraint signing_representations_typed_style
        check (typed_style_index is null
               or (typed_style_index >= 0 and typed_style_index <= 3)),
      -- Bounds in the DATABASE, not only in the validator. A validator can be
      -- bypassed by a future caller; a CHECK cannot.
      constraint signing_representations_raster_bounds check (
        raster_bytes is null
        or (octet_length(raster_bytes) > 0
            and octet_length(raster_bytes) <= ${sql.lit(MAX_RASTER_BYTES)}
            and raster_width  between 1 and ${sql.lit(MAX_RASTER_DIMENSION)}
            and raster_height between 1 and ${sql.lit(MAX_RASTER_DIMENSION)})
      ),

      -- One signature and one set of initials per submission.
      constraint signing_representations_one_per_purpose
        unique (submission_id, purpose),

      constraint signing_representations_submission_fk
        foreign key (submission_id)
        references recipient_submissions (submission_id) on delete cascade,
      constraint signing_representations_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  // ── The field values ────────────────────────────────────────────────────────
  await sql`
    create table signing_field_values (
      value_id              varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,
      submission_id         varchar(64)  not null,
      request_field_id      varchar(64)  not null,

      -- The field type AS IT WAS when accepted. The snapshot is immutable so
      -- this cannot drift, and carrying it means a reader never has to join to
      -- know how to interpret the value.
      field_type            varchar(32)  not null,
      value_kind            varchar(16)  not null,
      value_source          varchar(24)  not null,

      text_value            text,
      boolean_value         boolean,
      -- DATE_SIGNED. A UTC instant, never a browser-local date string (§69).
      instant_value         timestamptz,
      representation_id     varchar(64),

      constraint signing_field_values_kind_check
        check (value_kind in (${inList(VALUE_KINDS)})),
      constraint signing_field_values_source_check
        check (value_source in (${inList(VALUE_SOURCES)})),

      -- Exactly one value column, chosen by the kind.
      constraint signing_field_values_shape check (
        (value_kind = 'text'
          and text_value is not null and boolean_value is null
          and instant_value is null and representation_id is null)
        or (value_kind = 'boolean'
          and boolean_value is not null and text_value is null
          and instant_value is null and representation_id is null)
        or (value_kind = 'instant'
          and instant_value is not null and text_value is null
          and boolean_value is null and representation_id is null)
        or (value_kind = 'representation'
          and representation_id is not null and text_value is null
          and boolean_value is null and instant_value is null)
      ),

      -- ONE accepted value per field (§108, §10). Request-field ids are
      -- request-scoped and globally unique, and the workspace and request are
      -- carried anyway so the constraint stays tenant-safe on its face.
      constraint signing_field_values_one_per_field
        unique (workspace_id, signing_request_id, request_field_id),

      -- FOUR columns, and this is the strongest control in the migration.
      --
      -- The value points at an ASSIGNMENT: this field, of this request, in this
      -- workspace, assigned to THIS recipient. Submitting another recipient's
      -- field has no referent - not "fails a check", has no row to point at.
      constraint signing_field_values_assignment_fk
        foreign key (workspace_id, signing_request_id, request_field_id,
                     request_recipient_id)
        references signing_request_fields
          (workspace_id, signing_request_id, request_field_id,
           request_recipient_id),

      constraint signing_field_values_submission_fk
        foreign key (submission_id)
        references recipient_submissions (submission_id) on delete cascade,
      constraint signing_field_values_representation_fk
        foreign key (representation_id)
        references signing_representations (representation_id)
    )
  `.execute(db);

  await sql`
    create index signing_field_values_submission_idx
      on signing_field_values (submission_id)
  `.execute(db);

  // ── Grants ──────────────────────────────────────────────────────────────────
  //
  // SELECT and INSERT. No UPDATE and no DELETE on any of the three.
  //
  // "Accepted signing values are immutable" is therefore not a convention that
  // a future caller could forget - it is a privilege the runtime role does not
  // hold. §11, §120, §186.
  for (const table of [
    "recipient_submissions", "signing_representations", "signing_field_values",
  ]) {
    await sql`grant select, insert on table ${sql.raw(table)} to lagda_app`
      .execute(db);
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);

    // The BACKEND-35 pattern, for the same reason: permissive policies OR, so
    // a narrow permissive policy beside tenant isolation would widen the
    // recipient realm to the whole tenant. RESTRICTIVE ANDs.
    const predicate = `
      ${RECIPIENT_SESSION_DIGEST_FN} is null
      or exists (
        select 1 from recipient_signing_sessions s
        where s.token_digest = ${RECIPIENT_SESSION_DIGEST_FN}
          and s.workspace_id         = ${table}.workspace_id
          and s.signing_request_id   = ${table}.signing_request_id
          and s.request_recipient_id = ${table}.request_recipient_id
      )
    `;
    await sql`
      create policy recipient_submission_scope on ${sql.raw(table)}
      as restrictive
      using (${sql.raw(predicate)})
      with check (${sql.raw(predicate)})
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("signing_field_values").ifExists().execute();
  await db.schema.dropTable("signing_representations").ifExists().execute();
  await db.schema.dropTable("recipient_submissions").ifExists().execute();
  await sql`
    alter table signing_request_fields
      drop constraint if exists signing_request_fields_assignment_key
  `.execute(db);
}
