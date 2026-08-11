// Completion pipeline persistence (BACKEND-38).
//
// Every mutation is a CONDITIONAL update or an `on conflict do nothing` insert.
// The concurrency this table set has to survive is real: two transactions can
// reach readiness at once, two workers can be handed the same job, and a retry
// can arrive while an attempt is still running. None of those is resolved by an
// application check, because an application check cannot see the other side of
// a concurrent transaction.

import { sql, type Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import {
  COMPLETION_RUN_STATES, COMPLETION_STEPS, COMPLETION_STEP_STATES,
  COMPLETION_FAILURE_CODES,
  type CompletionRunState, type CompletionStep, type CompletionStepState,
  type CompletionFailureCode,
} from "@lagda/contracts";
import type {
  ScopedCompletionRepository, CompletionReconciliationRepository,
  CompletionRunRecord, CompletionStepRecord, CompletionRecord,
  CompletionRunId, CompletionStepId, CompletionInputRepository,
  SigningRequestId, ArtifactId,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { translatePersistenceError } from "../errors.js";

/** The two states a worker may pick up. Mirrors `isCompletionRunClaimable`. */
const CLAIMABLE: readonly string[] = ["pending", "waiting-retry"];

function oneOf<T extends string>(
  allowed: readonly T[], table: string, column: string, value: string,
): T {
  const found = allowed.find(candidate => candidate === value);
  if (found === undefined) {
    throw new PersistenceMappingError(table, column, `"${value}" is not permitted here.`);
  }
  return found;
}

const millis = (value: Date | null): number | null =>
  value === null ? null : value.getTime();

interface RunRow {
  completion_run_id: string; workspace_id: string; signing_request_id: string;
  state: string; pipeline_version: number; attempt_count: number;
  created_at: Date; started_at: Date | null; last_attempt_at: Date | null;
  succeeded_at: Date | null; failure_step: string | null; failure_code: string | null;
}

function toRun(row: RunRow): CompletionRunRecord {
  return {
    completionRunId: row.completion_run_id as CompletionRunId,
    workspaceId: row.workspace_id as WorkspaceId,
    signingRequestId: row.signing_request_id as SigningRequestId,
    // Validated rather than cast. A run state decides whether a legal document
    // gets produced, so an unrecognised value must fail loudly.
    state: oneOf<CompletionRunState>(
      COMPLETION_RUN_STATES, "signing_request_completion_runs", "state", row.state),
    pipelineVersion: row.pipeline_version,
    attemptCount: row.attempt_count,
    createdAt: row.created_at.getTime(),
    startedAt: millis(row.started_at),
    lastAttemptAt: millis(row.last_attempt_at),
    succeededAt: millis(row.succeeded_at),
    failureStep: row.failure_step === null ? null : oneOf<CompletionStep>(
      COMPLETION_STEPS, "signing_request_completion_runs", "failure_step",
      row.failure_step),
    failureCode: row.failure_code === null ? null : oneOf<CompletionFailureCode>(
      COMPLETION_FAILURE_CODES, "signing_request_completion_runs", "failure_code",
      row.failure_code),
  };
}

export function createScopedCompletionRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedCompletionRepository {
  const readRun = async (
    where: (qb: ReturnType<typeof baseQuery>) => ReturnType<typeof baseQuery>,
  ): Promise<CompletionRunRecord | null> => {
    const row = await where(baseQuery()).executeTakeFirst();
    return row === undefined ? null : toRun(row);
  };

  const baseQuery = () => trx.selectFrom("signing_request_completion_runs")
    .selectAll()
    .where("workspace_id", "=", scope);

  return {
    async ensureRun(input): Promise<CompletionRunRecord> {
      try {
        // FIND-OR-CREATE, as one conditional insert plus one read.
        //
        // Not read-then-write: two transactions reaching readiness together
        // would both read nothing and both insert, and the second would violate
        // rather than converge. `on conflict do nothing` makes the loser a
        // no-op, and the read afterwards gives BOTH of them the same run.
        await trx.insertInto("signing_request_completion_runs").values({
          completion_run_id: input.completionRunId,
          workspace_id: scope,
          signing_request_id: input.signingRequestId,
          state: "pending",
          pipeline_version: input.pipelineVersion,
          attempt_count: 0,
          created_at: new Date(input.createdAt),
          started_at: null, last_attempt_at: null, succeeded_at: null,
          failure_step: null, failure_code: null,
        })
          .onConflict(oc => oc
            .columns(["workspace_id", "signing_request_id"]).doNothing())
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }

      const run = await readRun(qb =>
        qb.where("signing_request_id", "=", input.signingRequestId));
      if (run === null) {
        // The insert either succeeded or conflicted with an existing row, so
        // one must be readable. Nothing here can produce this.
        throw new PersistenceMappingError(
          "signing_request_completion_runs", "completion_run_id",
          "ensureRun found no run after insert-or-conflict.");
      }
      return run;
    },

    findRun: signingRequestId =>
      readRun(qb => qb.where("signing_request_id", "=", signingRequestId)),

    findRunById: runId =>
      readRun(qb => qb.where("completion_run_id", "=", runId)),

    async claimRun(input) {
      // The claim, the attempt counter and the attempt timestamp in ONE
      // conditional statement. Two workers handed the same job both run this;
      // exactly one matches a claimable row (§63, §241).
      const row = await trx.updateTable("signing_request_completion_runs")
        .set(eb => ({
          state: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          last_attempt_at: new Date(input.at),
          // Stamped on the FIRST attempt only, so "when did this run first get
          // picked up" survives every retry.
          started_at: eb.fn.coalesce("started_at", eb.val(new Date(input.at))),
          // A previous failure is cleared as the next attempt begins, so the
          // columns describe the CURRENT attempt rather than a stale one.
          failure_step: null,
          failure_code: null,
        }))
        .where("workspace_id", "=", scope)
        .where("completion_run_id", "=", input.runId)
        .where("state", "in", [...CLAIMABLE])
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toRun(row);
    },

    async recordRunFailure(input) {
      const result = await trx.updateTable("signing_request_completion_runs")
        .set({
          state: input.state,
          failure_step: input.step,
          failure_code: input.code,
        })
        .where("workspace_id", "=", scope)
        .where("completion_run_id", "=", input.runId)
        // Only an attempt in flight may fail. A run that already succeeded
        // cannot be talked back out of it (§111).
        .where("state", "=", "processing")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async abandonStaleRuns(input) {
      const result = await trx.updateTable("signing_request_completion_runs")
        .set({
          state: "waiting-retry",
          failure_step: "seal",
          // A bounded code that says what happened: the worker went away.
          failure_code: "attempt-abandoned",
        })
        .where("workspace_id", "=", scope)
        .where("state", "=", "processing")
        .where("last_attempt_at", "<", new Date(input.lastAttemptBefore))
        .executeTakeFirst();
      void input.limit;
      return Number(result.numUpdatedRows);
    },

    async listSteps(runId): Promise<readonly CompletionStepRecord[]> {
      const rows = await trx.selectFrom("signing_request_completion_steps")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("completion_run_id", "=", runId)
        .orderBy("created_at", "asc")
        .execute();

      return rows.map(row => ({
        completionStepId: row.completion_step_id as CompletionStepId,
        step: oneOf<CompletionStep>(
          COMPLETION_STEPS, "signing_request_completion_steps", "step", row.step),
        state: oneOf<CompletionStepState>(
          COMPLETION_STEP_STATES, "signing_request_completion_steps", "state",
          row.state),
        outputArtifactId: row.output_artifact_id as ArtifactId | null,
        attemptCount: row.attempt_count,
        succeededAt: millis(row.succeeded_at),
        failureCode: row.failure_code === null ? null : oneOf<CompletionFailureCode>(
          COMPLETION_FAILURE_CODES, "signing_request_completion_steps",
          "failure_code", row.failure_code),
      }));
    },

    async acceptStep(input) {
      // `on conflict do nothing` against the one-per-step unique key. A retry
      // that regenerated an output discovers the previous attempt's accepted
      // result already there and does not replace it (§75, §117).
      const result = await trx.insertInto("signing_request_completion_steps")
        .values({
          completion_step_id: input.completionStepId,
          workspace_id: scope,
          completion_run_id: input.runId,
          step: input.step,
          state: "succeeded",
          output_artifact_id: input.outputArtifactId,
          attempt_count: 1,
          created_at: new Date(input.succeededAt),
          succeeded_at: new Date(input.succeededAt),
          failure_code: null,
        })
        .onConflict(oc => oc.columns(["completion_run_id", "step"]).doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
    },

    async findCompletion(signingRequestId): Promise<CompletionRecord | null> {
      const row = await trx.selectFrom("signing_request_completions")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        signingRequestId: row.signing_request_id as SigningRequestId,
        completionRunId: row.completion_run_id as CompletionRunId,
        finalArtifactId: row.final_artifact_id as ArtifactId,
        certificateArtifactId: row.certificate_artifact_id as ArtifactId | null,
        completedAt: row.completed_at.getTime(),
        sealScheme: row.seal_scheme,
        sealVersion: row.seal_version,
        digestAlgorithm: row.digest_algorithm,
        pipelineVersion: row.pipeline_version,
      };
    },
  };
}

/**
 * The reconciler's view, inside a workspace transaction.
 *
 * These tables DO carry tenant policies — unlike BACKEND-37's advance intents,
 * which had to be readable across tenants and therefore carry none. So this is
 * per-workspace by construction and needs no exception to the tenancy rule.
 */
export function createCompletionReconciliationRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): CompletionReconciliationRepository {
  return {
    async listReadyWithoutRun(limit): Promise<readonly SigningRequestId[]> {
      // The §131 recovery: readiness reached, and no completion work exists.
      // A left join rather than `not exists` so the plan stays a single pass
      // over the (small) set of completion-ready requests.
      const rows = await trx.selectFrom("signing_requests as r")
        .leftJoin("signing_request_completion_runs as c", join => join
          .onRef("c.workspace_id", "=", "r.workspace_id")
          .onRef("c.signing_request_id", "=", "r.signing_request_id"))
        .select("r.signing_request_id")
        .where("r.workspace_id", "=", scope)
        .where("r.state", "=", "completion-ready")
        .where("c.completion_run_id", "is", null)
        .orderBy("r.completion_ready_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(row => row.signing_request_id as SigningRequestId);
    },

    async listClaimableRuns(limit): Promise<readonly CompletionRunId[]> {
      const rows = await trx.selectFrom("signing_request_completion_runs")
        .select("completion_run_id")
        .where("workspace_id", "=", scope)
        .where("state", "in", [...CLAIMABLE])
        .orderBy("created_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(row => row.completion_run_id as CompletionRunId);
    },
  };
}

/**
 * Completion's read-only view of accepted signing facts.
 *
 * IDENTITIES ONLY. `signing_field_values` holds the text a signer typed and the
 * representation they adopted, and eligibility needs neither - it needs to know
 * that a value exists and whose it is. Selecting the value columns would put
 * every signed field's content into a use case that only counts them.
 */
export function createCompletionInputRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): CompletionInputRepository {
  return {
    async listAcceptedFieldValues(signingRequestId) {
      const rows = await trx.selectFrom("signing_field_values")
        .select(["request_field_id", "request_recipient_id"])
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .orderBy("request_field_id", "asc")
        .execute();
      return rows.map(row => ({
        fieldId: row.request_field_id,
        recipientId: row.request_recipient_id,
      }));
    },
  };
}

/** Unused here; re-exported so the brand has one import site in this package. */
export type { CompletionRunId, CompletionStepId };

void sql;
