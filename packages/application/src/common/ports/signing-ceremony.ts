// Signing ceremony ports (BACKEND-35).
//
// ── The shape that carries the security property ───────────────────────────
//
// `RecipientCeremonyRepository` is bound at construction to one workspace, one
// request and one recipient — all three from the trusted session — and its
// read methods take NO identifying arguments.
//
// That is deliberate and it is the main design decision in this file. A
// repository with `listFields(recipientId)` can be called with the wrong
// recipient id; one with `listAssignedFields()` cannot. The client is not
// prevented from asking for another recipient's fields — there is no way to
// express the question. §5, §50 and §243 are satisfied by the type rather than
// by a check somebody has to remember to write.
//
// The database agrees independently: migration 022's restrictive policies bind
// every ceremony read to the session's own recipient, so a repository bug
// still returns nothing.

import type { WorkspaceId } from "@lagda/contracts";
import type { RecipientSubmissionRepository } from "./signing-submission.js";
import type { RecipientWorkflowRepository } from "./signing-workflow.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { ArtifactId, ScopedEvidenceRepository } from "./evidence.js";
import type { StorageObjectKey } from "./storage.js";
import type { RecipientActivationState } from "./signing-access.js";
import type {
  SigningRequestRecord, SigningRequestRecipientRecord, SigningRequestFieldRecord,
  SigningRequestId, SigningRequestRecipientId,
} from "./signing-requests.js";
import type {
  RecipientSigningSessionId, RecipientAuthenticationMethod,
} from "./signing-sessions.js";

export type SigningConsentId = string & { readonly __brand: "SigningConsentId" };

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * The exact artifact a request froze, with the metadata needed to serve it.
 *
 * `storageReference` is INTERNAL. It reaches the object-storage adapter and
 * nothing else — never a DTO, never a log line, never a header. §23.
 */
export interface CeremonyArtifactRecord {
  readonly artifactId: ArtifactId;
  /** Validated at upload. Never a client claim about content type. §28. */
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: string;
  /** `null` for artifacts inspected before page counting existed (016). */
  readonly pageCount: number | null;
  readonly storageReference: StorageObjectKey;
}

/** That this recipient entered the ceremony, once. */
export interface CeremonyProgressRecord {
  readonly firstEnteredAt: number;
}

/** One acceptance of one disclosure version. */
export interface CeremonyConsentRecord {
  readonly consentType: string;
  readonly consentVersion: string;
  readonly acceptedAt: number;
}

export interface NewCeremonyConsent {
  readonly consentId: SigningConsentId;
  readonly consentType: string;
  readonly consentVersion: string;
  readonly acceptedAt: number;
  readonly signingSessionId: RecipientSigningSessionId;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly createdAt: number;
}

// ── The repository ───────────────────────────────────────────────────────────

/**
 * Everything a ceremony may read or write, and nothing else.
 *
 * No `listRequests`, no `findDocument`, no `listRecipients`. A recipient realm
 * that cannot name those operations cannot perform them (§179, §180).
 */
export interface RecipientCeremonyRepository {
  /** The immutable request snapshot. `null` if it vanished mid-session. */
  getRequest(): Promise<SigningRequestRecord | null>;
  /**
   * THIS recipient's snapshot row. Not the request's recipient list.
   *
   * There is no method that returns the others, which is what makes "other
   * recipient PII is not exposed" structural rather than a DTO discipline.
   */
  getRecipient(): Promise<SigningRequestRecipientRecord | null>;
  /** `null` when no activation row exists — read as "not yet". */
  getActivationState(): Promise<RecipientActivationState | null>;
  /** Fields assigned to THIS recipient. Unordered; core orders them. */
  listAssignedFields(): Promise<readonly SigningRequestFieldRecord[]>;
  /**
   * The artifact named by `signing_requests.source_artifact_id`.
   *
   * Takes no argument ON PURPOSE. A method with an `artifactId` parameter is a
   * method that can be passed the document's CURRENT artifact, which is
   * precisely the drift §19 and §104 forbid. Here the join is the guarantee.
   */
  getSourceArtifact(): Promise<CeremonyArtifactRecord | null>;
  getProgress(): Promise<CeremonyProgressRecord | null>;
  listConsents(): Promise<readonly CeremonyConsentRecord[]>;
  /**
   * Records first entry. Returns whether THIS call was the first.
   *
   * `insert … on conflict do nothing`, so concurrent entries converge on one
   * row and one timestamp with no read-then-write race (§145, §245).
   */
  recordFirstEntry(input: {
    readonly firstEnteredAt: number;
    readonly createdAt: number;
  }): Promise<boolean>;
  /**
   * Records an acceptance. Returns whether THIS call created it.
   *
   * `false` means this type and version were already accepted — a retry, not
   * an error. The unique constraint is what makes concurrent acceptance
   * converge on exactly one row (§139).
   */
  insertConsent(consent: NewCeremonyConsent): Promise<boolean>;
}

// ── Unit of work ─────────────────────────────────────────────────────────────

/**
 * The recipient ceremony's slice of workspace state.
 *
 * One repository, like `RecipientWorkspaceUnitOfWork` before it. Every
 * repository added here is a decision about what a signer holding a forwarded
 * link may read, not a convenience.
 */
export interface RecipientCeremonyUnitOfWork {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly ceremony: RecipientCeremonyRepository;
  /** BACKEND-36. Reads one accepted submission and writes one, nothing else. */
  readonly submissions: RecipientSubmissionRepository;
  /**
   * BACKEND-37. The recipient's OWN workflow row, and the advance intent.
   *
   * Added here rather than a new unit of work because the whole point is that
   * it commits with the submission: a signature that landed without its state
   * change would be exactly the intermediate state BACKEND-36 documented and
   * this command exists to close (§23).
   *
   * It cannot reach any other recipient. That is not a rule this interface
   * states — it is what migration 022's restrictive policies enforce, and why
   * the routing half of the progression lives in the workspace realm instead.
   */
  readonly workflow: RecipientWorkflowRepository;
  /**
   * BACKEND-36. The idempotency framework, inside the recipient realm.
   *
   * Scoped by IDENTITY rather than by RLS - `IdempotencyRepository` is the
   * documented second exception to the tenancy rule, and every method takes the
   * full scope, so a recipient cannot ask who else used a key.
   */
  readonly idempotency: IdempotencyRepository;
  /**
   * BACKEND-43. Evidence for recipient acts, on the SAME transaction.
   *
   * §50, §153 and §154 all require the event to commit with the fact it
   * records. A submission accepted in one transaction and its evidence written
   * in another is precisely the evidence-less critical transition §160 forbids.
   *
   * ── Why this does not widen the recipient realm ──────────────────────────
   *
   * There is only ONE runtime database role, `lagda_app`. The "recipient realm"
   * is not a second role — it is this transaction setting the workspace RLS
   * variable plus migrations 022/024's restrictive policies on the recipient's
   * own rows. `lagda_app` has held INSERT on `evidence_events` since migration
   * 003, with UPDATE and DELETE explicitly revoked, so appending here adds no
   * privilege that did not already exist.
   *
   * What it does add is reach: this unit of work can now write one more table.
   * The repository is append-only by construction — it has no update or delete
   * method — and the events it can write are constrained to this signing
   * request by the factories, which take the request id from the scope.
   *
   * **UNVERIFIED:** that `evidence_events`' `tenant_isolation` policy admits an
   * INSERT under recipient-realm session variables. The transaction sets the
   * same workspace setting the policy reads, so it should — but no PostgreSQL
   * was reachable to prove it, and the integration suite skips. See OD-172.
   */
  readonly evidence: ScopedEvidenceRepository;
}

export interface SigningConsentIdGenerator {
  nextSigningConsentId(): SigningConsentId;
}
