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
import * as m017 from "./017_document_preparation.js";
import * as m018 from "./018_preparation_recipients.js";
import * as m019 from "./019_signing_requests.js";
import * as m020 from "./020_signing_request_send.js";
import * as m021 from "./021_recipient_signing_access.js";
import * as m022 from "./022_signing_ceremony.js";
import * as m023 from "./023_signature_submission.js";
import * as m024 from "./024_signing_state.js";
import * as m025 from "./025_completion_pipeline.js";
import * as m026 from "./026_completion_steps.js";
import * as m027 from "./027_completion_failure_codes.js";
import * as m028 from "./028_signing_request_completed.js";
import * as m029 from "./029_evidence_event_provenance.js";
import * as m030 from "./030_notifications.js";
import * as m031 from "./031_retire_signing_delivery_intents.js";
import * as m032 from "./032_notification_audience_integrity.js";
import * as m033 from "./033_notification_delivery_attempts.js";
import * as m034 from "./034_notification_dispatch_index.js";
import * as m035 from "./035_password_reset_sealed_credential.js";
import * as m036 from "./036_invitation_sealed_credential.js";
import * as m037 from "./037_verification_sealed_credential.js";
import * as m038 from "./038_retire_mfa_otp_notification.js";
import * as m039 from "./039_organization_units.js";
import * as m040 from "./040_document_folders.js";
import * as m041 from "./041_signing_request_expiry.js";
import * as m042 from "./042_signing_request_ready_to_send.js";
import * as m043 from "./043_drop_immutable_artifact_fks.js";
import * as m044 from "./044_drop_stale_artifact_type_check.js";
import * as m045 from "./045_verification_id_format.js";
import * as m046 from "./046_database_rejected_failure_code.js";
import * as m047 from "./047_completion_retry_index.js";
import * as m048 from "./048_completion_retry_index_grants.js";
import * as m049 from "./049_signing_completed_notification.js";
import * as m050 from "./050_user_signatures.js";
import * as m051 from "./051_signing_account_links.js";
import * as m052 from "./052_signature_capture_provenance.js";
import * as m053 from "./053_prepared_signatures.js";
import * as m054 from "./054_intent_session_binding.js";
import * as m055 from "./055_user_signed_documents.js";
import * as m056 from "./056_in_app_signing.js";
import * as m057 from "./057_signing_inbox_unclaimed.js";
import * as m058 from "./058_workflow_templates.js";
import * as m059 from "./059_workflow_template_document.js";
import * as m060 from "./060_workflow_template_fields.js";
import * as m061 from "./061_organization_unit_member_titles.js";
import * as m062 from "./062_static_value_fields.js";
import * as m063 from "./063_workflow_template_variables.js";
import * as m064 from "./064_workflow_template_field_variable.js";
import * as m065 from "./065_template_artifact_fk_removal.js";
import * as m066 from "./066_workflow_template_content.js";
import * as m067 from "./067_document_upload_requests.js";
import * as m068 from "./068_document_upload_requested_notification.js";
import * as m069 from "./069_approval_workflow.js";

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
  "017_document_preparation": m017,
  "018_preparation_recipients": m018,
  "019_signing_requests": m019,
  "020_signing_request_send": m020,
  "021_recipient_signing_access": m021,
  "022_signing_ceremony": m022,
  "023_signature_submission": m023,
  "024_signing_state": m024,
  "025_completion_pipeline": m025,
  "026_completion_steps": m026,
  "027_completion_failure_codes": m027,
  "028_signing_request_completed": m028,
  "029_evidence_event_provenance": m029,
  "030_notifications": m030,
  "031_retire_signing_delivery_intents": m031,
  "032_notification_audience_integrity": m032,
  "033_notification_delivery_attempts": m033,
  "034_notification_dispatch_index": m034,
  "035_password_reset_sealed_credential": m035,
  "036_invitation_sealed_credential": m036,
  "037_verification_sealed_credential": m037,
  "038_retire_mfa_otp_notification": m038,
  "039_organization_units": m039,
  "040_document_folders": m040,
  "041_signing_request_expiry": m041,
  "042_signing_request_ready_to_send": m042,
  "043_drop_immutable_artifact_fks": m043,
  "044_drop_stale_artifact_type_check": m044,
  "045_verification_id_format": m045,
  "046_database_rejected_failure_code": m046,
  "047_completion_retry_index": m047,
  "048_completion_retry_index_grants": m048,
  "049_signing_completed_notification": m049,
  "050_user_signatures": m050,
  "051_signing_account_links": m051,
  "052_signature_capture_provenance": m052,
  "053_prepared_signatures": m053,
  "054_intent_session_binding": m054,
  "055_user_signed_documents": m055,
  "056_in_app_signing": m056,
  "057_signing_inbox_unclaimed": m057,
  "058_workflow_templates": m058,
  "059_workflow_template_document": m059,
  "060_workflow_template_fields": m060,
  "061_organization_unit_member_titles": m061,
  "062_static_value_fields": m062,
  "063_workflow_template_variables": m063,
  "064_workflow_template_field_variable": m064,
  "065_template_artifact_fk_removal": m065,
  "066_workflow_template_content": m066,
  "067_document_upload_requests": m067,
  "068_document_upload_requested_notification": m068,
  "069_approval_workflow": m069,
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

/**
 * True when every migration this build knows about has been applied.
 *
 * Exists because readiness checked only REACHABILITY, and that was a false
 * green that cost an outage: a deploy shipped code requiring a column its
 * migration had not created, so every template read failed while `/ready`
 * returned `{"status":"ready"}` — the database was reachable, it just did not
 * have the schema the code expected.
 *
 * Deliberately one-directional. It asks "is anything this build needs
 * MISSING", not "do the two sets match exactly". A database carrying a
 * migration this build has never heard of is a ROLLBACK — the previous
 * release is being served while a newer schema is in place — and that process
 * should keep serving traffic rather than take itself out of rotation.
 *
 * Swallows its own failure into `false` rather than throwing, matching the
 * readiness contract: a probe must never 500.
 */
export async function hasCurrentSchema(db: Kysely<Database>): Promise<boolean> {
  try {
    const rows = await migrator(db).getMigrations();
    return rows.every(row => row.executedAt !== undefined);
  } catch {
    return false;
  }
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
