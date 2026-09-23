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
 * The dedicated role the RLS suites connect as.
 *
 * NOT `lagda_app`. Twelve suites used to run
 * `alter role lagda_app with login password 'lagda_app_test'` so they could
 * connect as the runtime role — and a PostgreSQL role is CLUSTER-wide, not
 * per-database. Running the suite against a test DATABASE that happened to
 * live on the production CLUSTER therefore overwrote the production role's
 * password with a literal from source control, and the worker lost its
 * database access on its next restart. That is not a hypothetical: it
 * happened.
 *
 * This role is a MEMBER of `lagda_app`, which is what makes it an honest
 * stand-in: the tenancy policies are defined `on <table> using (...)` with no
 * role named, so they apply to every role, and the PRIVILEGES that decide
 * what the runtime may touch arrive through the membership. It is not a table
 * owner and has no BYPASSRLS, so `force row level security` binds it exactly
 * as it binds `lagda_app` in production.
 */
const TEST_RUNTIME_ROLE = "lagda_test_runtime";

/**
 * Its password. Test-only, and safe to keep here for the same reason the old
 * one was not: this role exists ONLY on a cluster that has already proved it
 * holds no production database (see `assertSafeTestCluster`), and the
 * production role is never touched.
 */
const TEST_RUNTIME_PASSWORD = "lagda_test_runtime_local_only";

/**
 * Refuses to go any further if this looks like a production cluster.
 *
 * ── Why the database NAME is not enough ────────────────────────────────────
 *
 * The name check below has always been here, and it passed: the database was
 * called `lagda_test`. What it could not see is that `lagda_test` had been
 * created on the cluster that also hosts `lagda_prod` — and roles, unlike
 * tables, are shared across every database in a cluster. So the guard has to
 * ask about the CLUSTER, not only about the connection.
 *
 * Runs BEFORE `migrateToLatest` and before any role or schema statement, so a
 * developer who points the suite at production gets a hard failure rather
 * than a modified role.
 */
async function assertSafeTestCluster(database: LagdaDatabase, name: string): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Refusing to run integration tests with NODE_ENV=production.",
    );
  }

  const { rows } = await sql<{ datname: string }>`
    select datname from pg_database where not datistemplate
  `.execute(database.db);

  // Anything that looks like a production database, INCLUDING a sibling this
  // connection is not pointed at. This is the check that would have stopped
  // the incident.
  const productionLooking = rows
    .map(row => row.datname)
    .filter(datname => /prod/i.test(datname));

  if (productionLooking.length > 0) {
    throw new Error(
      `Refusing to run integration tests: the cluster reached via `
      + `DATABASE_TEST_URL also hosts ${productionLooking.join(", ")}. `
      + `PostgreSQL ROLES are cluster-wide, so this suite would modify roles `
      + `that production depends on even though it is connected to "${name}". `
      + `Point DATABASE_TEST_URL at an isolated test cluster.`,
    );
  }
}

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

  // BEFORE any migration, role change or schema statement.
  try {
    await assertSafeTestCluster(database, name);
  } catch (error) {
    await database.close();
    throw error;
  }

  const outcome = await migrateToLatest(database.db);
  if (outcome.error) {
    await database.close();
    throw outcome.error;
  }
  return database;
}

/**
 * A connection as a runtime-equivalent role, for the RLS suites.
 *
 * Replaces the `alter role lagda_app with login password '...'` that twelve
 * suites each carried. Creates a dedicated role that INHERITS `lagda_app`
 * rather than becoming it, so:
 *
 *   * the production role's password is never written, on any cluster;
 *   * the privileges under test are still exactly `lagda_app`'s, because
 *     they arrive through role membership;
 *   * `force row level security` still applies, because this role owns
 *     nothing and holds no BYPASSRLS.
 *
 * Idempotent: safe to call from every suite's `beforeAll`.
 */
export async function createRuntimeRoleDatabase(
  owner: LagdaDatabase,
): Promise<LagdaDatabase> {
  const url = INTEGRATION_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("DATABASE_TEST_URL is not set.");
  }

  await sql`
    do $$
    begin
      if not exists (
        select 1 from pg_roles where rolname = ${sql.lit(TEST_RUNTIME_ROLE)}
      ) then
        create role ${sql.raw(TEST_RUNTIME_ROLE)}
          login password ${sql.lit(TEST_RUNTIME_PASSWORD)} in role lagda_app;
      else
        alter role ${sql.raw(TEST_RUNTIME_ROLE)}
          with login password ${sql.lit(TEST_RUNTIME_PASSWORD)};
      end if;
    end
    $$;
  `.execute(owner.db);

  // Membership may predate a later `grant ... to lagda_app`, so re-assert it
  // rather than assuming the role was created after every grant it needs.
  await sql`
    grant lagda_app to ${sql.raw(TEST_RUNTIME_ROLE)}
  `.execute(owner.db);

  const asRuntime = new URL(url);
  asRuntime.username = TEST_RUNTIME_ROLE;
  asRuntime.password = TEST_RUNTIME_PASSWORD;
  return createDatabase(loadDatabaseConfig({ DATABASE_URL: asRuntime.toString() }));
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
  // ── Notifications FIRST (BACKEND-44, BACKEND-45) ──────────────────────────
  //
  // They were MISSING ENTIRELY, and that single omission failed thirteen tests
  // in one suite: intents survived between cases, so the second insert of a
  // fixture id hit `notification_intents_pkey`, and the failures read as
  // idempotency and claiming defects rather than as dirty state.
  //
  // First because they are the most dependent rows in the schema: an intent
  // references the workspace, the user and the RECIPIENT, so
  // "refuses to delete a recipient with an outstanding notification" is a real
  // constraint this list has to unwind rather than trip over.
  //
  // The dispatch index cascades from deliveries, and is deleted explicitly
  // anyway -- the same rule this file already states for preparation fields:
  // the order is load-bearing and an implicit cascade hides it.
  await database.db.deleteFrom("notification_delivery_attempts").execute();
  await database.db.deleteFrom("notification_dispatch_index").execute();
  await database.db.deleteFrom("notification_deliveries").execute();
  await database.db.deleteFrom("notification_intents").execute();

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
  // SIGNING VALUES FIRST, and the order inside this group is load-bearing
  // twice over: a value references its representation, and BOTH reference the
  // field ASSIGNMENT with the default RESTRICT. A `signing_request_fields`
  // delete with values still pointing at it fails outright - which is exactly
  // what the four-column assignment key is for, and exactly why it has to be
  // unwound in the reverse order it was built (BACKEND-36).
  // COMPLETION FIRST of all (BACKEND-38). The completion record references the
  // run, the final artifact and the request - all with RESTRICT - and the run
  // references the request the same way. So the whole completion group has to
  // come off before anything it points at, and the order inside it is the
  // reverse of the order it is built in.
  await database.db.deleteFrom("signing_request_completions").execute();
  await database.db.deleteFrom("signing_request_completion_steps").execute();
  await database.db.deleteFrom("signing_request_completion_runs").execute();
  // BACKEND-37's advance intents carry no foreign key at all - they hold
  // identifiers and nothing else - but they are removed here so a truncated
  // fixture leaves no work behind for a reconciler to pick up.
  await database.db.deleteFrom("signing_workflow_advance_intents").execute();
  // ACTIVATION BEFORE SUBMISSIONS (BACKEND-37). The workflow row names the
  // submission it took its signing timestamp from, through the four-column
  // foreign key, with the default RESTRICT - so a submission cannot be deleted
  // while a signed recipient still cites it. The constraint that makes
  // "signedAt came from THIS submission" checkable is the same one that makes
  // this ordering load-bearing.
  // Cascades from `signing_requests`, and deleted explicitly for the reason
  // above. A stranded index row would send the expiry sweep into a workspace
  // to act on a request that no longer exists.
  await database.db.deleteFrom("signing_request_expiry_index").execute();
  await database.db.deleteFrom("signing_request_recipient_activation").execute();
  await database.db.deleteFrom("signing_field_values").execute();
  await database.db.deleteFrom("signing_representations").execute();
  await database.db.deleteFrom("recipient_submissions").execute();
  // Ceremony progress and consent cascade from the recipient, but delete them
  // explicitly for the same reason the comment above gives.
  await database.db.deleteFrom("signing_recipient_consents").execute();
  await database.db.deleteFrom("signing_recipient_progress").execute();
  await database.db.deleteFrom("recipient_signing_sessions").execute();
  // Send artefacts next. The delivery intent references the grant with
  // RESTRICT, so the grant cannot go before it.
  await database.db.deleteFrom("signing_access_grants").execute();
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
  // Workflow templates (migration 058) reference `workspaces` and `users`, both
  // ON DELETE RESTRICT. Nothing references THEM — that is the snapshot rule —
  // so they need no ordering among themselves. Its own field placements
  // (060) CASCADE from it, so no separate delete is needed for those.
  await database.db.deleteFrom("workflow_template_fields").execute();
  // Variables AFTER fields, and this one is not optional. A field references
  // its variable ON DELETE RESTRICT (064), so deleting variables first fails
  // outright while any bound field is still present. It is also the same order
  // the repository uses when saving a template, and for the same reason.
  await database.db.deleteFrom("workflow_template_variables").execute();
  await database.db.deleteFrom("workspace_workflow_templates").execute();
  // Organization units (039, titles added in 061). Members before units:
  // `organization_unit_members` CASCADEs from both `organization_units` and
  // `workspace_memberships`, so either delete below would take it with them
  // — deleted explicitly anyway, matching every other table in this
  // function, rather than leaning on a cascade nothing here states.
  await database.db.deleteFrom("organization_unit_members").execute();
  await database.db.deleteFrom("organization_units").execute();
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
