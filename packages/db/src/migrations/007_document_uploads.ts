// Upload processing records.
//
// ── What this table is, and is not ─────────────────────────────────────────
//
// It tracks the PROCESSING of an untrusted file: what arrived, what was decided
// about it, and which quarantine object still needs removing. It is operational
// and security history.
//
// It is NOT the document, and NOT the artifact. `document_artifacts` remains the
// authority on accepted bytes, and an upload row never becomes one (INV-219). It
// is also NOT signing evidence: a rejected upload is not an event in a signing
// transaction, and nothing here is written to `evidence_events` (§84).
//
// Workspace-scoped, with the same compound-key discipline as every other tenant
// table, so a future foreign key from an artifact cannot cross a tenant.

import { type Kysely, sql } from "kysely";

const STATUSES = ["quarantined", "accepted", "rejected", "failed"] as const;

const REJECTION_REASONS = [
  "file-too-large", "empty-file", "unsupported-file-type", "malformed-pdf",
  "encrypted-pdf-unsupported", "too-many-pages", "malware-detected",
  "scan-unavailable", "integrity-failure", "storage-failure",
] as const;

const SCAN_OUTCOMES = ["clean", "infected", "unavailable"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table document_uploads (
      upload_id            varchar(64)  primary key,
      workspace_id         varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,
      uploader_user_id     varchar(64)  not null,

      -- The quarantine object key. INTERNAL: it never reaches a response, and
      -- it is what the cleanup job reads instead of listing a bucket (§82).
      quarantine_reference varchar(512) not null,
      -- NULL once the object has been removed, which is how cleanup knows what
      -- is left to do without re-deleting what is already gone.
      quarantine_cleared_at timestamptz,

      -- UNTRUSTED display metadata. Never a storage key, never a type signal.
      -- Nullable because a multipart part legitimately has no filename.
      original_filename    varchar(255),
      -- What the browser claimed. Diagnostics only; trusted for nothing (§29).
      client_media_type    varchar(255),
      -- What LAGDA DETERMINED from the content. This is the authority.
      detected_media_type  varchar(128),

      byte_size            bigint       not null,
      digest_algorithm     varchar(16)  not null default 'sha-256',
      -- Computed by the backend from exact received bytes. Never client-supplied.
      digest               varchar(128),

      status               varchar(32)  not null,
      rejection_reason     varchar(64),
      -- Set together with status 'accepted', never before (INV-226).
      accepted_artifact_id varchar(64),

      -- Operational security history. Deliberately NOT the scanner's raw
      -- response, and not presented as legal evidence (§207, §208).
      scan_outcome         varchar(32),
      scanned_at           timestamptz,

      created_at           timestamptz  not null default now(),
      completed_at         timestamptz,

      constraint document_uploads_workspace_key unique (workspace_id, upload_id),
      constraint document_uploads_status_check check (status in (${inList(STATUSES)})),
      constraint document_uploads_size_check check (byte_size >= 0),

      constraint document_uploads_reason_check check (
        rejection_reason is null or rejection_reason in (${inList(REJECTION_REASONS)})
      ),
      constraint document_uploads_scan_check check (
        scan_outcome is null or scan_outcome in (${inList(SCAN_OUTCOMES)})
      ),
      constraint document_uploads_digest_check check (
        digest is null or (digest_algorithm = 'sha-256' and digest ~ '^[a-f0-9]{64}$')
      ),

      -- The invariant that matters most, enforced by the DATABASE rather than
      -- by the code that writes it: an ACCEPTED upload must name its artifact,
      -- and a non-accepted upload must not. A bug that marked an upload
      -- accepted without an artifact would be rejected here (INV-226).
      constraint document_uploads_accepted_has_artifact check (
        (status = 'accepted' and accepted_artifact_id is not null)
        or (status <> 'accepted' and accepted_artifact_id is null)
      ),

      -- A rejected or failed upload must say why. "Rejected for unknown
      -- reasons" is not an operable state.
      constraint document_uploads_terminal_has_reason check (
        status not in ('rejected', 'failed') or rejection_reason is not null
      ),

      -- Tenant-safe: the accepted artifact belongs to the SAME workspace. This
      -- is what makes cross-tenant promotion structurally impossible rather
      -- than merely unlikely (INV-224).
      constraint document_uploads_artifact_fk
        foreign key (workspace_id, accepted_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict
    )
  `.execute(db);

  // Cleanup reads this: quarantined-or-terminal rows whose object still exists,
  // oldest first. A partial index keeps it small - most rows are cleared.
  await sql`
    create index document_uploads_cleanup_idx
      on document_uploads (created_at)
      where quarantine_cleared_at is null
  `.execute(db);

  await sql`
    create index document_uploads_workspace_idx
      on document_uploads (workspace_id, created_at desc)
  `.execute(db);

  // ── RLS, matching every other workspace table ────────────────────────────
  await sql`alter table document_uploads enable row level security`.execute(db);
  await sql`alter table document_uploads force row level security`.execute(db);

  await sql`
    create policy document_uploads_tenant_isolation on document_uploads
      using (workspace_id = current_setting('lagda.workspace_id', true))
      with check (workspace_id = current_setting('lagda.workspace_id', true))
  `.execute(db);

  await sql`
    grant select, insert, update on document_uploads to lagda_app
  `.execute(db);

  // No DELETE grant. Upload history is operational security history: knowing
  // that a malware upload happened is exactly the record an incident review
  // needs, and a row is cheap. Quarantine BYTES are deleted; the row is not.
  await sql`revoke delete on document_uploads from lagda_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists document_uploads`.execute(db);
}
