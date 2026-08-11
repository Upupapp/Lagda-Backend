// PostgreSQL adapters for evidence, artifacts and finalization.
//
// Every read and write goes through the transaction handed in, never the pool.
// That is not stylistic: RLS context is set with `SET LOCAL`, which lives on the
// transaction's connection. A read on the pool would run without tenant context
// and see nothing — a workspace unable to read its own evidence, which is how
// this class of bug presented in BACKEND-07.

import type { Selectable, Transaction } from "kysely";
import type {
  WorkspaceId, DocumentId, TransactionId, VerificationId, Sha256Digest,
} from "@lagda/contracts";
import type {
  ScopedEvidenceRepository, ScopedArtifactRepository, ScopedFinalizationRepository,
  PublicVerificationLookup, PublicVerificationProjection, EvidenceSourceType,
  EvidenceEventInput, EvidenceEventRecord, EvidenceActor, EvidenceEventType,
  EvidenceEventId, ArtifactId, ArtifactRecord, ArtifactType, SealId, SealRecord,
  FinalizationInput, SigningRequestRecipientId,
} from "@lagda/application";
import { toStorageObjectKey } from "@lagda/application";
import type { Database, DocumentArtifactsTable } from "../schema/index.js";
import { translatePersistenceError, WorkspaceScopeMismatchError } from "../errors.js";

type Trx = Transaction<Database>;

/** `bigint` arrives as a string from the driver. Parsed once, at the boundary. */
function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function assertScope(scope: WorkspaceId, actual: WorkspaceId, entity: string): void {
  if (scope !== actual) {
    // Rejected, never silently rewritten to match. Rewriting would turn a
    // programmer error into a record moving between tenants.
    throw new WorkspaceScopeMismatchError(entity, scope, actual);
  }
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export function createEvidenceRepository(
  trx: Trx,
  scope: WorkspaceId,
): ScopedEvidenceRepository {
  return {
    async append(event: EvidenceEventInput): Promise<void> {
      // The actor union collapses to two columns here. A `system` actor has no
      // ID, and the database CHECK rejects any other combination — so this
      // mapping cannot drift from the constraint without failing loudly.
      const actorId = event.actor.type === "system" ? null : event.actor.actorId;

      try {
        await trx
          .insertInto("evidence_events")
          .values({
            evidence_event_id: event.evidenceEventId,
            workspace_id: scope,
            signing_request_id: event.signingRequestId,
            document_id: event.documentId ?? null,
            recipient_id: event.recipientId ?? null,
            event_type: event.eventType,
            event_version: event.eventVersion,
            actor_type: event.actor.type,
            actor_id: actorId,
            occurred_at: new Date(event.occurredAt),
            // recorded_at is NOT supplied. The database stamps it, because
            // "when this row was durably written" is not something the caller
            // can honestly claim to know.
            // Both or neither, mirroring the biconditional CHECK. Read from one
            // optional object so the pair cannot be split here either.
            source_type: event.source?.type ?? null,
            source_id: event.source?.id ?? null,
            client_ip: event.observed?.clientIp ?? null,
            client_user_agent: event.observed?.clientUserAgent ?? null,
            details: event.details ? JSON.stringify(event.details.payload) : null,
            details_version: event.details?.version ?? null,
          })
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async listForSigningRequest(
      signingRequestId: TransactionId,
    ): Promise<readonly EvidenceEventRecord[]> {
      const rows = await trx
        .selectFrom("evidence_events")
        .selectAll()
        // No workspace predicate is possible to omit here — `scope` is bound,
        // not passed — and RLS backs it up. Both, deliberately.
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        // A TOTAL order. `occurred_at` alone is not one: two recipients can act
        // in the same millisecond, and the planner is free to return those two
        // rows in either order on any given day.
        .orderBy("occurred_at", "asc")
        .orderBy("evidence_event_id", "asc")
        .execute();

      return rows.map((row): EvidenceEventRecord => {
        const actor: EvidenceActor =
          row.actor_type === "system"
            ? { type: "system" }
            : row.actor_type === "recipient"
              ? {
                type: "recipient",
                // The IMMUTABLE signing-request recipient, not the mutable
                // preparation one — see the note on the port.
                actorId: (row.actor_id ?? "") as SigningRequestRecipientId,
              }
              : { type: "workspace-user", actorId: row.actor_id ?? "" };

        return {
          evidenceEventId: row.evidence_event_id as EvidenceEventId,
          workspaceId: row.workspace_id as WorkspaceId,
          signingRequestId: row.signing_request_id as TransactionId,
          ...(row.document_id === null ? {} : { documentId: row.document_id as DocumentId }),
          ...(row.recipient_id === null
            ? {}
            : { recipientId: row.recipient_id as SigningRequestRecipientId }),
          eventType: row.event_type as EvidenceEventType,
          eventVersion: row.event_version,
          actor,
          // Read back as the same paired object it was written from. The
          // biconditional CHECK guarantees the halves agree, so testing one is
          // testing both — but the pair is reconstructed whole rather than as
          // two independently-optional fields, which is what keeps a projection
          // from ever seeing a type without an id.
          ...(row.source_type === null || row.source_id === null
            ? {}
            : {
                source: {
                  type: row.source_type as EvidenceSourceType,
                  id: row.source_id,
                },
              }),
          occurredAt: row.occurred_at.getTime(),
          recordedAt: row.recorded_at.getTime(),
          ...(row.client_ip === null && row.client_user_agent === null
            ? {}
            : {
                observed: {
                  ...(row.client_ip === null ? {} : { clientIp: row.client_ip }),
                  ...(row.client_user_agent === null
                    ? {}
                    : { clientUserAgent: row.client_user_agent }),
                },
              }),
          ...(row.details === null || row.details_version === null
            ? {}
            : {
                details: {
                  version: row.details_version,
                  payload: row.details as Readonly<Record<string, string | number | boolean>>,
                },
              }),
        };
      });
    },
  };
}

// ── Artifacts ────────────────────────────────────────────────────────────────

// `Selectable<>` rather than a hand-written row shape. A hand-written one drifts
// from the table the moment a column is added, and drifts SILENTLY when the
// change is compatible.
function toArtifact(row: Selectable<DocumentArtifactsTable>): ArtifactRecord {
  return {
    artifactId: row.artifact_id as ArtifactId,
    workspaceId: row.workspace_id as WorkspaceId,
    documentId: row.document_id as DocumentId,
    artifactType: row.artifact_type as ArtifactType,
    storageReference: toStorageObjectKey(row.storage_reference),
    mediaType: row.media_type,
    sizeBytes: toNumber(row.size_bytes),
    digestAlgorithm: row.digest_algorithm as "sha-256",
    digest: row.digest as Sha256Digest,
    ...(row.source_artifact_id === null
      ? {}
      : { sourceArtifactId: row.source_artifact_id as ArtifactId }),
    // Omitted rather than null when absent, matching `sourceArtifactId`: the
    // port declares it optional, and `exactOptionalPropertyTypes` distinguishes
    // "no page count" from "a page count that is null".
    ...(row.page_count === null ? {} : { pageCount: row.page_count }),
    ...(row.rotated_page_count === null
      ? {}
      : { rotatedPageCount: row.rotated_page_count }),
    createdAt: row.created_at.getTime(),
  };
}

export function createArtifactRepository(
  trx: Trx,
  scope: WorkspaceId,
): ScopedArtifactRepository {
  return {
    async insert(artifact: ArtifactRecord): Promise<void> {
      assertScope(scope, artifact.workspaceId, "Artifact");
      try {
        await trx
          .insertInto("document_artifacts")
          .values({
            artifact_id: artifact.artifactId,
            workspace_id: scope,
            document_id: artifact.documentId,
            artifact_type: artifact.artifactType,
            storage_reference: artifact.storageReference,
            media_type: artifact.mediaType,
            size_bytes: artifact.sizeBytes,
            digest_algorithm: artifact.digestAlgorithm,
            digest: artifact.digest,
            source_artifact_id: artifact.sourceArtifactId ?? null,
            page_count: artifact.pageCount ?? null,
            rotated_page_count: artifact.rotatedPageCount ?? null,
          })
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(artifactId: ArtifactId): Promise<ArtifactRecord | null> {
      const row = await trx
        .selectFrom("document_artifacts")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("artifact_id", "=", artifactId)
        .executeTakeFirst();
      return row ? toArtifact(row) : null;
    },

    async listForDocument(documentId: DocumentId): Promise<readonly ArtifactRecord[]> {
      const rows = await trx
        .selectFrom("document_artifacts")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("document_id", "=", documentId)
        .orderBy("created_at", "asc")
        .orderBy("artifact_id", "asc")
        .execute();
      return rows.map(toArtifact);
    },
  };
}

// ── Finalization ─────────────────────────────────────────────────────────────

export function createFinalizationRepository(
  trx: Trx,
  scope: WorkspaceId,
): ScopedFinalizationRepository {
  return {
    async recordFinalization(input: FinalizationInput): Promise<void> {
      const { seal, verification } = input;
      assertScope(scope, seal.workspaceId, "Seal");
      assertScope(scope, verification.workspaceId, "VerificationRecord");

      // Both rows, one method, one transaction. A seal without its verification
      // record would be a completed document nobody can look up.
      try {
        await trx
          .insertInto("document_seals")
          .values({
            seal_id: seal.sealId,
            workspace_id: scope,
            signing_request_id: seal.signingRequestId,
            sealed_artifact_id: seal.sealedArtifactId,
            certificate_artifact_id: seal.certificateArtifactId ?? null,
            seal_scheme: seal.sealScheme,
            seal_version: seal.sealVersion,
            digest_algorithm: seal.digestAlgorithm,
            original_document_hash: seal.originalDocumentHash,
            signed_document_hash: seal.signedDocumentHash,
            sealed_at: new Date(seal.sealedAt),
          })
          .execute();

        await trx
          .insertInto("verification_records")
          .values({
            verification_id: verification.verificationId,
            workspace_id: scope,
            signing_request_id: verification.signingRequestId,
            document_id: verification.documentId,
            seal_id: verification.sealId,
            completed_at: new Date(verification.completedAt),
            participant_count: verification.participantCount,
          })
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async findBySigningRequest(signingRequestId: TransactionId): Promise<SealRecord | null> {
      const row = await trx
        .selectFrom("document_seals")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .executeTakeFirst();

      if (!row) return null;
      return {
        sealId: row.seal_id as SealId,
        workspaceId: row.workspace_id as WorkspaceId,
        signingRequestId: row.signing_request_id as TransactionId,
        sealedArtifactId: row.sealed_artifact_id as ArtifactId,
        ...(row.certificate_artifact_id === null
          ? {}
          : { certificateArtifactId: row.certificate_artifact_id as ArtifactId }),
        sealScheme: row.seal_scheme as "hash-evidence",
        sealVersion: row.seal_version,
        digestAlgorithm: row.digest_algorithm as "sha-256",
        originalDocumentHash: row.original_document_hash as Sha256Digest,
        signedDocumentHash: row.signed_document_hash as Sha256Digest,
        sealedAt: row.sealed_at.getTime(),
      };
    },
  };
}

// ── Public verification lookup ───────────────────────────────────────────────

/**
 * The one query in the backend that runs with NO tenant context.
 *
 * It is deliberately built as a standalone function rather than a method on the
 * unit of work, so nothing that holds a workspace transaction can reach it and
 * nothing that holds this can reach anything else.
 *
 * Two properties make it safe, and both are structural:
 *
 *   1. It selects exactly the public columns. Not `selectAll()` with a mapper —
 *      a mapper is one careless spread away from returning the whole row, and a
 *      later command adding a column would widen the public surface silently.
 *   2. It runs as the OWNER, outside RLS, which is why (1) matters so much.
 *
 * @param runGlobal a transaction runner with no workspace context
 */
export function createPublicVerificationLookup(
  runGlobal: <T>(operation: (trx: Trx) => Promise<T>) => Promise<T>,
): PublicVerificationLookup {
  return {
    async findByVerificationId(
      verificationId: VerificationId,
    ): Promise<PublicVerificationProjection | null> {
      return runGlobal(async (trx) => {
        const row = await trx
          .selectFrom("verification_records")
          .innerJoin("document_seals", (join) =>
            join
              .onRef("document_seals.seal_id", "=", "verification_records.seal_id")
              // Joined on workspace too. Without it the join would be a path
              // across tenants if a seal ID ever collided between workspaces.
              .onRef("document_seals.workspace_id", "=", "verification_records.workspace_id"),
          )
          .select([
            "verification_records.verification_id",
            "verification_records.completed_at",
            "verification_records.participant_count",
            "document_seals.signed_document_hash",
            "document_seals.original_document_hash",
            "document_seals.digest_algorithm",
            "document_seals.seal_scheme",
            "document_seals.seal_version",
          ])
          // §21, §23, §121: a verification record is not sufficient on its own.
          //
          // The record and the completion are written in the SAME transaction
          // by BACKEND-41, so today they cannot disagree — but "cannot
          // disagree because of how the writer happens to work" is not a
          // guarantee a PUBLIC endpoint should rest on. These joins make the
          // requirement structural: no successful completion row and no
          // `completed` request means no public verification, whatever the
          // verification table says.
          .innerJoin("signing_request_completions", join => join
            .onRef("signing_request_completions.signing_request_id", "=",
              "verification_records.signing_request_id")
            .onRef("signing_request_completions.workspace_id", "=",
              "verification_records.workspace_id"))
          .innerJoin("signing_requests", join => join
            .onRef("signing_requests.signing_request_id", "=",
              "verification_records.signing_request_id")
            .onRef("signing_requests.workspace_id", "=",
              "verification_records.workspace_id"))
          .where("signing_requests.state", "=", "completed")
          .where("verification_records.verification_id", "=", verificationId)
          .executeTakeFirst();

        // `null` for absent AND for anything restricted. An anonymous caller
        // that could tell the two apart would have an oracle for which
        // verification IDs exist.
        if (!row) return null;

        return {
          verificationId: row.verification_id as VerificationId,
          completedAt: row.completed_at.getTime(),
          participantCount: row.participant_count,
          signedDocumentHash: row.signed_document_hash as Sha256Digest,
          originalDocumentHash: row.original_document_hash as Sha256Digest,
          digestAlgorithm: row.digest_algorithm as "sha-256",
          sealScheme: row.seal_scheme as "hash-evidence",
          sealVersion: row.seal_version,
        };
      });
    },
  };
}
