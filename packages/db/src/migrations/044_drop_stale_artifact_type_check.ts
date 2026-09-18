// 044 — removes the stale `artifact_type` CHECK that migration 026 meant to
// replace and silently left behind.
//
// ── The bug this closes ─────────────────────────────────────────────────────
//
// Migration 003 created `document_artifacts` with an INLINE constraint named
// `document_artifacts_type_check`, admitting three values: `original`,
// `sealed`, `completion-certificate`.
//
// Migration 026 widened the vocabulary by one (`merged-candidate`, the
// intermediate the `field-merge` completion step produces). It did so with
// the usual drop-then-add pair — but dropped
// `document_artifacts_artifact_type_check`, which had never existed. The
// `if exists` guard turned that name mismatch into a silent no-op instead of
// an error, so 026 ADDED a second, wider constraint beside 003's narrower
// one rather than replacing it.
//
// A row must satisfy EVERY check constraint on its table. The surviving
// three-value constraint therefore rejected every `merged-candidate` insert,
// which is the only artifact the merge step can write — so no signing
// request could ever complete. Verified against production before writing
// this migration: both constraints were present on `document_artifacts`, and
// the one completion run that had reached the merge step sat in
// `waiting-retry` with `failure_step = 'field-merge'`.
//
// The failure surfaced as `failure_code = 'database-unavailable'` because the
// merge step wraps its whole persistence transaction in one catch that maps
// any throw to that code. The bytes had already been uploaded; only the row
// was refused. A deterministic schema fault was therefore reported as a
// transient infrastructure one and retried forever, which is why the run
// never progressed and never gave up.
//
// ── Why the tests did not catch it ─────────────────────────────────────────
//
// The completion steps are unit-tested against an in-memory artifact store
// with no CHECK constraints, so the application's vocabulary and the
// database's could drift without any test disagreeing. Migration 026's own
// integration test asserted the constraint IT added, never that 003's was
// gone. `artifact-type-vocabulary.integration.test.ts` closes that gap by
// asserting the real table accepts every application type and rejects
// anything else.
//
// ── What `up` does, and why it rewrites both ───────────────────────────────
//
// Dropping the stale constraint alone would be enough on any database that
// has run 026. It also rewrites the canonical constraint from the vocabulary
// declared here, so the end state is the same whichever constraints a given
// database happens to carry, and so re-running this migration is harmless.
// Neither statement widens what the column admits beyond 026's intent.

import { sql, type Kysely } from "kysely";

/**
 * The authoritative `artifact_type` vocabulary, as of 026.
 *
 * Declared locally rather than imported from the application layer: a
 * migration describes the schema at a point in time and must not change
 * meaning when a constant elsewhere is edited later. The integration test is
 * what keeps this list and the application's `ARTIFACT_TYPES` honest with
 * each other.
 */
const ARTIFACT_TYPES = [
  "original", "sealed", "completion-certificate", "merged-candidate",
] as const;

/** Migration 003's narrower list, restored by `down`. */
const STALE_ARTIFACT_TYPES = ["original", "sealed", "completion-certificate"] as const;

/** The name 003 gave its inline constraint — the one that should not survive. */
const STALE_CONSTRAINT = "document_artifacts_type_check";

/** The name 026 introduced, and the one that stays. */
const CANONICAL_CONSTRAINT = "document_artifacts_artifact_type_check";

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // The stale one. No data migration is needed or possible: every row that
  // exists already satisfies the NARROWER list (that is precisely why it
  // could be written), so dropping it cannot invalidate anything.
  await sql`
    alter table document_artifacts
      drop constraint if exists ${sql.ref(STALE_CONSTRAINT)}
  `.execute(db);

  // The canonical one, rewritten from this file's vocabulary so the end
  // state does not depend on which constraints were present beforehand.
  await sql`
    alter table document_artifacts
      drop constraint if exists ${sql.ref(CANONICAL_CONSTRAINT)}
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint ${sql.ref(CANONICAL_CONSTRAINT)}
      check (artifact_type in (${inList(ARTIFACT_TYPES)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores the duplicate-constraint state faithfully, the same way 043's
  // `down` restores the foreign keys whose absence it exists to arrange.
  // Reverting this migration REINTRODUCES the completion blocker; that is
  // what reverting it means.
  //
  // `merged-candidate` rows have to go first, for the same reason 026's own
  // `down` removes them: the narrower constraint cannot be added while a row
  // violates it, so a `down` that skipped this would simply fail on data
  // `up` legitimately permitted. Only the merge INTERMEDIATE is affected —
  // `sealed` and `completion-certificate` artifacts, which are what a
  // completed request is actually made of, are left untouched.
  await sql`
    delete from document_artifacts where artifact_type = 'merged-candidate'
  `.execute(db);

  await sql`
    alter table document_artifacts
      drop constraint if exists ${sql.ref(CANONICAL_CONSTRAINT)}
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint ${sql.ref(CANONICAL_CONSTRAINT)}
      check (artifact_type in (${inList(STALE_ARTIFACT_TYPES)}))
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint ${sql.ref(STALE_CONSTRAINT)}
      check (artifact_type in (${inList(STALE_ARTIFACT_TYPES)}))
  `.execute(db);
}
