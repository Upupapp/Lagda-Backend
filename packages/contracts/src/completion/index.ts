// Completion pipeline vocabularies (BACKEND-38).
//
// Persisted, so they are declared here rather than in core — the same direction
// `SIGNING_REQUEST_STATES` and `RECIPIENT_WORKFLOW_STATES` run.
//
// None of these is projected to a client today. The product has NO completion
// processing state, no failure copy and no retry control (see
// COMPLETION_PRODUCT_INVENTORY.md), so nothing here is a wire contract yet. They
// are declared as bounded vocabularies because they are written to a database
// and used as metric labels, and both demand a closed set.

import { Type } from "@sinclair/typebox";

/**
 * The processing state of ONE logical completion run.
 *
 * ── Separate from the request's state, deliberately ────────────────────────
 *
 * `SigningRequest.state` stays `completion-ready` for the whole pipeline. §18
 * asks for that and the product settles it: there is no "Finalizing" screen, no
 * processing status in `status-map.ts`, and no failure copy. A request-level
 * `COMPLETING` state would be a value nothing can render and nobody decided.
 *
 * Five values, and each one is operationally distinct:
 *
 *   pending          the run exists and no attempt has started
 *   processing       an attempt is in flight
 *   waiting-retry    an attempt failed retryably; the queue will come back
 *   succeeded        every required step succeeded and the request completed
 *   failed-terminal  a deterministic failure. Retrying cannot help
 *
 * `waiting-retry` is separate from `pending` on purpose: they look identical in
 * a status column and mean opposite things to an operator. One is work that has
 * never run; the other is work that has failed and is being retried, and only
 * the second is a signal that something may be wrong.
 */
export const COMPLETION_RUN_STATES = [
  "pending",
  "processing",
  "waiting-retry",
  "succeeded",
  "failed-terminal",
] as const;

export type CompletionRunState = (typeof COMPLETION_RUN_STATES)[number];

export const CompletionRunStateSchema = Type.Union(
  COMPLETION_RUN_STATES.map(state => Type.Literal(state)),
  { title: "CompletionRunState" },
);

/**
 * The completion steps.
 *
 * ── Four, and BACKEND-39 reversed the earlier three ────────────────────────
 *
 * Migration 025 declared `seal`, `persist`, `finalize`, because
 * `DocumentSealer.seal()` is ONE operation that merges fields and renders the
 * certificate internally — and splitting it would split the seam INV-002
 * protects.
 *
 * BACKEND-39 requires `field-merge` to be a distinct durable step producing a
 * distinct immutable artifact, AND requires that step not to invoke
 * `DocumentSealer`. Both together are only satisfiable if merging is separable
 * from sealing, so it was separated.
 *
 * `SEALING_ARCHITECTURE.md` §2 objected that exposing `mergeFields` would give
 * "twenty callers a reason to reach past the boundary". That holds for twenty
 * callers and not for one: the completion pipeline is the only caller, and
 * these are sequential stages of an orchestration that already exists. The PDF
 * work stays inside `@lagda/sealing`; the package exposes two operations to one
 * caller instead of one.
 *
 *   field-merge   render accepted values onto the exact source PDF. Produces a
 *                 `merged-candidate` artifact. NEVER calls the sealer
 *   certificate   BACKEND-40
 *   final-seal    BACKEND-41, through `DocumentSealer.seal()` and nothing else
 *   finalize      verify every output, then transition the request
 *
 * **BACKEND-41 must narrow `seal()` to sealing alone**, because it merges
 * fields today and leaving it would render every field twice.
 *
 * `persist` is gone: it existed because one seal call produced two artifacts
 * stored together, and each step now persists its own output as part of being
 * that step.
 */
export const COMPLETION_STEPS = [
  "field-merge", "certificate", "final-seal", "finalize",
] as const;

export type CompletionStep = (typeof COMPLETION_STEPS)[number];

export const CompletionStepSchema = Type.Union(
  COMPLETION_STEPS.map(step => Type.Literal(step)),
  { title: "CompletionStep" },
);

/** Per-step state. Minimal: a step is outstanding, running, done, or failed. */
export const COMPLETION_STEP_STATES = [
  "pending",
  "processing",
  "succeeded",
  "failed",
] as const;

export type CompletionStepState = (typeof COMPLETION_STEP_STATES)[number];

/**
 * Whether a failure is worth trying again.
 *
 * §43. The distinction is the difference between an outage that resolves itself
 * and a corrupt source PDF that will fail identically forever — and retrying
 * the second burns the attempt budget that would otherwise surface the first.
 */
export const COMPLETION_FAILURE_CLASSES = ["retryable", "terminal"] as const;

export type CompletionFailureClass = (typeof COMPLETION_FAILURE_CLASSES)[number];

/**
 * Why a completion failed, as a CLOSED set.
 *
 * §42 forbids persisting a raw exception or stack trace in a business table,
 * and this is the vocabulary that makes that practical: every failure maps to
 * one of these, an operator can aggregate them, and none of them can carry a
 * document title, an address or a field value.
 *
 * The operational detail lives in logs and telemetry, where the redaction
 * policy already applies.
 */
export const COMPLETION_FAILURE_CODES = [
  // Terminal — deterministic, and retrying reproduces it exactly.
  /** The request is not in the one state completion may begin from. */
  "not-completion-ready",
  /** A required participant has no accepted submission. Integrity. */
  "missing-submission",
  /** A required field has no accepted value. Integrity. */
  "missing-field-value",
  /** A value points at a field or recipient that is not this request's. */
  "input-inconsistent",
  /** The exact bytes the request froze are gone. */
  "source-artifact-missing",
  /** A field's persisted geometry cannot be rendered. */
  "invalid-geometry",
  /**
   * A signature representation this build cannot render.
   *
   * Four causes, one code, because none of them is operationally distinct — an
   * unknown representation version, an unsupported media type (the canvas emits
   * PNG and §52 verifies it), bytes that do not decode, and a typed style index
   * outside 0–3 all mean "this signature cannot be rendered, terminally".
   */
  "unsupported-representation",
  /**
   * A value contains a character the embedded typeface has no glyph for.
   *
   * NOT folded into `unsupported-representation`: that one says the signature
   * is unrenderable, this one says the signature is fine and the TEXT cannot be
   * drawn. They send an operator to different places.
   *
   * It exists at all because an embedded font does not throw on an uncovered
   * character the way a standard font does — it draws nothing and returns a
   * valid PDF. Without a code for it, the only honest alternative to failing is
   * completing a document with a blank field.
   */
  "unrenderable-value",
  /** A step says succeeded and its object is not there. */
  "output-missing",
  /** A run started under a pipeline version this build cannot resume. */
  "pipeline-version-incompatible",

  // Retryable — the same input may succeed later.
  /** Object storage refused or timed out. */
  "storage-unavailable",
  /** The sealer could not be reached or did not answer. */
  "sealer-unavailable",
  /** A step this build has no implementation for. Retryable: a later build has. */
  "step-not-implemented",
  /**
   * The embedded typeface could not be loaded at all.
   *
   * RETRYABLE, and the split from `unrenderable-value` is the decision. A
   * missing font file is a broken INSTALLATION, not a broken document: it fails
   * identically for every request, so classifying it terminally would
   * permanently fail everything in flight over a fault a redeploy fixes. Same
   * reasoning as `step-not-implemented`.
   */
  "typeface-unavailable",
  /** The database dependency failed transiently. */
  "database-unavailable",
  /** The worker died mid-attempt and the lease expired. */
  "attempt-abandoned",
] as const;

export type CompletionFailureCode = (typeof COMPLETION_FAILURE_CODES)[number];

/**
 * The classification, as a total record.
 *
 * A `Record` rather than two arrays, so adding a code without deciding whether
 * it is worth retrying is a COMPILE ERROR — which is precisely the decision
 * that must not be made by default. Defaulting to retryable would retry corrupt
 * data forever; defaulting to terminal would give up on an outage.
 */
export const COMPLETION_FAILURE_CLASSIFICATION:
Readonly<Record<CompletionFailureCode, CompletionFailureClass>> = Object.freeze({
  "not-completion-ready": "terminal",
  "missing-submission": "terminal",
  "missing-field-value": "terminal",
  "input-inconsistent": "terminal",
  "source-artifact-missing": "terminal",
  "invalid-geometry": "terminal",
  "unsupported-representation": "terminal",
  "unrenderable-value": "terminal",
  "output-missing": "terminal",
  "pipeline-version-incompatible": "terminal",
  "storage-unavailable": "retryable",
  "sealer-unavailable": "retryable",
  "step-not-implemented": "retryable",
  "typeface-unavailable": "retryable",
  "database-unavailable": "retryable",
  "attempt-abandoned": "retryable",
});

/**
 * The completion pipeline's semantic version.
 *
 * §118. Persisted on every run, because a run started under one version must
 * not be resumed under another that interprets its step outputs differently
 * (§212, §213). It is NOT a package version and NOT a git SHA (§123) — it
 * increments when a change alters how an existing run's durable state must be
 * read.
 *
 * Version 1 is the orchestration this command establishes. It does not change
 * when BACKEND-39 or BACKEND-40 refine rendering INSIDE the sealer, because
 * neither alters the meaning of a persisted step row; the sealer's own
 * `sealVersion` records that.
 */
export const COMPLETION_PIPELINE_VERSION = 1;
