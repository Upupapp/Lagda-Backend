// Completion pipeline ports (BACKEND-38).
//
// ── The trigger is the whole point of `ensureRun` ──────────────────────────
//
// A request that reaches `completion-ready` must acquire durable completion
// work in the SAME transaction as the transition. Anything else — an event, a
// best-effort enqueue, a "the worker will notice eventually" — is the
// lost-completion window §50 forbids, and it fails silently: the signatures are
// all collected, the request looks finished, and no document is ever produced.
//
// So `ensureRun` is called from inside `markCompletionReady`'s transaction, and
// its uniqueness constraint is what makes a duplicate trigger converge instead
// of forking.

import type { WorkspaceId } from "@lagda/contracts";
import type {
  CompletionRunState, CompletionStep, CompletionStepState,
  CompletionFailureCode,
} from "@lagda/contracts";
import type { SigningRequestId } from "./signing-requests.js";
import type { ArtifactId } from "./evidence.js";

export type CompletionRunId = string & { readonly __brand: "CompletionRunId" };
export type CompletionStepId = string & { readonly __brand: "CompletionStepId" };

// ── Records ──────────────────────────────────────────────────────────────────

export interface CompletionRunRecord {
  readonly completionRunId: CompletionRunId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly state: CompletionRunState;
  /**
   * The orchestration's semantic version, carried by the RUN.
   *
   * A run started under one version must not be resumed under another that
   * reads its step rows differently (§212). Reading it off the running build
   * would defeat that — the build is exactly what changed.
   */
  readonly pipelineVersion: number;
  readonly attemptCount: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly succeededAt: number | null;
  /** BOUNDED. Never an exception message. */
  readonly failureStep: CompletionStep | null;
  readonly failureCode: CompletionFailureCode | null;
}

export interface CompletionStepRecord {
  readonly completionStepId: CompletionStepId;
  readonly step: CompletionStep;
  readonly state: CompletionStepState;
  /** What the step produced. Never bytes — an artifact id or nothing. */
  readonly outputArtifactId: ArtifactId | null;
  readonly attemptCount: number;
  readonly succeededAt: number | null;
  readonly failureCode: CompletionFailureCode | null;
}

/** The immutable fact that a request completed. Written once, never updated. */
export interface CompletionRecord {
  readonly signingRequestId: SigningRequestId;
  readonly completionRunId: CompletionRunId;
  readonly finalArtifactId: ArtifactId;
  readonly certificateArtifactId: ArtifactId | null;
  /** Backend pipeline-success time. NOT the last recipient's `acceptedAt`. */
  readonly completedAt: number;
  readonly sealScheme: string;
  readonly sealVersion: number;
  readonly digestAlgorithm: string;
  readonly pipelineVersion: number;
}

// ── The repository ───────────────────────────────────────────────────────────

/**
 * Completion persistence, bound to ONE workspace and ONE transaction.
 *
 * ── Methods that are deliberately absent ───────────────────────────────────
 *
 *   setRunState / updateStatus   §284. No generic setter at any layer
 *   deleteRun                    a run is history, not rubbish
 *   updateCompletion             the completion row has NO update grant, so a
 *                                method for it could not work anyway
 *   markRequestCompleted         that guard needs proof the outputs exist, and
 *                                it belongs with the orchestrator that has it
 */
export interface ScopedCompletionRepository {
  /**
   * Finds or creates the ONE run for this request. Returns it either way.
   *
   * `insert ... on conflict do nothing` against the one-per-request unique
   * key, then read. Two transactions racing the same readiness transition both
   * attempt the insert; one wins, the other conflicts, and BOTH end up holding
   * the same run — which is what §138, §139 and §240 ask for, expressed as a
   * constraint rather than as an application check that cannot see the other
   * side of a concurrent transaction.
   *
   * Idempotent by construction: calling it on a request that already has a run
   * writes nothing.
   */
  ensureRun(input: {
    readonly completionRunId: CompletionRunId;
    readonly signingRequestId: SigningRequestId;
    readonly pipelineVersion: number;
    readonly createdAt: number;
  }): Promise<CompletionRunRecord>;

  findRun(signingRequestId: SigningRequestId): Promise<CompletionRunRecord | null>;

  findRunById(runId: CompletionRunId): Promise<CompletionRunRecord | null>;

  /**
   * Claims a run for an attempt, conditionally on it being claimable.
   *
   * The condition is IN the statement: `where state in ('pending',
   * 'waiting-retry')`. Two workers handed the same job both call this and
   * exactly one matches a row, so there is one logical processing owner without
   * a lease, a lock table or an exactly-once delivery claim §61 forbids.
   *
   * Increments `attempt_count` and stamps `last_attempt_at` in the same
   * statement, so an abandoned attempt is detectable by age.
   */
  claimRun(input: {
    readonly runId: CompletionRunId;
    readonly at: number;
  }): Promise<CompletionRunRecord | null>;

  /** `processing -> waiting-retry | failed-terminal`, with a bounded code. */
  recordRunFailure(input: {
    readonly runId: CompletionRunId;
    readonly state: "waiting-retry" | "failed-terminal";
    readonly step: CompletionStep;
    readonly code: CompletionFailureCode;
  }): Promise<boolean>;

  /**
   * Returns a run whose worker died to the claimable pool.
   *
   * `processing -> waiting-retry`, conditional on the attempt being older than
   * the caller's threshold. Without it a crashed attempt sits in `processing`
   * forever, looking busy (§133, §270).
   */
  abandonStaleRuns(input: {
    readonly lastAttemptBefore: number;
    readonly limit: number;
  }): Promise<number>;

  listSteps(runId: CompletionRunId): Promise<readonly CompletionStepRecord[]>;

  /**
   * Records an ACCEPTED step output.
   *
   * Returns false when this step already has one. That is not an error — it is
   * a retry discovering the previous attempt's work, and §117 requires the
   * output be REUSED rather than replaced. The unique key is what makes it
   * impossible to accept two, which matters because a certificate carrying a
   * backend timestamp means two attempts can legitimately produce different
   * bytes (§116).
   */
  acceptStep(input: {
    readonly completionStepId: CompletionStepId;
    readonly runId: CompletionRunId;
    readonly step: CompletionStep;
    readonly outputArtifactId: ArtifactId | null;
    readonly succeededAt: number;
  }): Promise<boolean>;

  findCompletion(
    signingRequestId: SigningRequestId,
  ): Promise<CompletionRecord | null>;
}

/**
 * Outstanding completion work, across every tenant.
 *
 * The reconciler's view, and the same shape BACKEND-37's advance reconciliation
 * uses: it returns IDENTIFIERS ONLY and the caller enters each workspace
 * properly. Unlike the advance intents, these tables DO carry tenant policies —
 * so this repository is reachable only from a system context that has already
 * established one, and the sweep is per-workspace by construction.
 */
export interface CompletionReconciliationRepository {
  /**
   * Requests that are `completion-ready` and have NO run.
   *
   * The §131/§269 recovery: a trigger that was lost, or a request that reached
   * readiness before this pipeline existed. Without this the request is
   * stranded silently — every signature collected, no document ever produced.
   */
  listReadyWithoutRun(limit: number): Promise<readonly SigningRequestId[]>;

  /** Runs that are claimable and have been waiting. */
  listClaimableRuns(limit: number): Promise<readonly CompletionRunId[]>;
}

/** One accepted field value, as completion needs to see it. */
export interface AcceptedFieldValueRef {
  readonly fieldId: string;
  /** Whose submission produced it. Checked against the field's assignment. */
  readonly recipientId: string;
}

/**
 * The completion pipeline's READ-ONLY view of accepted signing facts.
 *
 * Separate from `ScopedCompletionRepository` because it is a different kind of
 * access: that one owns completion's own state, and this one reads BACKEND-36's
 * immutable records. Splitting them means the completion repository has no
 * method that could touch a submission - §36, expressed as an absence rather
 * than as a rule.
 *
 * There is no write method here, and the runtime role holds no UPDATE or DELETE
 * grant on any of the three submission tables either. Two layers.
 */
export interface CompletionInputRepository {
  /**
   * Every accepted field value for the request, as identities only.
   *
   * NOT the values. Completion eligibility needs to know THAT a value exists
   * and WHOSE it is; the bytes and the text belong to the sealer, which reads
   * them when it renders. Returning them here would put every signed field's
   * content in a use case that only has to count them.
   */
  listAcceptedFieldValues(
    signingRequestId: SigningRequestId,
  ): Promise<readonly AcceptedFieldValueRef[]>;

  /**
   * Every accepted field value WITH its content and geometry, for rendering.
   *
   * The deliberate counterpart to the method above, and separate from it for
   * the reason that one's comment gives: eligibility must not be able to read
   * signer content, so the capability to read it is a different method that a
   * different caller asks for. `field-merge` is the only caller.
   *
   * Geometry comes from `signing_request_fields` — the request's own IMMUTABLE
   * snapshot, never the preparation. §9: resolving the live preparation here
   * would render onto coordinates nobody agreed to, and it would drift the
   * moment someone edited the template.
   *
   * Ordered by `(pageNumber, fieldId)` so the caller receives a stable
   * sequence, though the renderer sorts again rather than trusting it.
   */
  listRenderableFieldValues(
    signingRequestId: SigningRequestId,
  ): Promise<readonly RenderableFieldRecord[]>;

  /**
   * The facts the completion certificate certifies, for every SIGNER.
   *
   * ── Why one query rather than five reads ───────────────────────────────
   *
   * Every fact here must belong to the SAME recipient of the SAME request.
   * Assembling them from separate reads and correlating in application code is
   * how a cross-recipient or cross-request fact gets onto a certificate (§144,
   * §210–§213) — the correlation is written once in a join instead, where the
   * database enforces it.
   *
   * ── The binding, and why it is not "the latest event" ──────────────────
   *
   * `recipient_submissions` itself records `authentication_method` and
   * `consent_id`. So the certificate reports the method used for THE ACCEPTED
   * SUBMISSION, not the most recent authentication the recipient happened to
   * perform (§149, §150). A recipient who opened a link, later authenticated
   * with an OTP, and signed under the first session must be certified as having
   * signed under the first.
   *
   * Only recipients WITH an accepted submission are returned: §49, the
   * certificate is a record of signing evidence, and a recipient who took no
   * signing action has none to certify.
   */
  listCertifiedParticipants(
    signingRequestId: SigningRequestId,
  ): Promise<readonly CertifiedParticipantFacts[]>;
}

/**
 * One signer's authoritative facts, straight from immutable records.
 *
 * The FULL email is carried here and masked by the builder. The repository
 * reports what was recorded; deciding what a human-visible document shows is a
 * policy question, and policy does not belong in a query.
 */
export interface CertifiedParticipantFacts {
  readonly recipientId: string;
  /** From the request's immutable recipient snapshot. Never a Contact. */
  readonly name: string;
  readonly email: string;
  readonly recipientType: string;
  readonly routingOrder: number;
  readonly orderIndex: number;
  /** THE authoritative signing instant. */
  readonly signedAt: number;
  /** As recorded ON THE SUBMISSION, not resolved from a session list. */
  readonly authenticationMethod: string;
  /** First ceremony entry, when one was recorded. */
  readonly firstEnteredAt: number | null;
  /** The consent bound to this submission, when one exists. */
  readonly consentType: string | null;
  readonly consentVersion: string | null;
  readonly consentAcceptedAt: number | null;
}

/**
 * What a value renders as.
 *
 * Mirrors the sealing port's `MergeableFieldValue` with ONE extra case:
 * `instant`. A `DATE_SIGNED` field stores a UTC instant rather than text, and
 * turning an instant into characters is a presentation decision the repository
 * must not make — it has no timezone and no format. The step decides, and
 * records why.
 */
export type RenderableValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "checkbox"; readonly checked: boolean }
  | { readonly kind: "instant"; readonly at: number }
  | {
    readonly kind: "typed-signature";
    readonly text: string;
    readonly styleIndex: number;
  }
  | {
    readonly kind: "raster-signature";
    /** DECODED bytes, straight from `bytea`. Never a data URL, never base64. */
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly width: number;
    readonly height: number;
  };

/** One accepted value, joined to the geometry the request froze. */
export interface RenderableFieldRecord {
  readonly fieldId: string;
  readonly recipientId: string;
  /** The preparation field type, for provenance. The VALUE decides rendering. */
  readonly fieldType: string;
  /** 1-based, matching the product. */
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly value: RenderableValue;
}

export interface CompletionIdGenerator {
  nextCompletionRunId(): CompletionRunId;
  nextCompletionStepId(): CompletionStepId;
}
