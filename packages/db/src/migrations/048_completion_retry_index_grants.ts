// 048 — grants the runtime role access to the completion retry index.
//
// ── The defect this closes ─────────────────────────────────────────────────
//
// Migration 047 created `signing_request_completion_retry_index`, its
// trigger and its backfill, and never granted anything on it. Migration 041
// grants `select, insert, update, delete ... to lagda_app` for the expiry
// index it creates, and 034 does the same for the dispatch index; 047 simply
// omitted the statement.
//
// The table was therefore readable only by its owner, so the `completion.retry`
// sweep failed on every tick with:
//
//   permission denied for table signing_request_completion_retry_index
//
// Observed in production, not inferred: the schedule fired every two minutes
// and each job failed with that message, `errorCategory: "retryable"`, so the
// recovery path 047 exists to provide was itself unable to run.
//
// ── Why the test suite did not catch it ────────────────────────────────────
//
// `completion-retry.integration.test.ts` connects as the OWNER of the schema.
// Owners are not subject to grants, so every query in that suite succeeded
// while the runtime role could not read the table at all. The suite proves
// the trigger's arithmetic, the claim's concurrency and the sweep's logic —
// none of which involve a privilege check.
//
// The harness now exposes `createRuntimeRoleDatabase()`, which connects as a
// dedicated role that inherits `lagda_app`; the accompanying test change uses
// it to read this index as the runtime role, so a missing grant fails a test
// rather than a production tick.
//
// ── Why the same verbs as 041 ──────────────────────────────────────────────
//
// The sweep only reads, so `select` alone would serve it today. 041 and 034
// both grant the full set on their index tables because the TRIGGER that
// maintains the rows runs as the caller of the statement that fired it — the
// runtime role, when the application writes a completion run — and so needs
// insert, update and delete on the index as well. 047's trigger has exactly
// that shape, which makes the narrower grant a latent second failure: the
// sweep would read fine and `ensureRun` would then fail on the trigger's own
// insert.

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    grant select, insert, update, delete
      on table signing_request_completion_retry_index to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    revoke select, insert, update, delete
      on table signing_request_completion_retry_index from lagda_app
  `.execute(db);
}
