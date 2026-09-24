// 068 — widens the notification vocabularies for the upload-request message.
//
// ── What this adds, and what it deliberately does not ─────────────────────
//
// Two CHECK constraints widen by one value each, exactly as 049 did:
//
//   notification_intents_type_check         + 'DOCUMENT_UPLOAD_REQUESTED'
//   notification_intents_source_kind_check  + 'DOCUMENT_UPLOAD_REQUEST'
//
// Nothing else. The message reuses `notification_intents`,
// `notification_deliveries`, the dispatch index and the delivery worker
// exactly as the five existing notifications do.
//
// ── Why USER audience + WORKSPACE scope needs no change ───────────────────
//
// It is the same combination `SIGNING_COMPLETED` already uses, and 049's
// header records why it was already legal: `notification_intents_audience_
// match` constrains only the audience columns and
// `notification_intents_scope_check` only the scope columns, so the pairing
// satisfies both without a new value. Verified against the live schema
// before writing this, not inferred — the two CHECKs above were read back
// from the running database and carried exactly the five types and four
// source kinds 049 left behind.
//
// ── Why no secret-ref branch ──────────────────────────────────────────────
//
// This message carries NO credential, like `SIGNING_COMPLETED`. Its reader is
// a workspace member who follows an ordinary authenticated route to their own
// queue. 030 already permits a null `secret_ref_kind`.
//
// ── Why no grants ─────────────────────────────────────────────────────────
//
// This migration creates no object — a CHECK constraint is not grantable, and
// the runtime role's privileges on both notification tables were granted by
// 030. 048 exists because 047 created a table and forgot its grants; that
// rule is satisfied here vacuously.

import { sql, type Kysely } from "kysely";

/**
 * Renders a value list for a DDL `check ... in (...)`.
 *
 * `sql.raw`, because PostgreSQL does not accept bind parameters in DDL. The
 * inputs are the literals below and nothing else — no caller supplies them —
 * and the assertion guards that staying true.
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
  "SIGNING_COMPLETED",
] as const;
const TYPES_AFTER = [...TYPES_BEFORE, "DOCUMENT_UPLOAD_REQUESTED"] as const;

const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT",
  "SECURITY_CHALLENGE",
  "WORKSPACE_INVITATION",
  "SIGNING_REQUEST",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "DOCUMENT_UPLOAD_REQUEST"] as const;

/** Drop-then-add, because PostgreSQL cannot `alter constraint` a CHECK. */
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
 * FAILS if any DOCUMENT_UPLOAD_REQUESTED intent exists, because adding a
 * CHECK validates existing rows — the same deliberate behaviour 049 chose.
 * Silently deleting notification records to make a rollback succeed would
 * destroy the evidence that a message was owed to somebody.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, TYPES_BEFORE, SOURCES_BEFORE);
}
