// 049 — widens the notification vocabularies for the completion notification.
//
// ── What this adds, and what it deliberately does not ─────────────────────
//
// Two CHECK constraints widen by one value each:
//
//   notification_intents_type_check         + 'SIGNING_COMPLETED'
//   notification_intents_source_kind_check  + 'SIGNING_REQUEST'
//
// Nothing else. No table, no index, no trigger, no column, and no policy —
// which is the point of the design this migration serves. The completion
// notification reuses `notification_intents`, `notification_deliveries`, the
// dispatch index and the delivery worker exactly as the four existing
// notifications do.
//
// ── Why there are no grants in this migration ─────────────────────────────
//
// Migration 048 exists because 047 created a table and forgot to grant on it,
// and the omission surfaced only in production. The rule that followed —
// every new database object's grants ship in the migration that creates it —
// is satisfied here vacuously: this migration creates no object. The runtime
// role's privileges on `notification_intents` and `notification_deliveries`
// were granted by 030 and are unchanged by widening a CHECK, because a CHECK
// constraint is not a grantable object.
//
// That is asserted rather than assumed: the accompanying integration test
// inserts a SIGNING_COMPLETED intent AS THE RUNTIME ROLE (via
// `createRuntimeRoleDatabase`), which is the check 047's suite lacked.
//
// ── Why `template_key` needs nothing ──────────────────────────────────────
//
// There is no CHECK on it. Migration 030 constrains `notification_type`,
// `source_kind`, `audience_kind`, `scope`, `secret_ref_kind`, the
// audience/scope biconditionals and `template_version`, but leaves the
// template key as a plain column — deliberately, since the registry in code
// is the authority on which keys can render and a database CHECK would have to
// widen on every copy change. `signing-completed` therefore needs only the
// TypeScript union and a registered template.
//
// ── Why no new secret-ref branch is needed either ─────────────────────────
//
// `SIGNING_COMPLETED` is the first notification carrying no credential, and
// 030 already permits that: `notification_intents_secret_kind_check` is
// `secret_ref_kind IS NULL OR IN ('SEALED','CHALLENGE')`, and
// `notification_intents_secret_ref_check` has an explicit all-null branch.
// Verified against the live schema before writing this, not inferred from the
// migration source.
//
// ── Why USER audience + WORKSPACE scope is already legal ──────────────────
//
// The two constraints are independent: `notification_intents_audience_match`
// constrains only the three audience columns, and
// `notification_intents_scope_check` only the two scope columns. So the
// combination this policy needs — audience `USER` with `audience_user_id` set,
// scoped to a workspace — satisfies both without a change. It is a new
// COMBINATION, not a new value, which is why the integration test asserts the
// insert rather than trusting the reading.

import { sql, type Kysely } from "kysely";

/**
 * Renders a value list for a DDL `check ... in (...)`.
 *
 * `sql.raw`, because PostgreSQL does not accept bind parameters in DDL — the
 * same constraint migration 045 hit ("bind message supplies 1 parameters").
 * The inputs are the literals below and nothing else: no caller supplies them,
 * so there is no injection surface, and the assertion guards that staying true.
 */
const values = (allowed: readonly string[]) => {
  for (const value of allowed) {
    if (!/^[A-Z_]+$/u.test(value)) {
      throw new Error(`Refusing to inline an unexpected literal: ${value}`);
    }
  }
  return sql.raw(allowed.map(value => `'${value}'`).join(", "));
};

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "WORKSPACE_INVITATION",
  "SIGNING_INVITATION",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "SIGNING_COMPLETED"] as const;

const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT",
  "SECURITY_CHALLENGE",
  "WORKSPACE_INVITATION",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "SIGNING_REQUEST"] as const;

/**
 * Drops and recreates both CHECKs in one transaction.
 *
 * Drop-then-add rather than `alter constraint`, which PostgreSQL does not
 * support for CHECKs. `if exists` on the drop so a cluster that somehow lacks
 * the constraint is repaired rather than failing the deploy; the add is
 * unconditional, so the end state is the same either way.
 */
async function setVocabularies(
  db: Kysely<unknown>,
  types: readonly string[],
  sources: readonly string[],
): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
      check (notification_type in (${values(types)}))
  `.execute(db);

  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_source_kind_check
      check (source_kind in (${values(sources)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_AFTER, SOURCES_AFTER);
}

/**
 * Narrows both CHECKs back.
 *
 * This FAILS if any SIGNING_COMPLETED intent exists, because adding a CHECK
 * validates existing rows. That is the correct behaviour and not an oversight:
 * silently deleting notification records to make a rollback succeed would
 * destroy the evidence that a message was owed to somebody. An operator who
 * genuinely means to roll back past this point must decide what happens to
 * those rows deliberately.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_BEFORE, SOURCES_BEFORE);
}
