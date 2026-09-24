// 069 — approve and skip: a genuine ceremony outcome for an approver.
//
// ── What this is, against what already existed ─────────────────────────────
//
// Migration 058 gave `approver` a RecipientType, and BACKEND-37 (024) gave
// every recipient type the same four-state machine: `waiting -> active ->
// signed|declined`. An approver's act was recorded exactly as a signature is
// — the contracts layer said so outright. That was a deliberate shortcut,
// not an oversight, and this migration is the deferred work it named.
//
// Two new terminal states, both reached only from `active`:
//
//   approved   an approver accepted — through the SAME submission mechanism
//              a signer uses (recipient_submissions, representations, field
//              values), so it shares `submission_id` with `signed` rather
//              than inventing a parallel evidence path. Counts toward
//              completion exactly as `signed` does.
//   skipped    an approver passed, with NO submission (mirrors `declined`'s
//              shape) — but unlike `declined`, a skip does NOT end the
//              request. It counts as satisfied and routing continues, the
//              same as `approved`/`signed`. Only `declined` still outranks
//              everything; that is unchanged.
//
// ── Why `submission_id` moves from a signed-only column to a shared one ────
//
// `signing_request_recipient_signed_agrees` used to assert `submission_id IS
// NULL` for every non-signed state. `approved` now legitimately carries one
// too, so that constraint is narrowed to what it actually needs to say
// (signed_at's own agreement) and a new scope constraint takes over saying
// which states may carry a submission at all.

import { type Kysely, sql } from "kysely";
import { MIGRATION_029_EVENT_TYPES } from "./029_evidence_event_provenance.js";

const RECIPIENT_STATES = ["waiting", "active", "signed", "approved", "skipped", "declined"] as const;
const ADVANCE_TRIGGERS = ["submission", "decline", "skip"] as const;
const INBOX_CLOSED_REASONS = ["signed", "approved", "skipped", "declined", "cancelled"] as const;

/**
 * The evidence event vocabulary as of 069. Built ON migration 029's own
 * historical list rather than importing the live `@lagda/application` export
 * — same reasoning 029 itself gives: a migration describes the schema at ITS
 * point in history. `069_approval_workflow.test.ts` is what now carries the
 * "agrees with the application" guard duty forward.
 */
export const MIGRATION_069_EVENT_TYPES = [
  ...MIGRATION_029_EVENT_TYPES,
  "approval-completed",
  "participant-skipped",
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The recipient workflow state ────────────────────────────────────────────
  await sql`
    alter table signing_request_recipient_activation
      drop constraint if exists signing_request_recipient_state_check
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_state_check
      check (recipient_state in (${inList(RECIPIENT_STATES)}))
  `.execute(db);

  await sql`
    alter table signing_request_recipient_activation add column approved_at timestamptz
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation add column skipped_at timestamptz
  `.execute(db);

  // ── Narrow `signed_agrees` to what it actually asserts ──────────────────────
  //
  // The submission-id half of this used to say "only `signed` may carry one".
  // `approved` legitimately carries one too now, so that half moves to its own
  // scope constraint below and this one goes back to asserting only what
  // `signed_at` itself requires.
  await sql`
    alter table signing_request_recipient_activation
      drop constraint if exists signing_request_recipient_signed_agrees
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_signed_agrees check (
        (recipient_state = 'signed' and signed_at is not null)
        or (recipient_state <> 'signed' and signed_at is null)
      )
  `.execute(db);

  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_approved_agrees check (
        (recipient_state = 'approved'
          and approved_at is not null and submission_id is not null)
        or (recipient_state <> 'approved'
          and approved_at is null)
      )
  `.execute(db);

  // The two states with a submission, named once. Replaces the half of
  // `signed_agrees` this migration took away.
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_submission_scope check (
        submission_id is null or recipient_state in ('signed', 'approved')
      )
  `.execute(db);

  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_skipped_agrees check (
        (recipient_state = 'skipped' and skipped_at is not null)
        or (recipient_state <> 'skipped' and skipped_at is null)
      )
  `.execute(db);

  // ── The durable advance intent ──────────────────────────────────────────────
  //
  // `skip` joins `submission` and `decline` as a third trigger kind, with the
  // same no-submission shape `decline` already has — a skip produces nothing
  // to reference.
  await sql`
    alter table signing_workflow_advance_intents
      drop constraint if exists signing_workflow_advance_trigger_check
  `.execute(db);
  await sql`
    alter table signing_workflow_advance_intents
      add constraint signing_workflow_advance_trigger_check
      check (trigger_kind in (${inList(ADVANCE_TRIGGERS)}))
  `.execute(db);

  await sql`
    alter table signing_workflow_advance_intents
      drop constraint if exists signing_workflow_advance_submission_shape
  `.execute(db);
  await sql`
    alter table signing_workflow_advance_intents
      add constraint signing_workflow_advance_submission_shape check (
        (trigger_kind = 'submission' and submission_id is not null)
        or (trigger_kind in ('decline', 'skip') and submission_id is null)
      )
  `.execute(db);

  // ── The evidence event vocabulary ───────────────────────────────────────────
  await sql`
    alter table evidence_events drop constraint if exists evidence_events_type_check
  `.execute(db);
  await sql`
    alter table evidence_events
      add constraint evidence_events_type_check
      check (event_type in (${inList(MIGRATION_069_EVENT_TYPES)}))
  `.execute(db);

  // ── The "must sign" inbox (migration 056) ───────────────────────────────────
  //
  // Approving or skipping closes a recipient's inbox entry exactly as signing
  // or declining does — their action is done, whichever it was.
  await sql`
    alter table user_signing_inbox
      drop constraint if exists user_signing_inbox_closed_reason
  `.execute(db);
  await sql`
    alter table user_signing_inbox
      add constraint user_signing_inbox_closed_reason
      check (closed_reason is null or closed_reason in (${inList(INBOX_CLOSED_REASONS)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Anything this migration could produce must be walked back before the
  // narrower constraints go back on, or `down` fails on the very data `up`
  // created.
  await sql`
    update signing_request_recipient_activation
       set recipient_state = 'active',
           approved_at = null, submission_id = null,
           skipped_at = null
     where recipient_state in ('approved', 'skipped')
  `.execute(db);
  await sql`
    delete from signing_workflow_advance_intents where trigger_kind = 'skip'
  `.execute(db);
  await sql`
    update user_signing_inbox set closed_reason = 'declined', closed_at = closed_at
     where closed_reason in ('approved', 'skipped')
  `.execute(db);

  await sql`
    alter table user_signing_inbox
      drop constraint if exists user_signing_inbox_closed_reason
  `.execute(db);
  await sql`
    alter table user_signing_inbox
      add constraint user_signing_inbox_closed_reason
      check (closed_reason is null or closed_reason in ('signed', 'declined', 'cancelled'))
  `.execute(db);

  await sql`
    alter table evidence_events drop constraint if exists evidence_events_type_check
  `.execute(db);
  await sql`
    alter table evidence_events
      add constraint evidence_events_type_check
      check (event_type in (${inList(MIGRATION_029_EVENT_TYPES)}))
  `.execute(db);

  await sql`
    alter table signing_workflow_advance_intents
      drop constraint if exists signing_workflow_advance_submission_shape
  `.execute(db);
  await sql`
    alter table signing_workflow_advance_intents
      add constraint signing_workflow_advance_submission_shape check (
        (trigger_kind = 'submission' and submission_id is not null)
        or (trigger_kind = 'decline' and submission_id is null)
      )
  `.execute(db);
  await sql`
    alter table signing_workflow_advance_intents
      drop constraint if exists signing_workflow_advance_trigger_check
  `.execute(db);
  await sql`
    alter table signing_workflow_advance_intents
      add constraint signing_workflow_advance_trigger_check
      check (trigger_kind in ('submission', 'decline'))
  `.execute(db);

  for (const constraint of [
    "signing_request_recipient_skipped_agrees",
    "signing_request_recipient_submission_scope",
    "signing_request_recipient_approved_agrees",
    "signing_request_recipient_signed_agrees",
  ]) {
    await sql`
      alter table signing_request_recipient_activation
        drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
  }
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_signed_agrees check (
        (recipient_state = 'signed'
          and signed_at is not null and submission_id is not null)
        or (recipient_state <> 'signed'
          and signed_at is null and submission_id is null)
      )
  `.execute(db);

  for (const column of ["skipped_at", "approved_at"]) {
    await sql`
      alter table signing_request_recipient_activation
        drop column if exists ${sql.raw(column)}
    `.execute(db);
  }

  await sql`
    alter table signing_request_recipient_activation
      drop constraint if exists signing_request_recipient_state_check
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_state_check
      check (recipient_state in ('waiting', 'active', 'signed', 'declined'))
  `.execute(db);
}
