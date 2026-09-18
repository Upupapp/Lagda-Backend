// 045 — corrects `verification_records_format_check` to the verification-id
// format the product actually issues and accepts.
//
// ── The bug this closes ─────────────────────────────────────────────────────
//
// Migration 003 encoded handoff §15's format — `LAGDA-{workspace}-{date}-
// {random}` — as `^LAGDA-[A-Za-z0-9]+-[0-9]{8}-[A-Za-z0-9]{6,}$`, with the
// stated purpose that "a database serial or a guessable value cannot be
// stored as one". That purpose is right and this migration keeps it.
//
// The FORMAT moved on twice afterwards, in the application, deliberately:
//
//   1. The workspace segment became the literal `VER`. Encoding tenancy in a
//      published identifier is a disclosure — two references would reveal
//      whether they came from the same tenant — so both generators drop it
//      (see verification-id.ts's own comment). The old pattern's
//      `[A-Za-z0-9]+` accepted `VER` happily, so this change slipped through
//      unnoticed.
//
//   2. The date segment became a four-digit YEAR rather than a YYYYMMDD
//      date. This did NOT slip through: `[0-9]{8}` cannot match `2026`, so
//      every verification record insert was refused.
//
// The effect was that `final-seal` — the last step of the completion
// pipeline — failed on every attempt. Verified against production: with
// migration 044 in place the run reached `stepsCompleted: 2` (field-merge
// and certificate both succeeded and produced real artifacts) and then
// failed at `final-seal`, and probing the step's writes as the runtime role
// reproduced `violates check constraint "verification_records_format_check"`
// on the verification record. Like the artifact-type defect before it, the
// failure was reported as `database-unavailable` because the step maps any
// throw in its persistence transaction to that one code.
//
// ── Why the CONSTRAINT moves and the generators do not ─────────────────────
//
// Three places define this identifier and two of them already agree:
//
//   * `packages/security/src/completion-identifiers.ts` (the worker's, on the
//     completion path) and `packages/api/src/security/verification-id.ts`
//     both mint `LAGDA-VER-{4-digit year}-{10 random chars}`.
//   * The product's own validator, which decides what a human may type into
//     the public verify page, is `/^LAGDA-VER-\d{4}-\w{4,10}$/i`
//     (`Lagda-Web-Platform/src/app/services/public/index.ts`).
//
// So the four-digit year is the live, two-sided contract, and the database is
// the one party still enforcing the superseded shape. Widening the generators
// to eight digits would satisfy this CHECK and simultaneously break the
// verify page's own input validation — the identifier is PUBLIC and typed by
// people, which makes the frontend's regex the authority here, not the
// handoff draft.
//
// This is a correction, not a relaxation. The new pattern is STRICTER than
// the old one in the segment that carries meaning (`VER` is now literal
// where any alphanumeric run was accepted), and unchanged in the segment that
// carries the security property: at least six characters of the generators'
// 55-symbol rejection-sampled alphabet, against which a serial (`12345`) or a
// guessable value still cannot be stored.
//
// No data migration accompanies this: `verification_records` is empty,
// because the constraint it is written against never permitted a single row.

import { sql, type Kysely } from "kysely";

const CONSTRAINT = "verification_records_format_check";

/**
 * What both generators mint and the public verify page accepts.
 *
 * The suffix floor stays at six rather than the generators' ten, and rather
 * than the frontend's four: the database should not reject an identifier the
 * product would accept from a user, and should not depend on the exact
 * suffix length a generator happens to use today.
 */
const FORMAT = "^LAGDA-VER-[0-9]{4}-[A-Za-z0-9]{6,}$";

/** Migration 003's, restored by `down`. */
const OLD_FORMAT = "^LAGDA-[A-Za-z0-9]+-[0-9]{8}-[A-Za-z0-9]{6,}$";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table verification_records
      drop constraint if exists ${sql.ref(CONSTRAINT)}
  `.execute(db);
  await sql`
    alter table verification_records
      add constraint ${sql.ref(CONSTRAINT)}
      check (verification_id ~ ${FORMAT})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores the shape that refused every insert, the same way 043's and
  // 044's `down` restore the states they exist to correct. Any row written
  // under `up` would violate it, so those go first — there is no translation
  // from a year to a date that would not be an invention.
  await sql`
    delete from verification_records where verification_id !~ ${OLD_FORMAT}
  `.execute(db);
  await sql`
    alter table verification_records
      drop constraint if exists ${sql.ref(CONSTRAINT)}
  `.execute(db);
  await sql`
    alter table verification_records
      add constraint ${sql.ref(CONSTRAINT)}
      check (verification_id ~ ${OLD_FORMAT})
  `.execute(db);
}
