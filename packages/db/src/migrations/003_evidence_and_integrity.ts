// 003 — evidence, artifacts, seals and verification.
//
// Four tables, four DISTINCT questions. They are not collapsed into one
// `audit_log` because they answer different things and have different retention,
// visibility and immutability requirements:
//
//   document_artifacts   — what bytes exist, and what identifies them
//   evidence_events      — what happened, who did it, when LAGDA observed it
//   document_seals       — what finalization procedure produced a final artifact
//   verification_records — the public identity of a completed transaction
//
// ── The constraint that shapes this migration ──────────────────────────────
//
// Only `workspaces` and `workspace_memberships` exist today. There is no
// `documents`, `signing_requests` or `recipients` table — those arrive with
// BACKEND-29/30/31.
//
// So `document_id`, `signing_request_id` and `recipient_id` are real, NOT NULL
// where semantically required, and carry NO foreign key, because there is
// nothing to point at. Every other relationship — artifact provenance, seal to
// artifact, verification to seal — IS compound-FK constrained today.
//
// This is recorded rather than hidden, and the future FKs are made cheap:
// each parent table must be created with `UNIQUE (workspace_id, <id>)` so the
// constraint is a pure ALTER TABLE that touches no evidence code. The exact
// statements are in docs/backend/evidence/EVIDENCE_ARCHITECTURE.md.

import { type Kysely, sql } from "kysely";

/**
 * Artifact types. Exactly three, because exactly three byte-distinct artifacts
 * exist.
 *
 * There is deliberately NO `prepared` type. Handoff §8 specifies "field overlay
 * merging: AFTER signing, embed approved fields into a final PDF", and §9
 * specifies storage "versioned: original + signed final". Preparation produces
 * field placement metadata, not a new PDF — so a `prepared` artifact would be a
 * row describing bytes that never exist.
 */
const ARTIFACT_TYPES = ["original", "sealed", "completion-certificate"] as const;

/**
 * Evidence event types — the SIGNING EVIDENCE subset, not the whole audit trail.
 *
 * Derived from the handoff, not from the frontend's 40-type display vocabulary.
 * Names match `ActivityEventType` where an equivalent already exists, so LAGDA
 * has one vocabulary rather than two that drift.
 *
 * Deliberately EXCLUDED, with reasons:
 *   - invitation-delivered / -failed / -bounced / -opened — delivery-channel
 *     outcomes. Handoff §16 records participant actions; a bounce is a fact
 *     about an email provider, not about a signer. BACKEND-44/45.
 *   - settings and preference changes — general audit, not signing evidence
 *     (BACKEND-43).
 *   - reminder-sent, routing-step-* — workflow mechanics with no evidentiary
 *     claim about a participant.
 */
const EVENT_TYPES = [
  "transaction-created",
  "transaction-sent",
  "transaction-cancelled",
  "transaction-expired",
  "transaction-completed",
  "invitation-sent",
  "authentication-completed",
  "consent-accepted",
  "document-viewed",
  "signature-completed",
  "participant-declined",
  "document-sealed",
  "verification-record-created",
] as const;

/**
 * Actor categories.
 *
 * A recipient is NOT a `UserId`. External signers have no LAGDA account, and
 * modelling every actor as a user would either force fake user rows or make
 * `actor_id` meaningless for the majority of signing evidence.
 */
const ACTOR_TYPES = ["workspace-user", "recipient", "system"] as const;

/** Renders a value list for a CHECK constraint, each value parameterised. */
const inList = (values: readonly string[]) =>
  sql.join(values.map((v) => sql.lit(v)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── document_artifacts ─────────────────────────────────────────────────────
  //
  // One row per byte-distinct artifact. `original.pdf` and `sealed.pdf` are two
  // rows, never one row whose digest and storage key get overwritten — artifact
  // history is the point, and an overwritten digest destroys the only evidence
  // that the earlier bytes existed.
  await sql`
    create table document_artifacts (
      artifact_id        varchar(64)  primary key,
      workspace_id       varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,
      document_id        varchar(64)  not null,
      artifact_type      varchar(32)  not null,
      storage_reference  varchar(512) not null,
      media_type         varchar(128) not null,
      size_bytes         bigint       not null,
      digest_algorithm   varchar(16)  not null,
      digest             varchar(128) not null,
      source_artifact_id varchar(64),
      created_at         timestamptz  not null default now(),

      constraint document_artifacts_workspace_key unique (workspace_id, artifact_id),
      constraint document_artifacts_type_check
        check (artifact_type in (${inList(ARTIFACT_TYPES)})),
      constraint document_artifacts_size_check check (size_bytes >= 0),

      -- ALGORITHM-AWARE, not a bare 64-character rule. A fixed length check
      -- would have to be dropped to introduce sha-512, and dropping a CHECK is
      -- how historical rows stop being validated. Extending this disjunction
      -- leaves every existing row constrained exactly as it was written.
      constraint document_artifacts_digest_check check (
        (digest_algorithm = 'sha-256' and digest ~ '^[a-f0-9]{64}$')
      ),

      -- Provenance is a relation, not a naming convention. Tenant-safe: a
      -- derived artifact cannot descend from another workspace's bytes.
      constraint document_artifacts_source_fk
        foreign key (workspace_id, source_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict,

      -- The one cycle worth preventing structurally. Deeper cycles need
      -- recursion the current two-step chain cannot produce.
      constraint document_artifacts_no_self_source
        check (source_artifact_id is null or source_artifact_id <> artifact_id)
    )
  `.execute(db);

  // NOT unique on digest. Two identical PDFs legitimately share a SHA-256 —
  // the digest is content identity, not row identity, and a UNIQUE here would
  // reject the second workspace to upload the same standard form.
  await sql`
    create index document_artifacts_document_idx
      on document_artifacts (workspace_id, document_id, artifact_type)
  `.execute(db);

  // ── evidence_events ────────────────────────────────────────────────────────
  //
  // Append-only. Handoff §16: "Activity log must not be modifiable after
  // creation"; §32: "append-only store". Enforcement is at the bottom of this
  // migration — the runtime role receives INSERT and SELECT only.
  await sql`
    create table evidence_events (
      evidence_event_id  varchar(64)  primary key,
      workspace_id       varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,

      -- Explicit tenancy. Never inferred through a signing-request join:
      -- evidence is the most sensitive data LAGDA holds, and a join is one
      -- refactor away from being an outer join that leaks.
      signing_request_id varchar(64)  not null,
      document_id        varchar(64),
      recipient_id       varchar(64),

      event_type         varchar(64)  not null,
      actor_type         varchar(16)  not null,
      actor_id           varchar(64),

      -- When the business fact happened, from the application Clock. Never a
      -- client-supplied timestamp.
      occurred_at        timestamptz  not null,
      -- When the row was durably inserted. Differs from occurred_at whenever a
      -- worker records an event after the fact; the gap is itself forensically
      -- meaningful, which is why both exist.
      recorded_at        timestamptz  not null default now(),

      -- Server-observed request context. NULL until BACKEND-11/56 establishes
      -- trusted proxy configuration — an X-Forwarded-For recorded without it is
      -- attacker-controlled text wearing the costume of evidence.
      client_ip          inet,
      client_user_agent  varchar(512),

      -- Bounded, versioned, event-specific detail. The core facts above are
      -- typed columns; this carries only what varies by event type.
      details            jsonb,
      details_version    integer,

      constraint evidence_events_workspace_key unique (workspace_id, evidence_event_id),
      constraint evidence_events_type_check
        check (event_type in (${inList(EVENT_TYPES)})),
      constraint evidence_events_actor_type_check
        check (actor_type in (${inList(ACTOR_TYPES)})),

      -- A system actor has no identity to record. Inventing a synthetic user ID
      -- for the expiry worker would make "who did this" unanswerable for every
      -- automated action.
      constraint evidence_events_system_actor_check
        check ((actor_type = 'system') = (actor_id is null)),

      constraint evidence_events_details_version_check
        check ((details is null) = (details_version is null)),
      constraint evidence_events_details_version_positive
        check (details_version is null or details_version > 0),

      -- Evidence rows are not a document store. Binary content belongs in an
      -- artifact; the cap stops a payload from quietly becoming one.
      constraint evidence_events_details_size_check
        check (details is null or pg_column_size(details) <= 8192)
    )
  `.execute(db);

  // The timeline index. Leads with workspace_id because every query is
  // tenant-scoped first, and ends with the event ID because occurred_at alone
  // is not a total order — two recipients can act in the same millisecond.
  await sql`
    create index evidence_events_timeline_idx
      on evidence_events (workspace_id, signing_request_id, occurred_at, evidence_event_id)
  `.execute(db);

  // No index on client_ip or client_user_agent. Indexing sensitive free-form
  // values without a query that needs them adds attack surface and retention
  // cost for nothing.

  // ── document_seals ─────────────────────────────────────────────────────────
  //
  // The artifact row answers "what bytes exist". This answers "what LAGDA
  // procedure produced and interprets them". Collapsing the two would make a
  // future migration to certificate-backed signing ambiguous, because nothing
  // would record which rules a historical artifact was produced under.
  await sql`
    create table document_seals (
      seal_id                 varchar(64)  primary key,
      workspace_id            varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,
      signing_request_id      varchar(64)  not null,

      sealed_artifact_id      varchar(64)  not null,
      -- Separate artifact, per BACKEND-09 and handoff §15, which stores the
      -- certificate as its own file rather than appending it.
      certificate_artifact_id varchar(64),

      -- Written from the first row. NOT defaulted, NOT inferred from the
      -- application version, and never NULL-means-version-1: a historical
      -- record has to be self-describing or it is not evidence.
      seal_scheme             varchar(32)  not null,
      seal_version            integer      not null,
      digest_algorithm        varchar(16)  not null,

      -- Named for their artifacts. Handoff §17's "documentHash" is the SHA-256
      -- of the original file at upload; under the current architecture that is
      -- also the digest handed to the sealer, because preparation produces no
      -- new bytes.
      original_document_hash  varchar(128) not null,
      signed_document_hash    varchar(128) not null,

      sealed_at               timestamptz  not null,
      created_at              timestamptz  not null default now(),

      constraint document_seals_workspace_key unique (workspace_id, seal_id),

      -- ONE finalization per signing request. Resealing is not a product
      -- feature, and a completion retry must converge on this row rather than
      -- creating a competing one.
      constraint document_seals_one_per_request unique (workspace_id, signing_request_id),

      constraint document_seals_version_check check (seal_version > 0),
      constraint document_seals_scheme_check check (seal_scheme in ('hash-evidence')),
      constraint document_seals_hash_check check (
        digest_algorithm = 'sha-256'
        and original_document_hash ~ '^[a-f0-9]{64}$'
        and signed_document_hash ~ '^[a-f0-9]{64}$'
      ),

      constraint document_seals_sealed_artifact_fk
        foreign key (workspace_id, sealed_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict,
      constraint document_seals_certificate_artifact_fk
        foreign key (workspace_id, certificate_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict,

      constraint document_seals_distinct_artifacts
        check (certificate_artifact_id is null or certificate_artifact_id <> sealed_artifact_id)
    )
  `.execute(db);

  // ── verification_records ───────────────────────────────────────────────────
  //
  // Handoff §17: "verificationId, documentHash, signedDocumentHash, completedAt,
  // participantCount, issuerWorkspaceId".
  //
  // The two hashes are reached THROUGH the seal rather than copied here. Two
  // independently writable copies of the same digest is a drift bug waiting for
  // its first partial write, and the verification page would then disagree with
  // the seal record about what was signed.
  await sql`
    create table verification_records (
      -- Globally unique, and one of the few places that is correct: a public
      -- verification ID must resolve without a tenant hint, since the person
      -- checking it has none.
      verification_id    varchar(64)  primary key,
      workspace_id       varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,
      signing_request_id varchar(64)  not null,
      document_id        varchar(64)  not null,
      seal_id            varchar(64)  not null,

      completed_at       timestamptz  not null,
      participant_count  integer      not null,
      created_at         timestamptz  not null default now(),

      constraint verification_records_workspace_key unique (workspace_id, verification_id),
      constraint verification_records_one_per_request unique (workspace_id, signing_request_id),
      constraint verification_records_participants_check check (participant_count >= 0),

      -- Format per handoff §15: LAGDA-{workspace}-{date}-{random}. Validated so
      -- a database serial or a guessable value cannot be stored as one.
      constraint verification_records_format_check
        check (verification_id ~ '^LAGDA-[A-Za-z0-9]+-[0-9]{8}-[A-Za-z0-9]{6,}$'),

      constraint verification_records_seal_fk
        foreign key (workspace_id, seal_id)
        references document_seals (workspace_id, seal_id) on delete restrict
    )
  `.execute(db);

  // ── Tenant isolation ───────────────────────────────────────────────────────
  //
  // Same model as 002. Evidence is not exempt because it is later verified
  // publicly: public verification gets a narrow curated projection (BACKEND-42),
  // not a hole in RLS.
  const TABLES = [
    "document_artifacts",
    "evidence_events",
    "document_seals",
    "verification_records",
  ] as const;

  for (const table of TABLES) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.table(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }

  // ── Append-only enforcement ────────────────────────────────────────────────
  //
  // Option B from the immutability options: privilege separation. The runtime
  // role gets INSERT and SELECT and is never granted UPDATE or DELETE, so an
  // application bug — or a compromised application — cannot rewrite history.
  //
  // Chosen over a trigger because a trigger blocks every role including the one
  // that will have to perform legally required erasure (BACKEND-55). Privileges
  // leave that path open to a separate privileged role while closing it to the
  // application. Chosen over repository discipline alone because repository
  // discipline is one careless method away from being untrue.
  //
  // This is an OPERATIONAL control. It does not prove a database administrator
  // could never alter a row, and nothing here should be described as
  // cryptographic non-repudiation.
  await sql`
    grant select, insert
    on table document_artifacts, evidence_events, document_seals, verification_records
    to lagda_app
  `.execute(db);

  // Stated explicitly rather than relying on "we simply did not grant it".
  // A future migration that grants ALL on a schema would silently undo the
  // intent; this makes the revocation an auditable line in source control.
  await sql`
    revoke update, delete
    on table document_artifacts, evidence_events, document_seals, verification_records
    from lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // DATA LOSS. Dropping these tables destroys signing evidence, which handoff
  // §32 requires be append-only and non-deletable. This exists so a developer
  // can rebuild a local database, and production rollback is forward-only.
  for (const table of [
    "verification_records",
    "document_seals",
    "evidence_events",
    "document_artifacts",
  ] as const) {
    await sql`drop policy if exists tenant_isolation on ${sql.table(table)}`.execute(db);
    await sql`drop table if exists ${sql.table(table)}`.execute(db);
  }
}
