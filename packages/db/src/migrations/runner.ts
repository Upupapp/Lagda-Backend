// Migration runner.
//
// Migrations are an EXPLICIT DEPLOYMENT STEP, never something the API does on
// boot. If every process migrated at startup, a rolling deploy would have
// several instances racing the same schema change, and a schema change would
// happen at whatever moment a container restarted.

import type { Kysely } from "kysely";
import { Migrator, type MigrationProvider, type Migration } from "kysely/migration";
import type { Database } from "../schema/index.js";
import * as m001 from "./001_workspaces.js";
import * as m002 from "./002_tenancy_rls.js";
import * as m003 from "./003_evidence_and_integrity.js";
import * as m004 from "./004_sessions.js";
import * as m005 from "./005_idempotency.js";
import * as m006 from "./006_rate_limits.js";
import * as m007 from "./007_document_uploads.js";
import * as m008 from "./008_users_and_verification.js";
import * as m009 from "./009_verification_supersession.js";
import * as m010 from "./010_password_reset_challenges.js";
import * as m011 from "./011_mfa_and_pending_auth.js";
import * as m012 from "./012_user_profile.js";
import * as m013 from "./013_workspace_lifecycle.js";
import * as m014 from "./014_workspace_invitations.js";
import * as m015 from "./015_contacts.js";
import * as m016 from "./016_documents.js";

/**
 * Migrations listed explicitly rather than read from disk.
 *
 * Filesystem discovery breaks once the package is compiled to `dist`, and it
 * makes ordering depend on directory listing. An explicit map is ordered by the
 * key, reviewable in a diff, and works identically from source and from build
 * output.
 *
 * Names are zero-padded so lexical order is execution order.
 */
const MIGRATIONS: Record<string, Migration> = {
  "001_workspaces": m001,
  "002_tenancy_rls": m002,
  "003_evidence_and_integrity": m003,
  "004_sessions": m004,
  "005_idempotency": m005,
  "006_rate_limits": m006,
  "007_document_uploads": m007,
  "008_users_and_verification": m008,
  "009_verification_supersession": m009,
  "010_password_reset_challenges": m010,
  "011_mfa_and_pending_auth": m011,
  "012_user_profile": m012,
  "013_workspace_lifecycle": m013,
  "014_workspace_invitations": m014,
  "015_contacts": m015,
  "016_documents": m016,
};

class ExplicitMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(MIGRATIONS);
  }
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly error?: Error;
}

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: new ExplicitMigrationProvider() });
}

/**
 * Applies pending migrations.
 *
 * Kysely tracks applied migrations in `kysely_migration` and takes a lock in
 * `kysely_migration_lock`, so two deploys running this concurrently cannot
 * apply the same migration twice. Running it when nothing is pending is a
 * no-op, which is what makes it safe in a deployment pipeline.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<MigrationOutcome> {
  const { error, results } = await migrator(db).migrateToLatest();
  const applied = (results ?? [])
    .filter(r => r.status === "Success")
    .map(r => r.migrationName);

  // Errors are surfaced, never swallowed. A deployment must stop on a failed
  // migration rather than start an application against a half-migrated schema.
  return error === undefined ? { applied } : { applied, error: asError(error) };
}

/**
 * Kysely types a migration failure as `unknown`. `String(error)` on a non-Error
 * object yields "[object Object]", which would replace a real diagnostic with
 * nothing — so the value is serialized deliberately.
 */
function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(`Migration failed: ${JSON.stringify(value)}`);
}

export interface MigrationStatus {
  readonly name: string;
  readonly applied: boolean;
}

export async function migrationStatus(db: Kysely<Database>): Promise<readonly MigrationStatus[]> {
  const rows = await migrator(db).getMigrations();
  return rows.map(row => ({ name: row.name, applied: row.executedAt !== undefined }));
}

/**
 * Rolls back the most recent migration.
 *
 * Present for local development. Most production migrations are NOT safely
 * reversible — a migration that drops a column cannot restore the data — so
 * production rollback is a restore-from-backup question, not a `down` question.
 */
export async function migrateDown(db: Kysely<Database>): Promise<MigrationOutcome> {
  const { error, results } = await migrator(db).migrateDown();
  const applied = (results ?? [])
    .filter(r => r.status === "Success")
    .map(r => r.migrationName);
  return error === undefined ? { applied } : { applied, error: asError(error) };
}
