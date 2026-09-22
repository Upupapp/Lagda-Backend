// Production identifier generators.
//
// Every domain id the application layer mints has, until now, had exactly ONE
// implementation: a `Sequential*` fake in `@lagda/application/test-support`,
// counting `doc_1`, `doc_2`, `doc_3`. Those fakes are correct for tests — a
// test that cannot predict the id it is about to create is a test that has to
// read the id back before it can assert anything.
//
// They are catastrophic in production, in three separate ways:
//
//   RESTART   the counter lives in process memory, so every deploy and every
//             crash restarts it at 1 and the next insert collides with a row
//             created before the restart.
//   REPLICAS  two API processes behind a load balancer both mint `doc_1`.
//             There is no coordination, so the collision is immediate rather
//             than eventual.
//   GUESSABLE `doc_41` tells the holder that `doc_1..40` exist and how to ask
//             for them. Authorization is what actually stops that read, but an
//             enumerable identifier turns any authorization slip into a
//             complete inventory rather than a single leaked row.
//
// This module is what the composition uses instead. It is deliberately in the
// same directory as `crypto.ts` and follows its construction exactly, because
// the two answer the same question — what does the real deployment use where a
// test uses a double — and splitting that answer across two conventions is how
// one of them ends up unmaintained.

import { randomUUID } from "node:crypto";
import type {
  WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  ContactIdGenerator, WorkflowTemplateIdGenerator,
  DocumentIdGenerator, FolderIdGenerator, FolderId,
  PreparationIdGenerator,
  RecipientIdGenerator,
  SigningRequestIdGenerator,
  SigningAccessIdGenerator,
  EvidenceEventIdGenerator,
  ArtifactIdGenerator,
  SealIdGenerator,
  NotificationIntentIdGenerator,
  NotificationDeliveryIdGenerator,
  RecipientSigningSessionIdGenerator,
  SigningWorkflowIdGenerator,
  SigningConsentIdGenerator, SigningConsentId,
  RecipientSubmissionIdGenerator, RecipientSubmissionId,
  SigningFieldValueId, SigningRepresentationId,
  CompletionIdGenerator, CompletionRunId, CompletionStepId,
  OrganizationUnitIdGenerator, OrganizationUnitId,
  VerificationChallengeId, PasswordResetChallengeId,
  MfaFactorId, RecoveryCodeId,
  WorkspaceInvitationIdGenerator,
  PreparationId, PreparationFieldId,
  RecipientId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId,
  EvidenceEventId,
  ArtifactId,
  SealId,
  NotificationIntentId,
  NotificationDeliveryId,
  RecipientSigningSessionId,
  SigningWorkflowIntentId,
} from "@lagda/application";
// Four id types come from the contracts package rather than the application
// one, and the split is not a tidy rule -- it is where each identifier first
// appeared on the wire. A workspace, a member, a contact and a document are all
// named in request paths the client constructs, so the contract owns them; the
// rest are minted server-side and never parsed from a client, so they live with
// the use cases. Worth stating because the import list looks arbitrary
// otherwise, and the next person to add a generator has to pick a side.
import type {
  WorkspaceId, WorkspaceMemberId, ContactId, DocumentId,
  WorkspaceInvitationId, UserId,
} from "@lagda/contracts";

/**
 * A prefixed, unguessable identifier.
 *
 * ── Why a UUID and not a counter, a timestamp or a ULID ────────────────────
 *
 * `randomUUID()` is a CSPRNG draw — 122 bits of entropy, which is not
 * enumerable by any means available to anyone. A ULID or a Snowflake would sort
 * by creation time and give the database better index locality, and both were
 * rejected for the same reason: the time component is readable by whoever holds
 * the id. For a signing grant that is a disclosure — it says when a document
 * was sent — and having two id shapes in one system, one time-bearing and one
 * not, is precisely the distinction nobody remembers at the point of use.
 *
 * ── Why the prefix survives into production ────────────────────────────────
 *
 * It is not decoration and it is not for the database. A prefix makes the id
 * self-describing in a log line, an error report and a support conversation,
 * and it makes a mis-wired generator obvious on sight: a `doc_` where a `sr_`
 * belongs is a visible defect rather than an opaque string that happens to
 * resolve to nothing. The fakes already use these exact prefixes, so a value
 * that appears in a test reads the same as one from production.
 *
 * Hyphens are stripped: 4-6 characters of prefix plus 32 hex is 36-38
 * characters, comfortably inside the `varchar(64)` every id column declares,
 * with room for a longer prefix later. The stripped form is also safe in a URL
 * path segment without escaping, which several of these ids are.
 */
function mint(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function createWorkspaceIdGenerator(): WorkspaceIdGenerator {
  return { nextWorkspaceId: () => mint("ws") as WorkspaceId };
}

export function createWorkspaceMemberIdGenerator(): WorkspaceMemberIdGenerator {
  return { nextWorkspaceMemberId: () => mint("mem") as WorkspaceMemberId };
}

export function createWorkflowTemplateIdGenerator(): WorkflowTemplateIdGenerator {
  return { nextWorkflowTemplateId: () => mint("wft") };
}

export function createContactIdGenerator(): ContactIdGenerator {
  return { nextContactId: () => mint("con") as ContactId };
}

export function createDocumentIdGenerator(): DocumentIdGenerator {
  return { nextDocumentId: () => mint("doc") as DocumentId };
}

export function createFolderIdGenerator(): FolderIdGenerator {
  return { nextFolderId: () => mint("fld") as FolderId };
}

/**
 * Preparations and their fields.
 *
 * Two methods on one generator because the port declares them together, and
 * one draw per call rather than a shared value: a field id that embedded its
 * preparation id would make the parent recoverable from the child, which is the
 * kind of derivable relationship that turns one leaked id into two.
 */
export function createPreparationIdGenerator(): PreparationIdGenerator {
  return {
    nextPreparationId: () => mint("prep") as PreparationId,
    nextPreparationFieldId: () => mint("pf") as PreparationFieldId,
  };
}

export function createRecipientIdGenerator(): RecipientIdGenerator {
  return { nextRecipientId: () => mint("rcp") as RecipientId };
}

export function createSigningRequestIdGenerator(): SigningRequestIdGenerator {
  return {
    nextSigningRequestId: () => mint("sr") as SigningRequestId,
    nextSigningRequestRecipientId: () =>
      mint("srr") as SigningRequestRecipientId,
    nextSigningRequestFieldId: () => mint("srf") as SigningRequestFieldId,
  };
}

/**
 * The signing access grant.
 *
 * An INTERNAL handle, not the recipient's credential. The credential is minted
 * by `createSigningAccessTokenFactory` and is a secret; this is the row it
 * points at. Keeping them separate matters: the grant id appears in evidence
 * records and audit output, and if it were the credential every audit reader
 * would hold the means to sign.
 */
export function createSigningAccessIdGenerator(): SigningAccessIdGenerator {
  return { nextSigningAccessGrantId: () => mint("sag") as SigningAccessGrantId };
}

export function createEvidenceEventIdGenerator(): EvidenceEventIdGenerator {
  return { nextEvidenceEventId: () => mint("ev") as EvidenceEventId };
}

/**
 * The upload attempt, distinct from the artifact it may produce.
 *
 * A rejected upload has an id and no artifact; an accepted one has both. One
 * id serving as both would make "this upload failed scanning" and "this
 * artifact exists" the same row.
 */
export const nextUploadId = (): string => mint("upl");

export function createArtifactIdGenerator(): ArtifactIdGenerator {
  return { nextArtifactId: () => mint("art") as ArtifactId };
}

export function createSealIdGenerator(): SealIdGenerator {
  return { nextSealId: () => mint("seal") as SealId };
}

export function createNotificationIntentIdGenerator(): NotificationIntentIdGenerator {
  return { nextNotificationIntentId: () => mint("nint") as NotificationIntentId };
}

export function createNotificationDeliveryIdGenerator(): NotificationDeliveryIdGenerator {
  return {
    nextNotificationDeliveryId: () => mint("ndel") as NotificationDeliveryId,
  };
}

export function createRecipientSigningSessionIdGenerator(): RecipientSigningSessionIdGenerator {
  return {
    nextRecipientSigningSessionId: () =>
      mint("rss") as RecipientSigningSessionId,
  };
}

export function createSigningWorkflowIdGenerator(): SigningWorkflowIdGenerator {
  return {
    nextSigningWorkflowIntentId: () => mint("swi") as SigningWorkflowIntentId,
  };
}

/**
 * The recipient's own writes: a consent, a submission, and what it contains.
 *
 * ONE generator for the three submission ids because they are minted together
 * in one transaction and never separately -- a field value belongs to the
 * submission that carried it.
 */
export function createSigningConsentIdGenerator(): SigningConsentIdGenerator {
  return {
    nextSigningConsentId: () => mint("scn") as SigningConsentId,
  };
}

export function createRecipientSubmissionIdGenerator(): RecipientSubmissionIdGenerator {
  return {
    nextRecipientSubmissionId: () => mint("sub") as RecipientSubmissionId,
    nextSigningFieldValueId: () => mint("sfv") as SigningFieldValueId,
    nextSigningRepresentationId: () => mint("srp") as SigningRepresentationId,
  };
}

/**
 * The completion pipeline's run and its steps.
 *
 * Nothing supplied these before, which is consistent: the pipeline was one of
 * the surfaces `NOT_WIRED_IN_PRODUCTION` records, so no composition had ever
 * needed them.
 */
export function createCompletionIdGenerator(): CompletionIdGenerator {
  return {
    nextCompletionRunId: () => mint("crun") as CompletionRunId,
    nextCompletionStepId: () => mint("cstp") as CompletionStepId,
  };
}

export function createWorkspaceInvitationIdGenerator(): WorkspaceInvitationIdGenerator {
  return {
    nextWorkspaceInvitationId: () => mint("inv") as WorkspaceInvitationId,
  };
}

/**
 * Organization units: departments, offices, teams.
 *
 * One generator for all three, because a unit's KIND is a column and not a
 * separate entity -- the hierarchy is one table and a department may hold a
 * team. Prefixing by kind would put that classification inside the identifier,
 * where it could not be changed without rewriting every row that referenced it.
 */
export function createOrganizationUnitIdGenerator(): OrganizationUnitIdGenerator {
  return {
    nextOrganizationUnitId: () => mint("unit") as OrganizationUnitId,
  };
}

// ── Identity ─────────────────────────────────────────────────────────────────
//
// These are not grouped behind generator INTERFACES the way the entity ids are:
// the identity use cases each declare a bare `newUserId: () => UserId`, so the
// ports are function types rather than objects. They are minted the same way
// regardless, and they live here for the same reason -- production must not
// reach for the dev server's `usr_dev_1`.

/** The account. Appears in logs, in evidence and in every session row. */
export const nextUserId = (): UserId => mint("usr") as UserId;

/**
 * The email-verification challenge.
 *
 * The challenge id is NOT the credential -- the emailed token is, and it is
 * stored only as a digest. This id identifies the row, so it is safe in a log
 * line, and the dev server's `evc_${Date.now()}` was not merely predictable but
 * COLLIDING: two registrations in the same millisecond produced one id.
 */
export const nextVerificationChallengeId = (): VerificationChallengeId =>
  mint("evc") as VerificationChallengeId;

export const nextPasswordResetChallengeId = (): PasswordResetChallengeId =>
  mint("prc") as PasswordResetChallengeId;

export const nextMfaFactorId = (): MfaFactorId => mint("mfa") as MfaFactorId;

export const nextRecoveryCodeId = (): RecoveryCodeId =>
  mint("rc") as RecoveryCodeId;

/**
 * The pre-authentication record, between password and second factor.
 *
 * Short-lived and holding a digest of a credential the client must return, so
 * it is the one identity id where guessability would matter directly.
 */
export const nextPendingAuthenticationId = (): string => mint("pna");
