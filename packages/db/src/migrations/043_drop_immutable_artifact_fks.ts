// 043 — drops every foreign key that references document_artifacts,
// document_seals, evidence_events or verification_records.
//
// ── The bug this closes ─────────────────────────────────────────────────────
//
// Migration 003 gave `lagda_app` INSERT and SELECT on these four tables —
// deliberately never UPDATE or DELETE — as an operational control: "an
// application bug — or a compromised application — cannot rewrite history."
// That reasoning is sound and this migration does not touch it.
//
// What nobody could have caught at the time: all four tables are created
// with `force row level security`, and PostgreSQL's foreign-key machinery
// validates a reference by row-locking the referenced row (`SELECT ... FOR
// KEY SHARE`). On a FORCE-RLS table, that lock requires UPDATE privilege on
// the referenced table — regardless of whether the row would even be
// filtered by a policy. So every foreign key pointing INTO one of these four
// tables was, from the moment `force row level security` took effect, only
// ever satisfiable by a role this deployment deliberately never grants.
//
// This was invisible until now because the paths that exercise these FKs —
// completing an upload, sending a signing request, sealing a document —
// had no object storage configured in production and 404'd before ever
// reaching the database. The first real upload against a configured store
// surfaced it as `permission denied for table document_artifacts`, verified
// directly: granting UPDATE makes the error disappear, and revoking it
// brings the error straight back — confirmed against `document_seals` too
// (which carries no RESTRICTIVE policy at all), so this is a FORCE-RLS
// property, not a restrictive-policy one.
//
// ── The choice: drop the FK, keep the privilege separation ─────────────────
//
// Two ways to make the reference checkable again: grant UPDATE (undoes
// migration 003's control), or stop asking the database to lock a row it
// will never let this role lock. This migration is the second.
//
// The reference stays correct WITHOUT the constraint because of how every
// writer already behaves: `commitAcceptance` (process-upload.ts) inserts the
// artifact row and then the upload's completion row, in that order, inside
// ONE transaction — the referenced row exists before the referencing row is
// ever written, whether or not a constraint checks it. The same ordering
// holds for every other FK dropped here (seals, completions, preparations,
// signing requests) — each already writes the artifact/seal first. Losing
// the constraint loses only the database's OWN double-check of an invariant
// the application was already upholding by construction.
//
// ── Why `down` does not attempt to restore the exact prior failure mode ────
//
// Re-adding these FKs would exactly restore the bug this migration fixes.
// `down` recreates them for completeness (matching this repo's own
// reversibility convention) but a deployment that runs it should expect the
// same `permission denied` error to return the moment a real write is
// attempted, since it will still lack UPDATE on the referenced tables.

import { type Kysely, sql } from "kysely";

interface FkSpec {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: "restrict" | "no action";
}

const FOREIGN_KEYS: readonly FkSpec[] = [
  {
    name: "document_artifacts_source_fk", table: "document_artifacts",
    columns: ["workspace_id", "source_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "document_seals_sealed_artifact_fk", table: "document_seals",
    columns: ["workspace_id", "sealed_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "document_seals_certificate_artifact_fk", table: "document_seals",
    columns: ["workspace_id", "certificate_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "verification_records_seal_fk", table: "verification_records",
    columns: ["workspace_id", "seal_id"],
    refTable: "document_seals", refColumns: ["workspace_id", "seal_id"],
    onDelete: "restrict",
  },
  {
    name: "document_uploads_artifact_fk", table: "document_uploads",
    columns: ["workspace_id", "accepted_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "document_preparations_artifact_fk", table: "document_preparations",
    columns: ["workspace_id", "source_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "signing_requests_artifact_fk", table: "signing_requests",
    columns: ["workspace_id", "source_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "restrict",
  },
  {
    name: "signing_request_completion_steps_artifact_fk",
    table: "signing_request_completion_steps",
    columns: ["workspace_id", "output_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "no action",
  },
  {
    name: "signing_request_completions_final_artifact_fk",
    table: "signing_request_completions",
    columns: ["workspace_id", "final_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "no action",
  },
  {
    name: "signing_request_completions_certificate_fk",
    table: "signing_request_completions",
    columns: ["workspace_id", "certificate_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "no action",
  },
  {
    name: "signing_request_completions_merged_fk",
    table: "signing_request_completions",
    columns: ["workspace_id", "merged_artifact_id"],
    refTable: "document_artifacts", refColumns: ["workspace_id", "artifact_id"],
    onDelete: "no action",
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const fk of FOREIGN_KEYS) {
    await sql`
      alter table ${sql.table(fk.table)}
        drop constraint if exists ${sql.ref(fk.name)}
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const fk of FOREIGN_KEYS) {
    await sql`
      alter table ${sql.table(fk.table)}
        add constraint ${sql.ref(fk.name)}
        foreign key (${sql.join(fk.columns.map(c => sql.ref(c)))})
        references ${sql.table(fk.refTable)} (${sql.join(fk.refColumns.map(c => sql.ref(c)))})
        on delete ${sql.raw(fk.onDelete)}
    `.execute(db);
  }
}
