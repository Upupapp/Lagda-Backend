// 054 — bind a sign-in handoff intent to the ceremony session that asked.
//
// ── Why this is not an edit to 051 ────────────────────────────────────────
//
// It was, briefly, and that was wrong in a way worth writing down: 051 is
// already applied in production. An applied migration has run; editing it
// changes only the file, so the column would have existed on a developer's
// freshly-migrated database and nowhere else. The code that depends on it
// would compile, pass every test, deploy, and fail on the first real request
// — and the failure would look like a runtime bug rather than a schema that
// was never created.
//
// The rule is not "prefer a new migration". It is that an applied migration
// is a historical record of what a database was asked to do, and changing
// history does not change the database.
//
// ── What this fixes ───────────────────────────────────────────────────────
//
// `signing_link_intents` recorded which recipient of which request an intent
// was for, but not which BROWSER asked. A signing link can be forwarded, and
// the credential in it proves the holder may open the document — not that
// they are the person whose account is about to be verified.
//
// Without this column, whatever a claim produced would belong to the
// recipient at large: anyone holding a forwarded link afterwards would
// inherit it. With it, a claim can be tied back to the one session that
// started the handoff.
//
// ── Why NOT NULL with a backfill ──────────────────────────────────────────
//
// Existing rows are handoff intents that were minted before sessions were
// recorded. They are at most two minutes old by construction and every one of
// them is spent or expired, so there is no live handoff to preserve — they are
// backfilled with a value that cannot match any real session, which makes them
// unusable rather than ambiguous.
//
// Refusing to match is the correct behaviour for a credential whose
// provenance is unknown. The alternative, a nullable column treated as
// "matches anything", would turn every historical row into a skeleton key.

import { sql, type Kysely } from "kysely";

/**
 * Deliberately not a session id shape. Nothing can present this, which is the
 * point: a pre-existing intent must fail the comparison, not pass it.
 */
const UNKNOWN_SESSION = "session-unknown-pre-054";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_link_intents
      add column recipient_session_id varchar(64)
  `.execute(db);

  await sql`
    update signing_link_intents
       set recipient_session_id = ${sql.lit(UNKNOWN_SESSION)}
     where recipient_session_id is null
  `.execute(db);

  await sql`
    alter table signing_link_intents
      alter column recipient_session_id set not null
  `.execute(db);

  // No grant statement: 051 granted select/insert/update/delete on this table,
  // and a column is not a grantable object. Stated rather than assumed —
  // migration 048 exists because 047 created an object and forgot its grants,
  // and the omission surfaced only in production.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_link_intents
      drop column if exists recipient_session_id
  `.execute(db);
}
