// 065 — remove a foreign key that can never be satisfied.
//
// ── The collision ───────────────────────────────────────────────────────────
//
// 059 gave `workspace_workflow_templates.source_artifact_id` a foreign key to
// `document_artifacts`. 003 had already made that table APPEND-ONLY, and said
// so deliberately:
//
//     revoke update, delete
//       on table document_artifacts, evidence_events, document_seals,
//          verification_records
//       from lagda_app
//
//     "Stated explicitly rather than relying on 'we simply did not grant it'.
//      A future migration that grants ALL on a schema would silently undo the
//      intent; this makes the revocation an auditable line in source control."
//
// A foreign key takes a `FOR KEY SHARE` lock on the referenced row, and
// PostgreSQL requires UPDATE or DELETE privilege for ANY row lock. So every
// attempt to attach a document to a template failed:
//
//     permission denied for table document_artifacts
//       at attachDocument (repositories/workflow-templates.ts)
//
// Normally this would be invisible, because RI triggers run as the referenced
// table's OWNER. Here `lagda_app` IS the owner, and the revoke was applied to
// the owner — so no role exists that can satisfy the check. Reproduced
// directly:
//
//     set role lagda_app;
//     select 1 from document_artifacts limit 1 for key share;
//     ERROR:  permission denied for table document_artifacts
//
// Attaching a document to a template has therefore NEVER worked against a
// real database. 059 only reached production today, which is when it surfaced.
//
// ── Why the FK goes rather than the revoke ─────────────────────────────────
//
// Three fixes were possible. Granting UPDATE back would silently remove an
// integrity control on signing evidence — precisely what 003's comment warns
// a future migration might do, so it is refused here. Re-owning every evidence
// table to `postgres` would work but is a far larger change to the security
// model than this defect warrants.
//
// So the FK goes. That is NOT a loss of validation: this schema already
// resolves exactly this tension the same way for `workflow_template_fields.
// slot_id`, whose header says "It cannot: slots live in JSONB, not a table
// row, so there is nothing at the database level to reference. The application
// validates it against the template's CURRENT `role_slots` on every write."
//
// `attachWorkflowTemplateDocument` already performs a STRICTER check than the
// foreign key did, in the same transaction as the write:
//
//   * the artifact exists                    -> ResourceNotFoundError
//   * it belongs to the document named       -> WorkflowTemplateDocumentMismatchError
//   * it is the `original` upload, not a     -> WorkflowTemplateDocumentMismatchError
//     merged candidate, certificate or seal
//
// The FK only ever checked the first of those.
//
// ── What is deliberately KEPT ──────────────────────────────────────────────
//
// `workflow_templates_document_fk` -> `documents` stays. That table grants
// `arwdDxt` to `lagda_app` — UPDATE included — so its FK locks fine and has
// always worked.
//
// `workflow_templates_document_pair_check` stays too: document_id and
// source_artifact_id are still both-set-or-both-null, which is the invariant
// that actually matters for reading a template back.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_source_artifact_fk
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores a constraint that cannot be satisfied at runtime while
  // `document_artifacts` remains append-only. Present for completeness; a
  // database rolled back to this point will refuse every document attachment
  // again, exactly as it did before this migration.
  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_source_artifact_fk
        foreign key (workspace_id, source_artifact_id)
        references document_artifacts (workspace_id, artifact_id)
        on delete restrict
  `.execute(db);
}
