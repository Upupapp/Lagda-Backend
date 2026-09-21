// 052 — how a signature was captured.
//
// ── The thing this fixes ──────────────────────────────────────────────────
//
// `signing_representations.representation_type` says what a mark IS —
// TYPED_SIGNATURE_V1 or RASTER_SIGNATURE_V1 — and nothing about how it came to
// exist. So an image a signer uploaded and an image a signer drew on the pad
// are stored identically, and the audit trail reports both as the same act.
//
// They are not the same act. Drawing is done in the moment, in front of the
// document. Uploading is reusing a picture made earlier, somewhere else. If a
// signature is ever disputed, that difference is the difference.
//
// ── A column, not a third representation type ─────────────────────────────
//
// Adding a value to `representation_type` was the obvious move and would have
// been a bad one. `completion.ts` maps representation rows for the merge and
// ends with `throw new Error('Unsupported representation type: ...')`, so a
// third value would pass submission and then fail in the completion pipeline
// — after the signer had closed the tab. The failure would land on the one
// person who could no longer do anything about it.
//
// A nullable column widens nothing. Old rows read NULL, which says exactly
// what is true of them: they were written before anyone recorded this.
//
// ── Why nullable rather than defaulted ────────────────────────────────────
//
// A default would backfill a claim onto rows nobody made it about. There are
// existing signatures in this database whose capture method is genuinely
// unknown, and the honest record of an unknown is NULL — not a plausible
// guess that reads, forever after, as though it had been observed.
//
// `signing_representations` has no UPDATE grant, so those rows could not be
// corrected later even if someone wanted to. That is the right posture for
// evidence and it is also why the value has to be right the first time.
//
// ── What each value means, and how much to trust it ───────────────────────
//
//   typed-live          the signer typed it here, now
//   drawn-live          the signer drew it here, now
//   uploaded-live       the signer uploaded an image here, now
//   applied-from-saved  a signature the account had stored earlier was applied
//
// The first three are the CLIENT's account of what the signer did. A client
// could misreport them; nothing here can tell a drawn stroke from an uploaded
// one once both are PNGs. They are honest reporting from an honest client,
// which is worth having and is not a security control.
//
// `applied-from-saved` is different: the server decides it, because only the
// server knows whether it took the bytes from a stored signature. That is the
// one value a dispute would turn on, and it is the one that cannot be claimed.

import { sql, type Kysely } from "kysely";

const CAPTURE_PROVENANCE = [
  "typed-live",
  "drawn-live",
  "uploaded-live",
  "applied-from-saved",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_representations
      add column capture_provenance varchar(32)
  `.execute(db);

  await sql`
    alter table signing_representations
      add constraint signing_representations_capture_provenance_check
      check (capture_provenance is null or capture_provenance in (${
        sql.join(CAPTURE_PROVENANCE.map(value => sql.lit(value)))
      }))
  `.execute(db);

  // No grant statement: 023 already granted select and insert on this table,
  // and a column is not a grantable object. Stated rather than assumed,
  // because migration 048 exists precisely because 047 created an object and
  // forgot its grants, and the omission surfaced only in production.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_representations
      drop constraint if exists signing_representations_capture_provenance_check
  `.execute(db);
  await sql`
    alter table signing_representations
      drop column if exists capture_provenance
  `.execute(db);
}
