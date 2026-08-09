// Evidence, artifact and finalization persistence ports.
//
// Four database tables, THREE repositories. Grouping follows aggregates, not
// tables: a seal and its verification record are written at one moment, always
// together, and a seal without a verification record is not a state the product
// has. Giving them separate repositories would make that pairing a convention
// two callers have to remember instead of a signature they cannot get wrong.

import type {
  WorkspaceId, DocumentId, TransactionId, VerificationId, Sha256Digest,
} from "@lagda/contracts";

// ── Identifiers ──────────────────────────────────────────────────────────────
//
// Backend-owned, NOT added to @lagda/contracts. Neither identifier crosses a
// public boundary: evidence events are never addressed individually by the
// frontend, and an artifact is reached through its document. Adding them to the
// shared package would widen the frontend's surface for nothing.
//
// `VerificationId` is the opposite case and already lives in contracts, because
// it is the one identifier the public is expected to hold.

export type EvidenceEventId = string & { readonly __brand: "EvidenceEventId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
export type SealId = string & { readonly __brand: "SealId" };
/** A recipient of a signing request. Not a `UserId` — see `ActorType`. */
export type RecipientId = string & { readonly __brand: "RecipientId" };

export interface EvidenceEventIdGenerator {
  nextEvidenceEventId(): EvidenceEventId;
}

export interface ArtifactIdGenerator {
  nextArtifactId(): ArtifactId;
}

export interface SealIdGenerator {
  nextSealId(): SealId;
}

/**
 * Generates the PUBLIC verification identity, `LAGDA-{workspace}-{date}-{random}`.
 *
 * Separate from the entity generators above because the requirements differ in
 * kind: this value is published, so it must be unguessable. An entity ID only
 * has to be unique. Merging them would let a routine ID generator quietly
 * become the source of a public secret-adjacent value.
 *
 * It is NOT authentication. Possessing one permits a curated public lookup and
 * nothing else — never document access, never signing access.
 */
export interface VerificationIdGenerator {
  nextVerificationId(workspaceId: WorkspaceId, at: number): VerificationId;
}

// ── Evidence events ──────────────────────────────────────────────────────────

/**
 * The signing-evidence vocabulary — a SUBSET of the audit trail.
 *
 * Delivery outcomes (`invitation-delivered`, `-bounced`, `-opened`) are absent
 * on purpose: a bounce is a fact about an email provider, not about a signer.
 * Settings changes are absent for the same reason. Both belong to BACKEND-43/44.
 *
 * These are EVENTS, not statuses. `document-viewed` is a permanent historical
 * fact; the recipient's status may still be awaiting-signature afterwards.
 */
export const EVIDENCE_EVENT_TYPES = [
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
export type EvidenceEventType = (typeof EVIDENCE_EVENT_TYPES)[number];

/**
 * Who acted.
 *
 * A recipient is not a workspace user — external signers have no LAGDA account.
 * Modelling every actor as a `UserId` would force either fake user rows or a
 * meaningless `actor_id` on most signing evidence.
 */
export const ACTOR_TYPES = ["workspace-user", "recipient", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * The actor, as a discriminated union.
 *
 * A `system` actor carries no ID at all rather than a nullable one. Inventing a
 * synthetic user for the expiry worker would make "who did this" unanswerable
 * for every automated action, and the database rejects the combination anyway.
 */
export type EvidenceActor =
  | { readonly type: "workspace-user"; readonly actorId: string }
  | { readonly type: "recipient"; readonly actorId: RecipientId }
  | { readonly type: "system" };

/**
 * Server-observed request context.
 *
 * Observed by the API from the connection, never read from a request body. A
 * client that can name its own IP address is describing itself, not being
 * observed — and evidence built from that is decoration.
 *
 * Absent for system and worker events, which have no client. Absent for
 * everything until BACKEND-11/56 establishes trusted proxy configuration.
 */
export interface ObservedRequestContext {
  /** Canonical IP text. Derived from the connection after proxy trust is configured. */
  readonly clientIp?: string;
  /** Untrusted client-supplied header. Bounded, and never rendered unescaped. */
  readonly clientUserAgent?: string;
}

/** Event-specific detail. Validated per event type before it is written. */
export interface EvidenceDetails {
  readonly version: number;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

/**
 * An evidence event to append.
 *
 * `occurredAt` comes from the application `Clock`. There is deliberately no
 * `recordedAt` here: the database stamps it, because "when the row was durably
 * written" is not something the caller can honestly claim to know.
 */
export interface EvidenceEventInput {
  readonly evidenceEventId: EvidenceEventId;
  readonly signingRequestId: TransactionId;
  readonly documentId?: DocumentId;
  readonly recipientId?: RecipientId;
  readonly eventType: EvidenceEventType;
  readonly actor: EvidenceActor;
  readonly occurredAt: number;
  readonly observed?: ObservedRequestContext;
  readonly details?: EvidenceDetails;
}

export interface EvidenceEventRecord extends EvidenceEventInput {
  readonly workspaceId: WorkspaceId;
  /** Database-stamped. Differs from `occurredAt` when a worker records after the fact. */
  readonly recordedAt: number;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

/**
 * Byte-distinct artifact types. Exactly three.
 *
 * No `prepared`: handoff §8 merges fields AFTER signing, and §9 versions storage
 * as "original + signed final". Preparation produces field metadata, so a
 * `prepared` artifact would describe bytes that never exist.
 */
export const ARTIFACT_TYPES = ["original", "sealed", "completion-certificate"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * An immutable artifact record.
 *
 * Written only once the bytes are authoritative in storage. There is no
 * `pending` state and no way to fill the storage reference in later, because
 * the runtime role has no UPDATE privilege — which forces the correct ordering
 * rather than trusting a caller to follow it.
 */
export interface ArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly artifactType: ArtifactType;
  /** LAGDA-owned opaque reference. No S3 bucket or key semantics cross this port. */
  readonly storageReference: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digestAlgorithm: "sha-256";
  readonly digest: Sha256Digest;
  /** Provenance as a relation. Ancestry is never inferred from naming. */
  readonly sourceArtifactId?: ArtifactId;
  readonly createdAt: number;
}

// ── Finalization: seal + verification, written together ──────────────────────

export interface SealRecord {
  readonly sealId: SealId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: TransactionId;
  readonly sealedArtifactId: ArtifactId;
  readonly certificateArtifactId?: ArtifactId;
  /** Recorded from the first row. Never defaulted, never inferred. */
  readonly sealScheme: "hash-evidence";
  readonly sealVersion: number;
  readonly digestAlgorithm: "sha-256";
  /** Handoff §17's `documentHash` — the original file at upload. */
  readonly originalDocumentHash: Sha256Digest;
  readonly signedDocumentHash: Sha256Digest;
  readonly sealedAt: number;
}

export interface VerificationRecord {
  readonly verificationId: VerificationId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: TransactionId;
  readonly documentId: DocumentId;
  readonly sealId: SealId;
  readonly completedAt: number;
  readonly participantCount: number;
}

/** A seal and its verification record. Never one without the other. */
export interface FinalizationInput {
  readonly seal: SealRecord;
  readonly verification: VerificationRecord;
}

// ── Public verification projection ───────────────────────────────────────────

/**
 * What an anonymous verifier may see. An explicit ALLOWLIST, not a filtered row.
 *
 * Built by naming each field rather than by removing fields from a record type,
 * because a `Omit<VerificationRecord, "workspaceId">` silently starts exposing
 * anything a later command adds to the source type.
 *
 * Deliberately absent: evidence events, IP addresses, user agents, storage
 * references, recipient identities, internal IDs, and the workspace ID.
 */
export interface PublicVerificationProjection {
  readonly verificationId: VerificationId;
  readonly completedAt: number;
  readonly participantCount: number;
  readonly signedDocumentHash: Sha256Digest;
  readonly originalDocumentHash: Sha256Digest;
  readonly digestAlgorithm: "sha-256";
  readonly sealScheme: "hash-evidence";
  readonly sealVersion: number;
}

// ── Scoped repositories ──────────────────────────────────────────────────────

/**
 * Append-only evidence.
 *
 * There is no `update`, no `delete`, no `replace`, and their absence is backed
 * by database privileges rather than restraint — the runtime role holds INSERT
 * and SELECT only. Handoff §32 requires an append-only store.
 */
export interface ScopedEvidenceRepository {
  append(event: EvidenceEventInput): Promise<void>;

  /**
   * Deterministically ordered: `occurredAt` ascending, then `evidenceEventId`.
   *
   * The second key is not decoration. Two recipients can act in the same
   * millisecond, and timestamp-only ordering would return them in whatever
   * order the planner chose that day.
   */
  listForSigningRequest(signingRequestId: TransactionId): Promise<readonly EvidenceEventRecord[]>;
}

export interface ScopedArtifactRepository {
  insert(artifact: ArtifactRecord): Promise<void>;
  find(artifactId: ArtifactId): Promise<ArtifactRecord | null>;
  listForDocument(documentId: DocumentId): Promise<readonly ArtifactRecord[]>;
}

export interface ScopedFinalizationRepository {
  /**
   * Writes the seal and its verification record together.
   *
   * One method, not two, so a seal cannot exist without the verification record
   * that makes it discoverable. Both rows land in the caller's transaction.
   *
   * @throws on a second finalization of the same signing request. Resealing is
   *         not a product feature; a completion retry must converge on the
   *         existing row rather than create a competing one.
   */
  recordFinalization(input: FinalizationInput): Promise<void>;

  findBySigningRequest(signingRequestId: TransactionId): Promise<SealRecord | null>;
}

// ── Public lookup: a narrow, deliberate exception to tenant scope ────────────

/**
 * Resolves a verification ID with NO workspace context.
 *
 * Separate from the unit of work on purpose. The ordinary tenant repositories
 * cannot serve this — a public verifier has no workspace — but that must not
 * become a general-purpose global reader. So the capability is exactly one
 * method returning exactly the public projection, and there is no way to ask it
 * for anything else.
 *
 * Returns `null` for both "no such record" and any restricted case: an
 * anonymous caller must not be able to distinguish them, or the endpoint
 * becomes an oracle for which verification IDs exist.
 */
export interface PublicVerificationLookup {
  findByVerificationId(verificationId: VerificationId): Promise<PublicVerificationProjection | null>;
}
