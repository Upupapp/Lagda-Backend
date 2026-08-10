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
 * ONE ordered list, and it is the only one. Seven integration suites used to
 * carry their own inline cleanup blocks; BACKEND-25 added a table that
 * references `users`, and every one of those blocks then failed on a foreign
 * key in a way that reads like a defect in the feature rather than a fixture
 * that fell behind the schema.
 *
 * Children first, always. Every reference in this schema is ON DELETE RESTRICT
 * — a deliberate choice, because signing evidence and membership history must
 * not vanish when a parent does — which makes deletion order load-bearing here.
 *
 * This runs as the test superuser, which bypasses RLS and the append-only
 * privileges. That is the point: the runtime role CANNOT do this, and a harness
 * that could would have to weaken the controls the tests exist to verify.
 */
export async function truncateAll(database: LagdaDatabase): Promise<void> {
  // ── Tenant-owned data ─────────────────────────────────────────────────────
  //
  // `document_uploads` references BOTH `workspaces` and `document_artifacts`,
  // so it goes before either. Omitting it made every upload test fail on the
  // workspace delete rather than on anything it was testing.
  await database.db.deleteFrom("document_uploads").execute();
  await database.db.deleteFrom("verification_records").execute();
  await database.db.deleteFrom("document_seals").execute();
  await database.db.deleteFrom("evidence_events").execute();
  // Preparation fields cascade from preparations, but delete both explicitly:
  // the order is load-bearing and an implicit cascade hides it.
  // Signing-request snapshots first. Their provenance FKs are SET NULL, so
  // they would not BLOCK a preparation delete - but their own field rows
  // reference their own recipient rows with RESTRICT, so the order within the
  // group is load-bearing.
  await database.db.deleteFrom("signing_request_fields").execute();
  await database.db.deleteFrom("signing_request_recipients").execute();
  await database.db.deleteFrom("signing_requests").execute();
  await database.db.deleteFrom("preparation_fields").execute();
  // Recipients after the fields that reference them: the assignment FK is
  // RESTRICT, so a field still pointing at a recipient blocks its deletion.
  await database.db.deleteFrom("preparation_recipients").execute();
  await database.db.deleteFrom("document_preparations").execute();
  await database.db.deleteFrom("document_artifacts").execute();
  // Documents after their artifacts: `document_artifacts` references
  // `documents` ON DELETE RESTRICT since migration 016.
  await database.db.deleteFrom("documents").execute();
  // Invitations before memberships and workspaces: they reference both
  // `workspaces` and `users`, all ON DELETE RESTRICT.
  await database.db.deleteFrom("workspace_invitations").execute();
  // Contacts reference `workspaces` ON DELETE RESTRICT, so they go before it.
  await database.db.deleteFrom("contacts").execute();
  await database.db.deleteFrom("workspace_memberships").execute();
  await database.db.deleteFrom("workspaces").execute();

  // ── Account-owned data ────────────────────────────────────────────────────
  await database.db.deleteFrom("mfa_recovery_codes").execute();
  await database.db.deleteFrom("pending_authentications").execute();
  await database.db.deleteFrom("mfa_factors").execute();
  await database.db.deleteFrom("password_reset_challenges").execute();
  await database.db.deleteFrom("email_verification_challenges").execute();
  await database.db.deleteFrom("user_sessions").execute();
  await database.db.deleteFrom("users").execute();

  // ── Operational, no foreign keys ──────────────────────────────────────────
  //
  // Cleared so a suite running several idempotent operations does not inherit
  // the previous test's claims. Leaving them made a later test reuse a record
  // id and fail on the primary key, which reads as an idempotency defect and is
  // a fixture leak.
  await database.db.deleteFrom("idempotency_records").execute();
  await database.db.deleteFrom("rate_limit_counters").execute();
}

/**
 * Alias for `truncateAll`, named for what the auth suites are clearing.
 *
 * They call this rather than listing the dependents of `users` themselves, so
 * the next command that adds a table referencing an account makes ONE edit
 * above instead of finding every suite that forgot.
 */
export const truncateAccounts = truncateAll;

/**
 * Creates the minimum account a membership can reference.
 *
 * Every column the schema requires, and nothing more: no password worth
 * anything, no verified email, no profile. Test fixtures that need a REAL
 * account use the registration use case — this exists so a tenancy test can
 * satisfy a foreign key without also exercising Argon2id, which costs ~50ms of
 * dedicated CPU per call by design.
 *
 * `onConflict … doNothing` because several fixtures seed the same user.
 */
export async function seedUser(
  database: LagdaDatabase,
  userId: string,
  overrides: { readonly email?: string } = {},
): Promise<void> {
  const email = overrides.email ?? `${userId}@fixture.invalid`;
  await database.db
    .insertInto("users")
    .values({
      user_id: userId,
      email,
      normalized_email: email.toLowerCase(),
      // Argon2id-SHAPED but not a hash of anything. The `users_password_argon2id`
      // CHECK requires the prefix, and satisfying it with a real hash would cost
      // ~50ms of dedicated CPU per fixture for a credential no test ever
      // presents. Anything that signs in registers properly instead.
      password_hash: "$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZQ$bm90LWEtcmVhbC1oYXNo",
      display_name: userId,
      organization: null,
      intended_use: null,
      email_verified_at: null,
      terms_version: "fixture",
      terms_accepted_at: new Date(0),
      full_name: null,
      job_title: null,
      department: null,
      preferred_sender_name: null,
      timezone: null,
      locale: null,
      language: null,
      date_format: null,
      time_format: null,
      number_format: null,
      appearance: null,
      density: null,
      document_list_view: null,
      profile_updated_at: null,
    })
    .onConflict(oc => oc.column("user_id").doNothing())
    .execute();
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
