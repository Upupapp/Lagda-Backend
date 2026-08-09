// Database row types.
//
// These describe PostgreSQL tables. They are NOT contracts and NOT domain
// entities: `WorkspaceRow` is deliberately different from `Workspace` and from
// `WorkspaceResponse`, and none of them may be substituted for another.
//
// Hand-maintained rather than generated. Generation from a live database makes
// the database the source of truth for types while migrations are the source of
// truth for schema — two sources that drift the moment someone forgets to
// regenerate. Here, a migration and its row type change in the same commit, and
// the integration tests fail if they disagree.
//
// snake_case throughout, matching PostgreSQL. Mapping to camelCase happens at
// the repository boundary, never by exposing these outward.

import type { ColumnType } from "kysely";

/**
 * A `timestamptz` column.
 *
 * Read as a `Date` and written as a `Date`, converted at the mapping boundary
 * to the domain's numeric `Instant`. The domain never sees a `Date` — it is
 * mutable, and handing one out lets a caller change an aggregate's timestamps.
 */
type Timestamptz = ColumnType<Date, Date, Date>;

/**
 * A `timestamptz` the DATABASE fills in — `default now()`.
 *
 * Optional on insert and `never` on update: these columns record when a row was
 * durably written, and a value the application could overwrite would not be
 * that. Not `Generated<Timestamptz>`, which nests a ColumnType inside a
 * ColumnType and silently breaks Kysely's select-type inference.
 */
type GeneratedTimestamptz = ColumnType<Date, Date | undefined, never>;

export interface WorkspacesTable {
  /** Opaque branded identifier, e.g. `ws_...`. Not a sequential integer. */
  workspace_id: string;
  name: string;
  owner_user_id: string;
  created_at: Timestamptz;
}

export interface WorkspaceMembershipsTable {
  member_id: string;
  /** First-class tenant column. Every workspace-owned table carries it. */
  workspace_id: string;
  user_id: string;
  /** Constrained by CHECK to the canonical role vocabulary. */
  role: string;
  created_at: Timestamptz;
}


/**
 * A byte-distinct artifact.
 *
 * `original.pdf` and `sealed.pdf` are two ROWS, never one row whose digest is
 * overwritten. There is no `prepared` type: preparation produces field metadata,
 * not a new PDF (handoff §8/§9).
 */
export interface DocumentArtifactsTable {
  artifact_id: string;
  workspace_id: string;
  /** No foreign key yet — the `documents` table arrives with BACKEND-29/30. */
  document_id: string;
  /** CHECK-constrained: original | sealed | completion-certificate. */
  artifact_type: string;
  /** LAGDA-owned opaque reference. Never an S3 bucket/key contract. */
  storage_reference: string;
  media_type: string;
  /** `bigint`. Kysely reads it as a string to avoid silent precision loss. */
  size_bytes: ColumnType<string, number | string, never>;
  digest_algorithm: string;
  digest: string;
  source_artifact_id: string | null;
  created_at: GeneratedTimestamptz;
}

/**
 * Append-only signing evidence.
 *
 * The runtime role holds INSERT and SELECT only, so `update` and `delete` are
 * unavailable at the database level, not merely absent from the repository.
 */
export interface EvidenceEventsTable {
  evidence_event_id: string;
  /** First-class tenancy. Never inferred through a signing-request join. */
  workspace_id: string;
  signing_request_id: string;
  document_id: string | null;
  recipient_id: string | null;
  event_type: string;
  /** workspace-user | recipient | system. A recipient is not a UserId. */
  actor_type: string;
  /** NULL exactly when the actor is `system`. */
  actor_id: string | null;
  /** The business fact's time, from the application Clock. */
  occurred_at: Timestamptz;
  /** When the row was durably inserted. Defaulted by the database. */
  recorded_at: GeneratedTimestamptz;
  /** Server-observed. NULL until BACKEND-11/56 establishes proxy trust. */
  client_ip: string | null;
  client_user_agent: string | null;
  details: ColumnType<unknown, string | null, never> | null;
  details_version: number | null;
}

/** How a final artifact was produced. One row per completed signing request. */
export interface DocumentSealsTable {
  seal_id: string;
  workspace_id: string;
  signing_request_id: string;
  sealed_artifact_id: string;
  certificate_artifact_id: string | null;
  seal_scheme: string;
  seal_version: number;
  digest_algorithm: string;
  original_document_hash: string;
  signed_document_hash: string;
  sealed_at: Timestamptz;
  created_at: GeneratedTimestamptz;
}

/**
 * Public verification identity.
 *
 * Hashes are reached THROUGH `seal_id` rather than copied here — two
 * independently writable copies of one digest drift on the first partial write.
 */
export interface VerificationRecordsTable {
  verification_id: string;
  workspace_id: string;
  signing_request_id: string;
  document_id: string;
  seal_id: string;
  completed_at: Timestamptz;
  participant_count: number;
  created_at: GeneratedTimestamptz;
}

/**
 * A browser session.
 *
 * **No `workspace_id`, deliberately.** A session says which user is calling;
 * whether that user may touch a workspace is membership (BACKEND-27). Classified
 * GLOBAL_AUTHENTICATION, and the one table with no RLS.
 */
export interface UserSessionsTable {
  session_id: string;
  /** No FK yet — `users` arrives with BACKEND-19. */
  user_id: string;
  /** SHA-256 of the raw token. The raw token is NEVER stored. */
  token_hash: string;
  csrf_token_hash: string;
  created_at: GeneratedTimestamptz;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamptz;
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  revocation_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Migration bookkeeping, owned by Kysely's migrator.
 *
 * Declared so the type-checker knows it exists; application code never reads it.
 */
export interface KyselyMigrationTable {
  name: string;
  timestamp: string;
}

/** The complete database. Kysely resolves table names from these keys. */
export interface Database {
  workspaces: WorkspacesTable;
  workspace_memberships: WorkspaceMembershipsTable;
  document_artifacts: DocumentArtifactsTable;
  evidence_events: EvidenceEventsTable;
  document_seals: DocumentSealsTable;
  verification_records: VerificationRecordsTable;
  user_sessions: UserSessionsTable;
  kysely_migration: KyselyMigrationTable;
}
