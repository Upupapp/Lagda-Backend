// Integration test harness — REAL PostgreSQL.
//
// Not a fake. SQLite would not exercise `timestamptz`, compound unique
// constraints, CHECK constraints, transaction semantics or SQLSTATE codes, so
// passing against it would prove nothing about production.
//
// Isolation is by TRUNCATE between tests rather than a database per suite:
// it is fast, deterministic, and leaves the schema in place so migration state
// is exercised once rather than per test.

import { createDatabase, type LagdaDatabase } from "../client/index.js";
import { loadDatabaseConfig } from "../config/index.js";
import { migrateToLatest } from "../migrations/runner.js";

/**
 * Set when the integration database is reachable. Suites skip otherwise.
 *
 * This is the one place outside `config/` that reads the environment, and it is
 * TEST-ONLY infrastructure — never imported by a repository. A repository that
 * read the environment would behave differently depending on where it ran.
 */
export const INTEGRATION_DATABASE_URL = process.env["DATABASE_TEST_URL"];

export const hasIntegrationDatabase = (): boolean =>
  INTEGRATION_DATABASE_URL !== undefined && INTEGRATION_DATABASE_URL !== "";

/**
 * Connects and migrates from whatever state the test database is in.
 *
 * Guarded: the URL must name a database that looks like a test database. A
 * harness that truncates tables must never be pointable at a development or
 * production database by an unlucky environment variable.
 */
export async function createTestDatabase(): Promise<LagdaDatabase> {
  const url = INTEGRATION_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("DATABASE_TEST_URL is not set.");
  }

  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run destructive tests against "${name}" — ` +
        `the database name must contain "test".`,
    );
  }

  const database = createDatabase(loadDatabaseConfig({ DATABASE_URL: url }));
  const outcome = await migrateToLatest(database.db);
  if (outcome.error) {
    await database.close();
    throw outcome.error;
  }
  return database;
}

/**
 * Empties every table between tests.
 *
 * Child tables first: the membership foreign key is ON DELETE RESTRICT, so
 * truncating workspaces first would fail — which is itself confirmation the
 * constraint is doing its job.
 */
export async function truncateAll(database: LagdaDatabase): Promise<void> {
  // Child-first, because every evidence relation is ON DELETE RESTRICT — a
  // deliberate choice (signing evidence must not vanish when a parent does), and
  // one that makes deletion order load-bearing here.
  //
  // This runs as the test superuser, which bypasses RLS and the append-only
  // privileges. That is the point: the runtime role CANNOT do this, and a
  // harness that could not clean up would have to weaken the very controls the
  // tests exist to verify.
  await database.db.deleteFrom("verification_records").execute();
  await database.db.deleteFrom("document_seals").execute();
  await database.db.deleteFrom("evidence_events").execute();
  await database.db.deleteFrom("document_artifacts").execute();
  await database.db.deleteFrom("workspace_memberships").execute();
  await database.db.deleteFrom("workspaces").execute();
}

// ── Privileged test-only access ──────────────────────────────────────────────

import { sql, type Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type { Database } from "../schema/index.js";

/**
 * Runs raw SQL inside a tenant transaction. **Test-only.**
 *
 * Production code cannot obtain a raw transaction: the unit of work builds
 * repositories internally and hands out no handle. That is deliberate — a raw
 * handle is a way to write an unscoped query.
 *
 * Tenancy tests need it precisely to write the queries production cannot: a
 * SELECT with no predicate at all, an INSERT naming another workspace. Those
 * assertions are how we know RLS is doing its job rather than the repository's.
 *
 * Exported from the testing module only, never from the package entry point.
 */
export async function withRawTenantTransaction<T>(
  database: LagdaDatabase,
  workspaceId: WorkspaceId,
  operation: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return database.db.transaction().execute(async trx => {
    await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
    return operation(trx);
  });
}

/** As above, with NO tenant context — for fail-closed assertions. */
export async function withRawGlobalTransaction<T>(
  database: LagdaDatabase,
  operation: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return database.db.transaction().execute(trx => operation(trx));
}
