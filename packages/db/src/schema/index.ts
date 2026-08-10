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

/**
 * The tenant.
 *
 * **No `owner_user_id`** — dropped in migration 013. Ownership is a membership
 * row whose `role` is `owner`, and a denormalized copy here would be a second
 * authority that an ownership transfer could leave disagreeing with the first.
 *
 * No `archived_at` and no `lifecycle_state`: the product has no archive,
 * suspend or delete action for a workspace, so there is no second state to
 * store. See WORKSPACE_LIFECYCLE.md.
 *
 * No `updated_at`: nothing reads one. This repository has already shipped a
 * field declared on 225 routes that no code consumed and that drifted until it
 * misreported itself; a timestamp column with no reader is that failure in
 * miniature.
 */
export interface WorkspacesTable {
  /** Opaque branded identifier, e.g. `ws_...`. Not a sequential integer. */
  workspace_id: string;
  name: string;
  created_at: Timestamptz;
}

/**
 * The authoritative user-to-tenant edge.
 *
 * A row here means ACTUAL ACCESS. A pending invitation is not a membership and
 * gets its own table in BACKEND-26 — collapsing them would make every
 * authorization query carry a status filter that one caller eventually forgets
 * (§70, §71).
 *
 * Foreign keys to BOTH sides (`workspaces` since 001, `users` since 013), each
 * ON DELETE RESTRICT.
 */
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
 * A workspace document (BACKEND-29).
 *
 * Metadata ONLY. There is no `original_artifact_id` column: the link lives on
 * `document_artifacts.document_id`, where migration 003 put it and migration
 * 016 made it a tenant-safe compound foreign key. Duplicating it here would be
 * two authorities on which bytes belong to a document.
 *
 * No `status` and no `archived_at`. The product has no document-level
 * lifecycle — every status it displays is a TransactionStatus, and archive is a
 * transaction action. See DOCUMENT_LIFECYCLE.md.
 */
export interface DocumentsTable {
  document_id: string;
  /** First-class tenant column. */
  workspace_id: string;
  /** Mutable display metadata. Never a storage key, never an identity. */
  title: string;
  /** What the file arrived as. Write-once, and separate from the title. */
  original_filename: ColumnType<string | null, string | null, string | null>;
  /** Audit metadata, NOT authorization. */
  created_by_user_id: string;
  created_at: Timestamptz;
  updated_at: Timestamptz;
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
  /**
   * Tenant-safe FK to `documents` since migration 016.
   *
   * It carried no foreign key from 003 until then, because there was no
   * `documents` table to point at — so this column named a client-supplied
   * string. It is now `(workspace_id, document_id)` compound-constrained.
   */
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
  /**
   * Pages in THESE bytes, from the upload inspection (migration 016).
   *
   * On the artifact rather than the document because it describes one exact
   * sequence of bytes: a sealed artifact may legitimately differ from the
   * original it derives from. NULL for artifacts written before 016 and for any
   * future artifact type where the question is meaningless.
   */
  page_count: ColumnType<number | null, number | null, number | null>;
  /**
   * How many pages carry a non-zero /Rotate value (migration 017).
   *
   * NULL for artifacts inspected before rotation was captured. Treated as
   * unknown-and-refused by preparation, never as zero — assuming unrotated
   * would silently accept the exact case the column exists to catch.
   */
  rotated_page_count: ColumnType<number | null, number | null, number | null>;
  created_at: GeneratedTimestamptz;
}

/**
 * Document preparation — authoring state (BACKEND-30).
 *
 * Not the document, and NOT a signing request: no `sent_at`, no `expires_at`,
 * no signing status, no recipient authentication. BACKEND-32 owns those.
 *
 * No `state` column — the state is derived from `locked_at`, for the same
 * reason invitation, contact and document state are derived.
 */
export interface DocumentPreparationsTable {
  preparation_id: string;
  workspace_id: string;
  document_id: string;
  /** The EXACT artifact these coordinates were authored against. */
  source_artifact_id: string;
  /** Concurrency metadata for whole-layout saves. Never authorization. */
  revision: ColumnType<number, number | undefined, number>;
  /** NULL means editable. Nothing in BACKEND-30 sets it — BACKEND-32 will. */
  locked_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

/**
 * A placed field.
 *
 * Coordinates are NORMALIZED 0–1, top-left origin, `y` to the field's TOP edge
 * — the model BACKEND-09 established. `double precision` because these are
 * display geometry the renderer multiplies by page dimensions, not money.
 *
 * No `value` column of any kind: preparation records the requirement, never
 * what a signer supplied.
 */
export interface PreparationFieldsTable {
  field_id: string;
  workspace_id: string;
  preparation_id: string;
  /** CHECK-constrained to the nine preparation field types. */
  field_type: string;
  /** 1-based, matching the product. Page 0 is refused. */
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string;
  /** z-order; higher draws on top. */
  layer: number;
  /**
   * The recipient expected to complete this field (migration 018).
   *
   * Replaced BACKEND-30's opaque `participant_slot`. Constrained by a THREE-
   * column foreign key `(workspace_id, preparation_id, recipient_id)`, so a
   * field cannot name a recipient of a different preparation — which tenant
   * isolation alone would not catch, since both rows are in the same workspace.
   *
   * NULL while a layout is being authored; readiness is what requires it.
   */
  recipient_id: ColumnType<string | null, string | null, string | null>;
}

/**
 * A signing participant, snapshotted onto one preparation (BACKEND-31).
 *
 * `name`, `email` and `organization` are COPIES, taken at creation. Nothing
 * dereferences `source_contact_id` to obtain them — that column is provenance,
 * and it becomes NULL if the contact is ever deleted.
 *
 * No `access_token`, no `otp`, no `authenticated_at`, no `signed_at`, no
 * `email_sent_at`: a recipient row says where an invitation is INTENDED to go
 * and proves nothing about who controls that mailbox.
 */
/**
 * A signing request: an immutable snapshot of one coherent preparation state.
 *
 * The row itself is not fully immutable - `state` and `updated_at` change when
 * BACKEND-33 sends it - but every SNAPSHOT column is. Nothing in the
 * application can rewrite `document_title`, `source_artifact_id` or the
 * provenance columns after the insert.
 */
/** Routing activation. NOT ceremony state - BACKEND-37 owns its own table. */
/**
 * A recipient's authenticated signing session.
 *
 * The second authentication realm. Shaped like `user_sessions` and scoped to
 * one request recipient rather than to a user, with the grant it came from
 * recorded so revocation can follow the lineage.
 */
export interface RecipientSigningSessionsTable {
  signing_session_id: string;
  workspace_id: string;
  signing_request_id: string;
  request_recipient_id: string;
  /** Revocation lineage. Which bootstrap credential produced this session. */
  source_grant_id: string;
  /** SHA-256, 64 hex. The raw token exists only in an HttpOnly cookie. */
  token_digest: string;
  /** A SECOND credential, distinct from the session token. A CHECK enforces it. */
  csrf_token_digest: string;
  /** `link-only` today; `email-otp` is declared and unreachable. */
  authentication_method: string;
  authenticated_at: Timestamptz;
  created_at: Timestamptz;
  expires_at: Timestamptz;
  revoked_at: ColumnType<Date | null, Date | null, Date | null>;
  revocation_reason: ColumnType<string | null, string | null, string | null>;
}

export interface SigningRequestRecipientActivationTable {
  workspace_id: string;
  signing_request_id: string;
  request_recipient_id: string;
  /** `waiting` or `active`. Two values, and neither says anything happened. */
  activation_state: string;
  activated_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: Timestamptz;
}

/**
 * A signing bootstrap credential's DIGEST, bound to one recipient of one
 * request.
 *
 * The raw credential is never here. It is sealed into the delivery intent and
 * dropped; this row exists so BACKEND-34 can resolve a submitted link.
 */
export interface SigningAccessGrantsTable {
  grant_id: string;
  workspace_id: string;
  signing_request_id: string;
  request_recipient_id: string;
  /** SHA-256, 64 lowercase hex, domain-separated. CHECK-constrained. */
  credential_digest: string;
  created_at: Timestamptz;
  /** Always set. A permanent bearer credential is a permanent key. */
  expires_at: Timestamptz;
  revoked_at: ColumnType<Date | null, Date | null, Date | null>;
}

/**
 * The durable "send this" record.
 *
 * Carries a delivery SNAPSHOT so a provider retry hours later renders the same
 * email, and the sealed raw credential so it can be rendered at all. Every
 * text column here is PII or business-sensitive and none of it may be logged.
 */
export interface SigningDeliveryIntentsTable {
  delivery_intent_id: string;
  workspace_id: string;
  signing_request_id: string;
  request_recipient_id: string;
  grant_id: string;
  purpose: string;
  recipient_email: string;
  recipient_name: string;
  document_title: string;
  sender_display_name: string;
  workspace_name: string;
  /** AES-256-GCM through SecretBox. The raw TOKEN, never the URL. */
  sealed_credential: string;
  sealed_key_version: string;
  created_at: Timestamptz;
  /** Set by BACKEND-45 when a provider accepts it. NULL means outstanding. */
  dispatched_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface SigningRequestsTable {
  signing_request_id: string;
  workspace_id: string;
  document_id: string;
  /** The EXACT bytes the geometry applies to, not "the current original". */
  source_artifact_id: string;
  /** Provenance. Never read to reconstruct the request. */
  source_preparation_id: string;
  source_preparation_revision: number;
  state: string;
  /** NULL until sent. A CHECK keeps it in step with `state`. */
  sent_at: ColumnType<Date | null, Date | null, Date | null>;
  /** The title AS IT WAS. A rename does not reach a created request. */
  document_title: string;
  created_by_user_id: string;
  created_at: Timestamptz;
  updated_at: Timestamptz;
}

/**
 * A participant, snapshotted onto one signing request.
 *
 * `request_recipient_id` is NOT the preparation recipient's id. BACKEND-34
 * issues access credentials against this one, BACKEND-37 tracks ceremony state
 * against it, and BACKEND-43 cites it - none of which can be built on an id
 * whose row a sender may edit or delete.
 */
export interface SigningRequestRecipientsTable {
  request_recipient_id: string;
  workspace_id: string;
  signing_request_id: string;
  /** PROVENANCE. ON DELETE SET NULL, so the mutable side stays editable. */
  source_preparation_recipient_id: ColumnType<string | null, string | null, string | null>;
  name: string;
  /** The delivery address as it was. Unverified. */
  email: string;
  /** Internal comparison value. Never projected to a client. */
  normalized_email: string;
  organization: ColumnType<string | null, string | null, string | null>;
  recipient_type: string;
  is_required: boolean;
  order_index: number;
  routing_order: number;
  created_at: Timestamptz;
}

/**
 * A field, snapshotted onto one signing request.
 *
 * `request_recipient_id` is NOT NULL here, unlike `preparation_fields`. An
 * unassigned field is a legitimate authoring state and an impossible workflow
 * state, so the readiness gate refuses to snapshot one and the column makes
 * that structural.
 */
export interface SigningRequestFieldsTable {
  request_field_id: string;
  workspace_id: string;
  signing_request_id: string;
  /** PROVENANCE. ON DELETE SET NULL. */
  source_preparation_field_id: ColumnType<string | null, string | null, string | null>;
  field_type: string;
  /** 1-based, matching the canonical coordinate model. */
  page_number: number;
  /** Normalized 0-1, top-left origin. Copied exactly, never recomputed. */
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string;
  layer: number;
  /** A recipient of THIS request. Enforced by a three-column foreign key. */
  request_recipient_id: string;
  created_at: Timestamptz;
}

export interface PreparationRecipientsTable {
  recipient_id: string;
  workspace_id: string;
  preparation_id: string;
  /** PROVENANCE only. ON DELETE SET NULL — a deleted contact leaves this standing. */
  source_contact_id: ColumnType<string | null, string | null, string | null>;
  name: string;
  /** The delivery address, exactly as entered. Unverified. */
  email: string;
  /**
   * The folded comparison key, for the preparation-local duplicate rule.
   *
   * Named `normalized_recipient_email` rather than `normalized_email` so it can
   * never be confused at a call site with the account identity on `users`.
   */
  normalized_recipient_email: string;
  organization: ColumnType<string | null, string | null, string | null>;
  /** CHECK-constrained to the six participant roles. NOT a WorkspaceRole. */
  recipient_type: string;
  /** Whether the workflow waits for this participant. Not a field's `required`. */
  is_required: boolean;
  order_index: number;
  /** The routing step. Equal values mean parallel within a step. */
  routing_order: number;
  created_at: Timestamptz;
  updated_at: Timestamptz;
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

/**
 * Durable idempotency.
 *
 * MIXED TYPED SCOPE and no RLS — the second deliberate exception after
 * sessions. Safety comes from every lookup carrying the full identity, not
 * from a policy that would have to decide what a null workspace means.
 */
export interface IdempotencyRecordsTable {
  record_id: string;
  scope_type: string;
  /** Derived from the typed scope by the application, never client-supplied. */
  scope_key: string;
  operation: string;
  /** SHA-256 of the client key. The raw key is NEVER stored. */
  key_digest: string;
  /** SHA-256 of the canonical logical request. Distinct from key_digest. */
  request_fingerprint: string;
  state: string;
  response_status: ColumnType<number | null, number | null | undefined, number | null>;
  response_body: ColumnType<unknown, string | null | undefined, string | null>;
  response_version: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  expires_at: Timestamptz;
}

/**
 * Abuse counters. One row per (policy, scope, window), not per request.
 *
 * Mixed scope, no RLS — the same pattern as idempotency, and for the same
 * reason: ip/account/challenge scopes have no workspace at all.
 */
export interface RateLimitCountersTable {
  policy: string;
  scope_type: string;
  /** A digest for ip/account/challenge; the plain ID for user/workspace. */
  scope_key: string;
  window_start: Timestamptz;
  count: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamptz;
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

/**
 * Upload processing records (BACKEND-18).
 *
 * Operational and security history for an untrusted file's journey. NOT the
 * document, NOT the artifact, and NOT signing evidence.
 */
export interface DocumentUploadsTable {
  upload_id: string;
  workspace_id: string;
  uploader_user_id: string;
  quarantine_reference: string;
  quarantine_cleared_at: ColumnType<Date | null, Date | null, Date | null>;
  original_filename: string | null;
  client_media_type: string | null;
  detected_media_type: string | null;
  byte_size: ColumnType<string, number | string, number | string>;
  digest_algorithm: ColumnType<string, string | undefined, string>;
  digest: string | null;
  status: string;
  rejection_reason: string | null;
  accepted_artifact_id: string | null;
  scan_outcome: string | null;
  scanned_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  completed_at: ColumnType<Date | null, Date | null, Date | null>;
}


/**
 * Accounts (BACKEND-19). GLOBAL - no workspace_id, no RLS.
 *
 * A user exists before any workspace and may belong to several.
 */
export interface UsersTable {
  user_id: string;
  email: string;
  normalized_email: string;
  password_hash: string;
  display_name: string;
  organization: string | null;
  intended_use: string | null;
  email_verified_at: ColumnType<Date | null, Date | null, Date | null>;
  terms_version: string;
  terms_accepted_at: Timestamptz;
  created_at: ColumnType<Date, Date | undefined, Date>;

  // ── Profile (BACKEND-24) ──────────────────────────────────────────────
  //
  // Nullable because the registration form does not ask for them. `""` would
  // conflate "never filled in" with "deliberately cleared".
  full_name: ColumnType<string | null, string | null, string | null>;
  job_title: ColumnType<string | null, string | null, string | null>;
  department: ColumnType<string | null, string | null, string | null>;
  preferred_sender_name: ColumnType<string | null, string | null, string | null>;

  // ── Preferences (BACKEND-24) ──────────────────────────────────────────
  //
  // Explicit typed columns, not a `preferences jsonb` bag. The closed sets
  // carry database CHECKs, so a value the product cannot render is not
  // storable.
  /** An IANA identifier, e.g. `Asia/Manila`. Never a raw offset. */
  timezone: ColumnType<string | null, string | null, string | null>;
  locale: ColumnType<string | null, string | null, string | null>;
  language: ColumnType<string | null, string | null, string | null>;
  date_format: ColumnType<string | null, string | null, string | null>;
  time_format: ColumnType<string | null, string | null, string | null>;
  number_format: ColumnType<string | null, string | null, string | null>;
  appearance: ColumnType<string | null, string | null, string | null>;
  density: ColumnType<string | null, string | null, string | null>;
  document_list_view: ColumnType<string | null, string | null, string | null>;
  profile_updated_at: ColumnType<Date | null, Date | null, Date | null>;
}

/** Email verification challenges. Holds a DIGEST, never a raw token. */
export interface EmailVerificationChallengesTable {
  challenge_id: string;
  user_id: string;
  token_digest: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamptz;
  consumed_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Set when a resend rotates this challenge. Distinct from consumed. */
  superseded_at: ColumnType<Date | null, Date | null, Date | null>;
}

/**
 * Structurally identical to `EmailVerificationChallengesTable`, and a separate
 * type on purpose.
 *
 * Making them one type would let a verification challenge be passed where a
 * reset challenge is expected — the compiler would accept it, because the rows
 * have the same shape. Separate declarations mean the type system enforces the
 * same credential-domain boundary the two tables do.
 */
export interface PasswordResetChallengesTable {
  challenge_id: string;
  user_id: string;
  /** A digest. The raw reset token is never persisted (INV-280). */
  token_digest: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamptz;
  /** Set when this token successfully replaced a password. */
  consumed_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Set when a later request rotated it, or a successful reset retired it. */
  superseded_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface MfaFactorsTable {
  factor_id: string;
  user_id: string;
  factor_type: string;
  /** AES-256-GCM ciphertext. The only recoverable secret in the schema. */
  secret_ciphertext: ColumnType<string | null, string | null, string | null>;
  secret_key_version: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  verified_at: ColumnType<Date | null, Date | null, Date | null>;
  disabled_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Replay watermark. bigint, so pg hands it back as a string. */
  last_used_time_step: ColumnType<string | null, number | null, number | null>;
}

export interface MfaRecoveryCodesTable {
  recovery_code_id: string;
  user_id: string;
  code_digest: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  consumed_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface PendingAuthenticationsTable {
  pending_id: string;
  user_id: string;
  credential_digest: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamptz;
  consumed_at: ColumnType<Date | null, Date | null, Date | null>;
  revoked_at: ColumnType<Date | null, Date | null, Date | null>;
  failed_attempts: ColumnType<number, number | undefined, number>;
  max_attempts: number;
  authentication_method: string;
}

/**
 * A workspace invitation (BACKEND-26).
 *
 * An authorization OFFER, never access. Separate from `workspace_memberships`
 * on purpose: a pending invitation in the authorization table would make every
 * authorization query depend on a status filter.
 *
 * No `status` column — state is derived from the terminal timestamps plus the
 * clock, because `expired` is a function of `now()` and a stored copy is wrong
 * from the moment it lapses.
 */
export interface WorkspaceInvitationsTable {
  invitation_id: string;
  /** First-class tenant column. */
  workspace_id: string;
  /** What the inviter typed. Rendered back to them; never an identity key. */
  invitee_email: string;
  /** The identity key. CHECK-constrained to be lower case. */
  invitee_normalized_email: string;
  /** CHECK-constrained to the invitable roles. Never `owner`. */
  requested_role: string;
  invited_by_user_id: string;
  /** SHA-256 of the raw token, domain-separated. The raw token is NEVER stored. */
  token_digest: string;
  created_at: Timestamptz;
  expires_at: Timestamptz;
  accepted_at: ColumnType<Date | null, Date | null, Date | null>;
  accepted_by_user_id: ColumnType<string | null, string | null, string | null>;
  revoked_at: ColumnType<Date | null, Date | null, Date | null>;
  declined_at: ColumnType<Date | null, Date | null, Date | null>;
  superseded_at: ColumnType<Date | null, Date | null, Date | null>;
}

/**
 * A workspace address-book entry (BACKEND-28).
 *
 * ── Read the absences ──────────────────────────────────────────────────────
 *
 * No `user_id`. No `verified_at`. No `membership_id`. No `invitation_id`. A
 * contact is data one workspace typed in, and LAGDA has authenticated none of
 * it — a column linking it to an account would make that claim by implication.
 *
 * No `status` column either: state is derived from `archived_at`, so the two
 * cannot disagree.
 */
export interface ContactsTable {
  contact_id: string;
  /** First-class tenant column. */
  workspace_id: string;
  name: string;
  /** Exactly what was typed, case preserved. This is what gets displayed. */
  email: string;
  /**
   * The folded comparison key, for DUPLICATE DETECTION and exact-match search.
   *
   * Named `normalized_contact_email` rather than `normalized_email` so it can
   * never be confused at a call site with `users.normalized_email`, which is an
   * authentication identity. They are the same fold and completely different
   * guarantees, and there is no unique constraint on this one.
   */
  normalized_contact_email: string;
  phone: ColumnType<string | null, string | null, string | null>;
  organization: ColumnType<string | null, string | null, string | null>;
  title: ColumnType<string | null, string | null, string | null>;
  created_at: Timestamptz;
  updated_at: Timestamptz;
  /** NULL means active. The product archives and restores; it never deletes. */
  archived_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface Database {
  workspaces: WorkspacesTable;
  workspace_memberships: WorkspaceMembershipsTable;
  workspace_invitations: WorkspaceInvitationsTable;
  contacts: ContactsTable;
  documents: DocumentsTable;
  document_preparations: DocumentPreparationsTable;
  preparation_fields: PreparationFieldsTable;
  preparation_recipients: PreparationRecipientsTable;
  signing_requests: SigningRequestsTable;
  signing_request_recipients: SigningRequestRecipientsTable;
  signing_request_fields: SigningRequestFieldsTable;
  signing_request_recipient_activation: SigningRequestRecipientActivationTable;
  signing_access_grants: SigningAccessGrantsTable;
  signing_delivery_intents: SigningDeliveryIntentsTable;
  recipient_signing_sessions: RecipientSigningSessionsTable;
  document_artifacts: DocumentArtifactsTable;
  evidence_events: EvidenceEventsTable;
  document_seals: DocumentSealsTable;
  verification_records: VerificationRecordsTable;
  user_sessions: UserSessionsTable;
  idempotency_records: IdempotencyRecordsTable;
  rate_limit_counters: RateLimitCountersTable;
  document_uploads: DocumentUploadsTable;
  users: UsersTable;
  email_verification_challenges: EmailVerificationChallengesTable;
  password_reset_challenges: PasswordResetChallengesTable;
  mfa_factors: MfaFactorsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  pending_authentications: PendingAuthenticationsTable;
  kysely_migration: KyselyMigrationTable;
}
