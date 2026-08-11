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
  SigningRequestId, ArtifactId, RenderableValue,
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
          failure_step: "field-merge",
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

    async recordCompletion(input) {
      // `on conflict do nothing` against UNIQUE (signing_request_id). A retry
      // that lost its response finds the row already there and converges (§109)
      // rather than violating — and a SECOND completion is impossible by
      // constraint, not by an application check.
      try {
        const result = await trx.insertInto("signing_request_completions")
          .values({
            workspace_id: scope,
            signing_request_id: input.signingRequestId,
            completion_run_id: input.completionRunId,
            merged_artifact_id: input.mergedArtifactId,
            certificate_artifact_id: input.certificateArtifactId,
            final_artifact_id: input.finalArtifactId,
            completed_at: new Date(input.completedAt),
            seal_scheme: input.sealScheme,
            seal_version: input.sealVersion,
            digest_algorithm: input.digestAlgorithm,
            pipeline_version: input.pipelineVersion,
            created_at: new Date(input.completedAt),
          })
          .onConflict(oc => oc.column("signing_request_id").doNothing())
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async markRunSucceeded(input) {
      const result = await trx.updateTable("signing_request_completion_runs")
        .set({
          state: "succeeded",
          succeeded_at: new Date(input.succeededAt),
          failure_step: null,
          failure_code: null,
        })
        .where("workspace_id", "=", scope)
        .where("completion_run_id", "=", input.runId)
        // Only an attempt in flight may succeed. A run cannot be talked into
        // success from `waiting-retry` without being claimed first.
        .where("state", "=", "processing")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
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

    async listRenderableFieldValues(signingRequestId) {
      // The one query in this repository that DOES select content, because
      // rendering is the one operation that needs it.
      //
      // Geometry joins from `signing_request_fields` - the request's IMMUTABLE
      // snapshot. Joining `preparation_fields` instead would render onto
      // coordinates nobody agreed to and would drift the moment a template was
      // edited (§9).
      //
      // The representation join is LEFT: a text or checkbox value has no
      // representation, and an inner join would silently drop every one of
      // them. That exact mistake hid 40 of 95 rows in another LAGDA service, so
      // it is called out rather than assumed obvious.
      const rows = await trx.selectFrom("signing_field_values as v")
        .innerJoin("signing_request_fields as f", join => join
          .onRef("f.request_field_id", "=", "v.request_field_id")
          .onRef("f.workspace_id", "=", "v.workspace_id")
          .onRef("f.signing_request_id", "=", "v.signing_request_id"))
        .leftJoin("signing_representations as r", join => join
          .onRef("r.representation_id", "=", "v.representation_id")
          .onRef("r.workspace_id", "=", "v.workspace_id"))
        .select([
          "v.request_field_id", "v.request_recipient_id", "v.value_kind",
          "v.text_value", "v.boolean_value", "v.instant_value",
          "f.field_type", "f.page_number", "f.x", "f.y", "f.width", "f.height",
          "r.representation_type", "r.typed_text", "r.typed_style_index",
          "r.raster_bytes", "r.raster_media_type", "r.raster_width", "r.raster_height",
        ])
        .where("v.workspace_id", "=", scope)
        .where("v.signing_request_id", "=", signingRequestId)
        .orderBy("f.page_number", "asc")
        .orderBy("v.request_field_id", "asc")
        .execute();

      return rows.map(row => ({
        fieldId: row.request_field_id,
        recipientId: row.request_recipient_id,
        fieldType: row.field_type,
        pageNumber: row.page_number,
        x: row.x, y: row.y, width: row.width, height: row.height,
        value: toRenderableValue(row),
      }));
    },

    async listCertifiedParticipants(signingRequestId) {
      // ONE query, because every fact must belong to the same recipient of the
      // same request. Correlating separate reads in application code is how a
      // cross-recipient fact reaches a certificate (§144, §210-§213).
      //
      // The submission join is INNER: only recipients who actually signed are
      // certified (§49). The consent and progress joins are LEFT, because both
      // are genuinely optional and an inner join would silently drop every
      // signer who has no recorded consent - producing a certificate missing
      // participants rather than an error.
      //
      // Authentication comes off the SUBMISSION, not from a session lookup.
      // That is the binding §150 asks for: the method used for the accepted
      // submission, never the recipient's most recent authentication.
      const rows = await trx.selectFrom("signing_request_recipients as r")
        .innerJoin("recipient_submissions as s", join => join
          .onRef("s.request_recipient_id", "=", "r.request_recipient_id")
          .onRef("s.workspace_id", "=", "r.workspace_id")
          .onRef("s.signing_request_id", "=", "r.signing_request_id"))
        .leftJoin("signing_recipient_consents as c", join => join
          .onRef("c.consent_id", "=", "s.consent_id")
          .onRef("c.workspace_id", "=", "s.workspace_id")
          .onRef("c.request_recipient_id", "=", "s.request_recipient_id"))
        .leftJoin("signing_recipient_progress as p", join => join
          .onRef("p.request_recipient_id", "=", "r.request_recipient_id")
          .onRef("p.workspace_id", "=", "r.workspace_id")
          .onRef("p.signing_request_id", "=", "r.signing_request_id"))
        .select([
          "r.request_recipient_id", "r.name", "r.email", "r.recipient_type",
          "r.routing_order", "r.order_index",
          "s.accepted_at", "s.authentication_method",
          "c.consent_type", "c.consent_version", "c.accepted_at as consent_accepted_at",
          "p.first_entered_at",
        ])
        .where("r.workspace_id", "=", scope)
        .where("r.signing_request_id", "=", signingRequestId)
        // Deterministic, from the request's own immutable ordering (§50).
        // Never the database's natural order.
        .orderBy("r.routing_order", "asc")
        .orderBy("r.order_index", "asc")
        .orderBy("r.request_recipient_id", "asc")
        .execute();

      return rows.map(row => ({
        recipientId: row.request_recipient_id,
        name: row.name,
        email: row.email,
        recipientType: row.recipient_type,
        routingOrder: row.routing_order,
        orderIndex: row.order_index,
        signedAt: row.accepted_at.getTime(),
        authenticationMethod: row.authentication_method,
        firstEnteredAt: row.first_entered_at === null
          ? null : row.first_entered_at.getTime(),
        consentType: row.consent_type,
        consentVersion: row.consent_version,
        consentAcceptedAt: row.consent_accepted_at === null
          ? null : row.consent_accepted_at.getTime(),
      }));
    },
  };
}

/** Row shape the projection below reads. Declared so the mapping is checkable. */
interface RenderableRow {
  readonly value_kind: string;
  readonly text_value: string | null;
  readonly boolean_value: boolean | null;
  readonly instant_value: Date | null;
  readonly representation_type: string | null;
  readonly typed_text: string | null;
  readonly typed_style_index: number | null;
  readonly raster_bytes: Buffer | null;
  readonly raster_media_type: string | null;
  readonly raster_width: number | null;
  readonly raster_height: number | null;
}

/**
 * One row to one renderable value.
 *
 * THROWS rather than returning a default. A value whose columns do not match
 * its own `value_kind` is corruption, and the honest outcomes are "render the
 * signer's value" or "fail" — never "render a blank because the shape was
 * unexpected", which produces a finished document with a missing field.
 *
 * The database already forbids most of this: `signing_representations_shape`
 * asserts exactly one representation shape is populated for the type. This is
 * the reading half of that constraint, and it exists because a CHECK protects
 * what is WRITTEN while this protects what is INTERPRETED.
 */
function toRenderableValue(row: RenderableRow): RenderableValue {
  switch (row.value_kind) {
    case "text":
      if (row.text_value === null) {
        throw new Error("A text field value has no text.");
      }
      return { kind: "text", text: row.text_value };

    case "boolean":
      if (row.boolean_value === null) {
        throw new Error("A checkbox field value has no boolean.");
      }
      return { kind: "checkbox", checked: row.boolean_value };

    case "instant": {
      if (row.instant_value === null) {
        throw new Error("A date field value has no instant.");
      }
      // `timestamptz` arrives as a Date here, unlike the ISO strings some other
      // LAGDA services produce through global pg type parsers.
      return { kind: "instant", at: row.instant_value.getTime() };
    }

    case "representation": {
      if (row.representation_type === "TYPED_SIGNATURE_V1") {
        if (row.typed_text === null || row.typed_style_index === null) {
          throw new Error("A typed signature has no text or no style.");
        }
        return {
          kind: "typed-signature",
          text: row.typed_text,
          styleIndex: row.typed_style_index,
        };
      }
      if (row.representation_type === "RASTER_SIGNATURE_V1") {
        if (
          row.raster_bytes === null || row.raster_media_type === null ||
          row.raster_width === null || row.raster_height === null
        ) {
          throw new Error("A drawn signature is missing its bytes or dimensions.");
        }
        return {
          kind: "raster-signature",
          // A copy, so the value does not alias a pooled driver buffer.
          bytes: Uint8Array.from(row.raster_bytes),
          mediaType: row.raster_media_type,
          width: row.raster_width,
          height: row.raster_height,
        };
      }
      // Includes the null case: a `representation` value whose representation
      // row is gone. The LEFT join makes that reachable, so it is handled.
      throw new Error(
        `Unsupported representation type: ${String(row.representation_type)}.`,
      );
    }

    default:
      throw new Error(`Unsupported value kind: ${row.value_kind}.`);
  }
}

/** Unused here; re-exported so the brand has one import site in this package. */
export type { CompletionRunId, CompletionStepId };

void sql;
