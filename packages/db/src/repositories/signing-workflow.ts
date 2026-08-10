// Signing workflow state persistence (BACKEND-37).
//
// Every mutation here is a CONDITIONAL update whose predicate names the state
// it is transitioning from. Not read-then-write: two concurrent applications of
// the same fact would both read the old state and both write, and the second
// would overwrite the first without either noticing. Here the second matches
// zero rows, the caller learns it, and the outcome converges.
//
// That single pattern is what makes §29, §59, §160, §176 and §241 true, and it
// is the same one `markSentIfDraft` and `changeRoleIfUnchanged` already use.

import { sql, type Transaction } from "kysely";
import type {
  RecipientType, RecipientWorkflowState, SigningDeclineReason, WorkspaceId,
} from "@lagda/contracts";
import {
  RECIPIENT_TYPES, RECIPIENT_WORKFLOW_STATES, SIGNING_DECLINE_REASONS,
} from "@lagda/contracts";
import type {
  RecipientWorkflowRepository, ScopedSigningWorkflowRepository,
  SigningWorkflowReconciliationRepository,
  NewWorkflowAdvanceIntent, WorkflowAdvanceIntentRef, WorkflowRecipientRecord,
  WorkflowAdvanceTrigger, SigningWorkflowIntentId,
  SigningRequestId, SigningRequestRecipientId, RecipientSubmissionId,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { translatePersistenceError } from "../errors.js";

/** The states a request may still be moved out of by a workflow transition. */
const ADVANCEABLE_STATES = ["sent", "partially-completed"] as const;

const ADVANCE_TRIGGERS: readonly WorkflowAdvanceTrigger[] = ["submission", "decline"];

/**
 * Validated rather than cast.
 *
 * Persisted state is untrusted input, and an unrecognised recipient state would
 * decide whether somebody may sign a legal document. `row.recipient_state as
 * RecipientWorkflowState` would accept whatever the column happens to hold.
 */
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

function toIntentRef(row: {
  intent_id: string; workspace_id: string; signing_request_id: string;
  request_recipient_id: string; trigger_kind: string; attempts: number;
}): WorkflowAdvanceIntentRef {
  return {
    intentId: row.intent_id as SigningWorkflowIntentId,
    workspaceId: row.workspace_id as WorkspaceId,
    signingRequestId: row.signing_request_id as SigningRequestId,
    recipientId: row.request_recipient_id as SigningRequestRecipientId,
    trigger: oneOf<WorkflowAdvanceTrigger>(
      ADVANCE_TRIGGERS, "signing_workflow_advance_intents", "trigger_kind",
      row.trigger_kind),
    attempts: row.attempts,
  };
}

// ── The recipient realm ──────────────────────────────────────────────────────

/**
 * The recipient's OWN workflow row.
 *
 * Bound to all three identifiers at construction, from the trusted session.
 * Every statement below carries all three in its `where` clause AND runs under
 * migration 024's restrictive policy — so a bug in one is caught by the other.
 */
export function createRecipientWorkflowRepository(
  trx: Transaction<Database>,
  scope: {
    readonly workspaceId: WorkspaceId;
    readonly signingRequestId: SigningRequestId;
    readonly recipientId: SigningRequestRecipientId;
  },
): RecipientWorkflowRepository {
  return {
    async getState(): Promise<RecipientWorkflowState | null> {
      const row = await trx.selectFrom("signing_request_recipient_activation")
        .select("recipient_state")
        .where("workspace_id", "=", scope.workspaceId)
        .where("signing_request_id", "=", scope.signingRequestId)
        .where("request_recipient_id", "=", scope.recipientId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return oneOf<RecipientWorkflowState>(
        RECIPIENT_WORKFLOW_STATES, "signing_request_recipient_activation",
        "recipient_state", row.recipient_state);
    },

    async markSignedFromSubmission(input): Promise<boolean> {
      try {
        const result = await trx.updateTable("signing_request_recipient_activation")
          .set({
            recipient_state: "signed",
            // THE submission's instant, passed in by the caller. There is no
            // clock in this file and nothing here could produce a second one.
            signed_at: new Date(input.signedAt),
            submission_id: input.submissionId,
          })
          .where("workspace_id", "=", scope.workspaceId)
          .where("signing_request_id", "=", scope.signingRequestId)
          .where("request_recipient_id", "=", scope.recipientId)
          // The condition, in the statement. A `waiting` recipient matches zero
          // rows rather than skipping their turn (§28).
          .where("recipient_state", "=", "active")
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async markDeclined(input): Promise<boolean> {
      try {
        const result = await trx.updateTable("signing_request_recipient_activation")
          .set({
            recipient_state: "declined",
            declined_at: new Date(input.declinedAt),
            decline_reason: input.reason,
          })
          .where("workspace_id", "=", scope.workspaceId)
          .where("signing_request_id", "=", scope.signingRequestId)
          .where("request_recipient_id", "=", scope.recipientId)
          .where("recipient_state", "=", "active")
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async enqueueAdvance(intent: NewWorkflowAdvanceIntent): Promise<boolean> {
      // `on conflict do nothing` against the (request, recipient, trigger)
      // unique key. A second delivery of the same fact converges on one intent
      // with no read-then-write race, which is what stops a duplicate causing a
      // second cohort activation (§59, §164).
      const result = await trx.insertInto("signing_workflow_advance_intents")
        .values({
          intent_id: intent.intentId,
          workspace_id: scope.workspaceId,
          signing_request_id: scope.signingRequestId,
          request_recipient_id: scope.recipientId,
          trigger_kind: intent.trigger,
          submission_id: intent.submissionId,
          created_at: new Date(intent.createdAt),
          applied_at: null,
          attempts: 0,
          last_failure_code: null,
        })
        .onConflict(oc => oc
          .columns(["signing_request_id", "request_recipient_id", "trigger_kind"])
          .doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
    },
  };
}

// ── The workspace realm ──────────────────────────────────────────────────────

export function createScopedSigningWorkflowRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedSigningWorkflowRepository {
  return {
    async lockRequest(signingRequestId: SigningRequestId) {
      // `for update`. The outermost link in OD-151's canonical order, taken
      // before any recipient row, so a terminal transition and an advance
      // cannot interleave — and so two advances serialize here instead of
      // deadlocking somewhere further down.
      const row = await trx.selectFrom("signing_requests")
        .select(["state", "completion_ready_at"])
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        state: row.state,
        completionReadyAt: millis(row.completion_ready_at),
      };
    },

    async listRecipientStates(
      signingRequestId: SigningRequestId,
    ): Promise<readonly WorkflowRecipientRecord[]> {
      // Joined to the IMMUTABLE snapshot. `recipient_type`, `is_required` and
      // `routing_order` are what the request froze, never what a preparation or
      // a contact says today (§43, §268).
      const rows = await trx.selectFrom("signing_request_recipient_activation as a")
        .innerJoin("signing_request_recipients as p", join => join
          .onRef("p.workspace_id", "=", "a.workspace_id")
          .onRef("p.signing_request_id", "=", "a.signing_request_id")
          .onRef("p.request_recipient_id", "=", "a.request_recipient_id"))
        .select([
          "a.request_recipient_id", "a.recipient_state", "a.activated_at",
          "a.signed_at", "a.submission_id", "a.declined_at", "a.decline_reason",
          "p.recipient_type", "p.is_required", "p.routing_order",
        ])
        .where("a.workspace_id", "=", scope)
        .where("a.signing_request_id", "=", signingRequestId)
        // Ordered in SQL, and by routing order first: the plan walks cohorts,
        // and "insertion order" is an assumption PostgreSQL never made.
        .orderBy("p.routing_order", "asc")
        .orderBy("a.request_recipient_id", "asc")
        .execute();

      return rows.map(row => ({
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        type: oneOf<RecipientType>(
          RECIPIENT_TYPES, "signing_request_recipients", "recipient_type",
          row.recipient_type),
        isRequired: row.is_required,
        routingOrder: row.routing_order,
        state: oneOf<RecipientWorkflowState>(
          RECIPIENT_WORKFLOW_STATES, "signing_request_recipient_activation",
          "recipient_state", row.recipient_state),
        activatedAt: millis(row.activated_at),
        signedAt: millis(row.signed_at),
        submissionId: row.submission_id as RecipientSubmissionId | null,
        declinedAt: millis(row.declined_at),
        declineReason: row.decline_reason === null ? null : oneOf<SigningDeclineReason>(
          SIGNING_DECLINE_REASONS, "signing_request_recipient_activation",
          "decline_reason", row.decline_reason),
      }));
    },

    async activateRecipients(input): Promise<number> {
      if (input.recipientIds.length === 0) return 0;
      const result = await trx.updateTable("signing_request_recipient_activation")
        .set({
          recipient_state: "active",
          activated_at: new Date(input.activatedAt),
        })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        .where("request_recipient_id", "in", [...input.recipientIds])
        // Only from `waiting`. A recipient another attempt already activated
        // matches zero rows, so a replayed advance cannot reset their
        // `activated_at` to a later instant (§59).
        .where("recipient_state", "=", "waiting")
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async markPartiallyCompleted(signingRequestId: SigningRequestId) {
      const result = await trx.updateTable("signing_requests")
        .set({ state: "partially-completed", updated_at: sql`now()` })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .where("state", "=", "sent")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markCompletionReady(input) {
      const result = await trx.updateTable("signing_requests")
        .set({
          state: "completion-ready",
          completion_ready_at: new Date(input.completionReadyAt),
          updated_at: sql`now()`,
        })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        .where("state", "in", [...ADVANCEABLE_STATES])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markDeclined(input) {
      const result = await trx.updateTable("signing_requests")
        .set({
          state: "declined",
          terminated_at: new Date(input.terminatedAt),
          termination_reason: "declined",
          updated_at: sql`now()`,
        })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        .where("state", "in", [...ADVANCEABLE_STATES])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markCancelled(input) {
      const result = await trx.updateTable("signing_requests")
        .set({
          state: "cancelled",
          terminated_at: new Date(input.terminatedAt),
          termination_reason: "cancelled",
          cancellation_note: input.note,
          updated_at: sql`now()`,
        })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        // NOT from `completion-ready`. The product offers cancel only while the
        // transaction is active, and a request whose signatures are all
        // collected is not (§95).
        .where("state", "in", [...ADVANCEABLE_STATES])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async revokeActiveGrants(input): Promise<number> {
      const result = await trx.updateTable("signing_access_grants")
        .set({ revoked_at: new Date(input.revokedAt) })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async revokeRecipientSessions(input): Promise<number> {
      const result = await trx.updateTable("recipient_signing_sessions")
        .set({
          revoked_at: new Date(input.revokedAt),
          // The vocabulary BACKEND-34 declared for exactly this moment and
          // nothing had ever written.
          revocation_reason: "request-terminal",
        })
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", input.signingRequestId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async claimAdvanceIntent(intentId: SigningWorkflowIntentId) {
      // Claim and increment in ONE statement, conditional on still being
      // outstanding. Two attempts racing the same intent: one gets the row, the
      // other gets null and does nothing.
      const row = await trx.updateTable("signing_workflow_advance_intents")
        .set(eb => ({ attempts: eb("attempts", "+", 1) }))
        .where("intent_id", "=", intentId)
        .where("workspace_id", "=", scope)
        .where("applied_at", "is", null)
        .returning([
          "intent_id", "workspace_id", "signing_request_id",
          "request_recipient_id", "trigger_kind", "attempts",
        ])
        .executeTakeFirst();
      return row === undefined ? null : toIntentRef(row);
    },

    async listOutstandingAdvances(signingRequestId: SigningRequestId) {
      const rows = await trx.selectFrom("signing_workflow_advance_intents")
        .select([
          "intent_id", "workspace_id", "signing_request_id",
          "request_recipient_id", "trigger_kind", "attempts",
        ])
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .where("applied_at", "is", null)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(toIntentRef);
    },

    async markAdvanceApplied(input): Promise<void> {
      await trx.updateTable("signing_workflow_advance_intents")
        .set({ applied_at: new Date(input.appliedAt), last_failure_code: null })
        .where("intent_id", "=", input.intentId)
        .where("workspace_id", "=", scope)
        .execute();
    },

    async recordAdvanceFailure(input): Promise<void> {
      await trx.updateTable("signing_workflow_advance_intents")
        // Truncated to the column's width by construction: the caller passes a
        // code from a closed set, and this asserts the bound rather than
        // trusting it, because an exception message reaching here is exactly
        // the failure §197 is about.
        .set({ last_failure_code: input.code.slice(0, 64) })
        .where("intent_id", "=", input.intentId)
        .where("workspace_id", "=", scope)
        .execute();
    },
  };
}

// ── The reconciler ───────────────────────────────────────────────────────────

/**
 * Outstanding advances across every tenant.
 *
 * No workspace scope, because the question is which workspaces have work. The
 * table carries no RLS policy for exactly this reason, and the safety argument
 * is its CONTENT: identifiers and a bounded trigger, nothing about anybody.
 */
export function createSigningWorkflowReconciliationRepository(
  trx: Transaction<Database>,
): SigningWorkflowReconciliationRepository {
  return {
    async listOutstanding(input) {
      const rows = await trx.selectFrom("signing_workflow_advance_intents")
        .select([
          "intent_id", "workspace_id", "signing_request_id",
          "request_recipient_id", "trigger_kind", "attempts",
        ])
        .where("applied_at", "is", null)
        // A permanently failing intent stops being swept and stays in the table
        // with its failure code — a signal an operator can act on, rather than
        // an infinite retry that starves everything behind it.
        .where("attempts", "<", input.attemptsBelow)
        .orderBy("created_at", "asc")
        .limit(input.limit)
        .execute();
      return rows.map(toIntentRef);
    },
  };
}
