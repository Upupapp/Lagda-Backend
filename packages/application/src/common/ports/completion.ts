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

export interface CompletionIdGenerator {
  nextCompletionRunId(): CompletionRunId;
  nextCompletionStepId(): CompletionStepId;
}
