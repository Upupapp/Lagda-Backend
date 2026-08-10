// 024 — the signing workflow state machine.
//
// ── One state per recipient, on the table that already gated them ──────────
//
// BACKEND-33 created `signing_request_recipient_activation` with two values and
// wrote at its declaration: "Routing activation. Two values, and neither is a
// ceremony state." That was right while `waiting` and `active` were the only
// answers. It stops being right here.
//
// Once `signed` exists, "whose turn is it" and "what did they do" are the same
// question: a recipient who has signed is not waiting for a turn, and every
// gate that asks whether they may act needs the same answer. Two columns on two
// tables would be two answers that must agree, and §15 forbids exactly the
// combinations that would produce.
//
// So the column is WIDENED and RENAMED — `activation_state` -> `recipient_state`
// — rather than a second state being added beside it. The rename is not
// cosmetic: `activation_state = 'signed'` reads as a lie.
//
// `signing_recipient_progress` keeps what it was built for and nothing more:
// `first_entered_at`, the ceremony-entry event. It gains no state column, so
// there is still exactly one place a recipient's position is recorded.
//
// ── The one state that is not from the product ─────────────────────────────
//
// `completion-ready`. Every other value in the request CHECK was read out of
// the product's `TransactionStatus`. This one was added because the product
// conflates two facts that fail independently — "everyone signed" and "the
// completed document exists" — and PDF merge, certificate generation and
// sealing all happen after the last signature and can all fail. Writing
// `completed` at the last signature would claim an artifact nobody has, in a
// state that is terminal and cannot be walked back.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No `completed`, no `completed_at`. BACKEND-38 adds both, with the pipeline
// that earns them. No `expired` and no `ready-to-send`: nothing can produce
// either, and a CHECK that admits a state no code can reach is a permission
// granted in advance of the thing it permits.

import { type Kysely, sql } from "kysely";

/**
 * Request states the database will admit after this migration.
 *
 * Six. `draft` and `sent` are BACKEND-32's and BACKEND-33's; the other four are
 * earned here by the transitions below them.
 */
const REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "declined",
  "cancelled",
] as const;

/** How a request ended, when it ended before completing. */
const TERMINATION_REASONS = ["declined", "cancelled"] as const;

/** The recipient workflow states. Mirrors `RECIPIENT_WORKFLOW_STATES`. */
const RECIPIENT_STATES = ["waiting", "active", "signed", "declined"] as const;

/**
 * Why a recipient refused. Exactly `DECLINE_REASON_CATEGORIES` from the
 * product, as a CLOSED set — never the free-text note the page also offers.
 */
const DECLINE_REASONS = [
  "not-agree", "not-intended", "needs-correction", "cannot-complete", "other",
] as const;

/** What caused a workflow advance to be needed. */
const ADVANCE_TRIGGERS = ["submission", "decline"] as const;

/** The product's own cancel dialog trims its reason to 200 characters. */
const CANCELLATION_NOTE_MAX = 200;

const RECIPIENT_SESSION_DIGEST_FN = "lagda_current_recipient_session_digest()";

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The request's new states and timestamps ─────────────────────────────────
  await sql`
    alter table signing_requests drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(REQUEST_STATES)}))
  `.execute(db);

  /**
   * WHEN the workflow closed to further signing.
   *
   * §67 asks for a deliberate decision between the final submission's
   * `acceptedAt` and the backend transition time. It is the TRANSITION time,
   * and the reason is that they answer different questions: `acceptedAt` is
   * when a person signed, and this is when LAGDA determined nothing further is
   * outstanding. Under the synchronous path they are milliseconds apart; when
   * the advance is applied by a retry they are not, and collapsing them would
   * silently reattribute a scheduling delay to a human act — the same error
   * INV-548 forbids for `signed_at`.
   *
   * It is NOT `completed_at`. The document does not exist yet.
   */
  await sql`
    alter table signing_requests add column completion_ready_at timestamptz
  `.execute(db);
  await sql`
    alter table signing_requests add column terminated_at timestamptz
  `.execute(db);
  await sql`
    alter table signing_requests add column termination_reason varchar(32)
  `.execute(db);
  /**
   * The sender's reason for cancelling.
   *
   * The product REQUIRES it (`doCancel` refuses an empty reason) and trims it
   * to 200 characters, so both are matched here. It is workspace-authored
   * content about the workspace's own document — a different risk class from
   * the recipient's decline note, which is authored by an external party and is
   * deliberately not stored (§78). Never logged, never in telemetry.
   */
  await sql`
    alter table signing_requests
      add column cancellation_note varchar(${sql.raw(String(CANCELLATION_NOTE_MAX))})
  `.execute(db);

  // The old CHECK named `draft` and `sent` explicitly and would refuse every
  // state added above. Replaced with the rule it was really expressing: a
  // request that has left draft has been sent, and one that has not, has not.
  //
  // This also forbids `draft -> cancelled` at the database. The domain table
  // permits that edge and nothing implements it — the product offers cancel
  // only on an active transaction — so the constraint is the honest statement
  // of what can currently happen. BACKEND-46 widens it if it builds the edge.
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_sent_at_matches_state
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_sent_at_matches_state check (
        (state = 'draft' and sent_at is null)
        or (state <> 'draft' and sent_at is not null)
      )
  `.execute(db);

  // Implication rather than equivalence, on purpose: BACKEND-38 moves
  // `completion-ready` to `completed` and the timestamp must SURVIVE that move.
  // An `=` here would force the next command to drop this constraint.
  await sql`
    alter table signing_requests
      add constraint signing_requests_completion_ready_at_present check (
        state <> 'completion-ready' or completion_ready_at is not null
      )
  `.execute(db);

  await sql`
    alter table signing_requests
      add constraint signing_requests_termination_reason_check
      check (termination_reason is null
             or termination_reason in (${inList(TERMINATION_REASONS)}))
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_termination_agrees check (
        (terminated_at is null and termination_reason is null
         and state not in ('declined', 'cancelled'))
        or (terminated_at is not null and termination_reason is not null
            and state = termination_reason)
      )
  `.execute(db);
  // A note without a cancellation is a note about nothing.
  await sql`
    alter table signing_requests
      add constraint signing_requests_cancellation_note_scope check (
        cancellation_note is null or termination_reason = 'cancelled'
      )
  `.execute(db);

  // ── The submission's referenceable identity ─────────────────────────────────
  //
  // `submission_id` is already the primary key, so this adds no uniqueness.
  // What it adds is a key a FOUR-COLUMN foreign key can point at — the same
  // move migration 023 made for field assignments, and for the same reason.
  //
  // With it, a recipient's state row cannot cite a submission belonging to a
  // different recipient, a different request or a different tenant. §260 is
  // then a database property rather than an application check.
  await sql`
    alter table recipient_submissions
      add constraint recipient_submissions_identity_key
      unique (submission_id, workspace_id, signing_request_id, request_recipient_id)
  `.execute(db);

  // ── The recipient workflow state ────────────────────────────────────────────
  await sql`
    alter table signing_request_recipient_activation
      drop constraint if exists signing_request_recipient_activation_state_check
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      drop constraint if exists signing_request_recipient_activation_at_matches_state
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      rename column activation_state to recipient_state
  `.execute(db);

  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_state_check
      check (recipient_state in (${inList(RECIPIENT_STATES)}))
  `.execute(db);

  /**
   * THE signing instant, copied from `recipient_submissions.accepted_at`.
   *
   * Not a second clock reading. INV-548 says BACKEND-37 may not invent a
   * separate signing time, and the FK below is what makes the claim checkable:
   * the row names the submission it took the timestamp from, so a reader can
   * verify the two agree instead of trusting that they do.
   */
  await sql`
    alter table signing_request_recipient_activation add column signed_at timestamptz
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation add column submission_id varchar(64)
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation add column declined_at timestamptz
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation add column decline_reason varchar(32)
  `.execute(db);

  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_decline_reason_check
      check (decline_reason is null or decline_reason in (${inList(DECLINE_REASONS)}))
  `.execute(db);

  // Every non-waiting state has been activated. A recipient cannot sign a
  // document their turn never came for, and the state machine has no
  // `waiting -> signed` edge — this is that rule at the storage layer.
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_activated_at_matches_state check (
        (recipient_state = 'waiting' and activated_at is null)
        or (recipient_state <> 'waiting' and activated_at is not null)
      )
  `.execute(db);

  /**
   * SIGNED implies both a timestamp and a submission; neither may appear
   * without it.
   *
   * §108 asks for `state = SIGNED -> submission_id IS NOT NULL -> signed_at =
   * submission.accepted_at`, enforced as strongly as practical. The first two
   * links are enforced here. The third — that the two timestamps are equal —
   * cannot be a CHECK, because a CHECK may not read another table; it is
   * enforced by the write path taking `signed_at` from the submission record it
   * is already holding, and asserted by test.
   */
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_signed_agrees check (
        (recipient_state = 'signed'
          and signed_at is not null and submission_id is not null)
        or (recipient_state <> 'signed'
          and signed_at is null and submission_id is null)
      )
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_declined_agrees check (
        (recipient_state = 'declined'
          and declined_at is not null and decline_reason is not null)
        or (recipient_state <> 'declined'
          and declined_at is null and decline_reason is null)
      )
  `.execute(db);

  // FOUR columns. The state row's submission must belong to THIS recipient of
  // THIS request in THIS tenant, or it has no referent at all.
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_submission_fk
      foreign key (submission_id, workspace_id, signing_request_id,
                   request_recipient_id)
      references recipient_submissions
        (submission_id, workspace_id, signing_request_id, request_recipient_id)
  `.execute(db);

  // How the advance evaluation finds a request's recipients. The primary key
  // leads with `workspace_id, signing_request_id`, so this is only needed for
  // the outstanding-work scan the reconciler performs.
  await sql`
    create index signing_request_recipient_state_idx
      on signing_request_recipient_activation
         (workspace_id, signing_request_id, recipient_state)
  `.execute(db);

  // ── The durable advance intent ──────────────────────────────────────────────
  //
  // ── Why this table exists at all ──────────────────────────────────────────
  //
  // §24 prefers the whole progression to commit inside the submission
  // transaction. It cannot, and the reason is a security property rather than a
  // convenience: migration 022 bound the recipient realm to its OWN recipient
  // row with RESTRICTIVE policies, so a recipient's transaction cannot read the
  // NEXT recipient's type, routing order, name or email. Provisioning the next
  // cohort needs all four — the delivery intent literally carries the address.
  //
  // Widening that policy to let a signer's own request read every participant
  // would trade the strongest tenancy control in the signing stack for
  // transactional tidiness. So the recipient's own state commits with their
  // submission, and the part that needs a workspace view is handed over here.
  //
  // ── Why a domain table and not a generic outbox ───────────────────────────
  //
  // ADR-026 made this call already: BACKEND-33 rejected a generic outbox in
  // favour of `signing_delivery_intents`, "a workspace-scoped, RLS-protected,
  // queryable shape". This follows that precedent rather than introducing a
  // second mechanism.
  //
  // ── Why it has no RLS ─────────────────────────────────────────────────────
  //
  // The reconciler must find stranded work ACROSS tenants, and a cross-tenant
  // scan of an RLS table would need `BYPASSRLS` — rejected four times as
  // INV-334. `idempotency_records` is the documented precedent: it carries no
  // workspace_id policy either, and is scoped by identity in every query.
  //
  // The safety argument is what it CONTAINS. Opaque identifiers and a bounded
  // trigger vocabulary. No name, no address, no field value, no credential, no
  // document title. A reader of every row learns that some request needs
  // evaluating, and nothing about anybody.
  await sql`
    create table signing_workflow_advance_intents (
      intent_id             varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      trigger_kind          varchar(16)  not null,
      -- The submission that caused it, for traceability (§33). NULL for a
      -- decline, which has no submission by definition (§79).
      submission_id         varchar(64),

      created_at            timestamptz  not null,
      -- NULL while outstanding. Set once, by whichever attempt applies it.
      applied_at            timestamptz,
      attempts              integer      not null default 0,
      -- A BOUNDED code, never an exception message. An error string here would
      -- be the one place in this table something unbounded could arrive.
      last_failure_code     varchar(64),

      constraint signing_workflow_advance_trigger_check
        check (trigger_kind in (${inList(ADVANCE_TRIGGERS)})),
      constraint signing_workflow_advance_submission_shape check (
        (trigger_kind = 'submission' and submission_id is not null)
        or (trigger_kind = 'decline' and submission_id is null)
      ),
      constraint signing_workflow_advance_attempts_bounded
        check (attempts >= 0),

      -- ONE intent per recipient per trigger (§164). Reprocessing the same
      -- accepted submission cannot enqueue a second advance, so a duplicate
      -- delivery cannot duplicate routing activation.
      constraint signing_workflow_advance_identity
        unique (signing_request_id, request_recipient_id, trigger_kind)
    )
  `.execute(db);

  // Partial, so the index stays the size of the BACKLOG rather than the size of
  // history — the same shape `signing_delivery_intents_pending_idx` uses.
  await sql`
    create index signing_workflow_advance_pending_idx
      on signing_workflow_advance_intents (created_at)
      where applied_at is null
  `.execute(db);

  await sql`
    grant select, insert, update on table signing_workflow_advance_intents
      to lagda_app
  `.execute(db);

  // ── Recipient-realm scoping for the routing tables ──────────────────────────
  //
  // A HARDENING FOUND WHILE BUILDING THIS.
  //
  // Migration 022 added restrictive recipient scoping to six tables and did not
  // add it to `signing_request_recipient_activation`, `signing_access_grants`
  // or `signing_delivery_intents`. Nothing exposed those to the recipient realm
  // — `RecipientCeremonyUnitOfWork` has no repository that reaches them — so
  // the gap was closed by the TYPE and not by the database.
  //
  // BACKEND-37 is the command that gives the recipient realm a legitimate write
  // to the first of those three, which makes the difference matter: with only
  // tenant isolation, a bug in that write could set another recipient's state.
  const scopeToOwnRecipient = async (table: string) => {
    const predicate = `
      ${RECIPIENT_SESSION_DIGEST_FN} is null
      or exists (
        select 1 from recipient_signing_sessions s
        where s.token_digest = ${RECIPIENT_SESSION_DIGEST_FN}
          and s.workspace_id         = ${table}.workspace_id
          and s.signing_request_id   = ${table}.signing_request_id
          and s.request_recipient_id = ${table}.request_recipient_id
      )
    `;
    await sql`
      create policy recipient_workflow_scope on ${sql.raw(table)}
      as restrictive
      using (${sql.raw(predicate)})
      with check (${sql.raw(predicate)})
    `.execute(db);
  };
  await scopeToOwnRecipient("signing_request_recipient_activation");

  // Grants and delivery intents are refused to the recipient realm OUTRIGHT.
  // There is no such thing as a recipient reading a bearer credential digest or
  // a queued email — not even their own, which they already hold. A restrictive
  // policy that is simply false inside the realm says so in one line.
  for (const table of ["signing_access_grants", "signing_delivery_intents"]) {
    await sql`
      create policy recipient_realm_denied on ${sql.raw(table)}
      as restrictive
      using (${sql.raw(`${RECIPIENT_SESSION_DIGEST_FN} is null`)})
      with check (${sql.raw(`${RECIPIENT_SESSION_DIGEST_FN} is null`)})
    `.execute(db);
  }

  // ── Backfill ────────────────────────────────────────────────────────────────
  //
  // §216 is mandatory where relevant: BACKEND-36 accepted submissions before
  // this state column existed, and every one of them is an authoritative
  // signing act whose recipient would otherwise read as still outstanding.
  //
  // `signed_at` comes from the submission, never from `now()`. The `activated_at`
  // fallback exists only to satisfy the new CHECK for a row that somehow signed
  // without an activation timestamp; it uses the same submission instant rather
  // than inventing a third.
  await sql`
    update signing_request_recipient_activation a
       set recipient_state = 'signed',
           signed_at       = s.accepted_at,
           submission_id   = s.submission_id,
           activated_at    = coalesce(a.activated_at, s.accepted_at)
      from recipient_submissions s
     where s.workspace_id         = a.workspace_id
       and s.signing_request_id   = a.signing_request_id
       and s.request_recipient_id = a.request_recipient_id
       and a.recipient_state <> 'signed'
  `.execute(db);

  /**
   * Requests whose every required participant is already signed.
   *
   * §217 permits this only under the product's own rules, so the predicate is
   * the SQL twin of `isRequiredSigningParticipant`: a participant counts when
   * their type can hold fields — `viewer` and `carbon-copy` cannot — and their
   * snapshot marks them required. `not exists` over the outstanding set, so a
   * request with no required participants at all is NOT swept up.
   *
   * `completion_ready_at` is the newest signing instant among the required
   * participants rather than `now()`: the readiness was reached then, and this
   * migration is only recording it late.
   */
  await sql`
    update signing_requests r
       set state = 'completion-ready',
           completion_ready_at = ready.last_signed_at
      from (
        select a.workspace_id, a.signing_request_id, max(a.signed_at) as last_signed_at
          from signing_request_recipient_activation a
          join signing_request_recipients p
            on p.workspace_id         = a.workspace_id
           and p.signing_request_id   = a.signing_request_id
           and p.request_recipient_id = a.request_recipient_id
         where p.is_required
           and p.recipient_type not in ('viewer', 'carbon-copy')
         group by a.workspace_id, a.signing_request_id
        having count(*) filter (where a.recipient_state <> 'signed') = 0
      ) ready
     where r.workspace_id       = ready.workspace_id
       and r.signing_request_id = ready.signing_request_id
       and r.state = 'sent'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["signing_access_grants", "signing_delivery_intents"]) {
    await sql`drop policy if exists recipient_realm_denied on ${sql.raw(table)}`
      .execute(db);
  }
  await sql`
    drop policy if exists recipient_workflow_scope
      on signing_request_recipient_activation
  `.execute(db);

  await db.schema.dropTable("signing_workflow_advance_intents").ifExists().execute();

  // Anything this migration could produce must be walked back before the old,
  // narrower constraints go on again — otherwise `down` fails on the very data
  // `up` created, which is the usual way a reversible migration turns out not
  // to be.
  await sql`
    update signing_requests
       set state = 'sent', completion_ready_at = null,
           terminated_at = null, termination_reason = null, cancellation_note = null
     where state in ('partially-completed', 'completion-ready', 'declined', 'cancelled')
  `.execute(db);
  await sql`
    update signing_request_recipient_activation
       set recipient_state = case when activated_at is null then 'waiting' else 'active' end,
           signed_at = null, submission_id = null,
           declined_at = null, decline_reason = null
     where recipient_state in ('signed', 'declined')
  `.execute(db);

  await sql`drop index if exists signing_request_recipient_state_idx`.execute(db);
  for (const constraint of [
    "signing_request_recipient_submission_fk",
    "signing_request_recipient_declined_agrees",
    "signing_request_recipient_signed_agrees",
    "signing_request_recipient_activated_at_matches_state",
    "signing_request_recipient_decline_reason_check",
    "signing_request_recipient_state_check",
  ]) {
    await sql`
      alter table signing_request_recipient_activation
        drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
  }
  for (const column of ["decline_reason", "declined_at", "submission_id", "signed_at"]) {
    await sql`
      alter table signing_request_recipient_activation
        drop column if exists ${sql.raw(column)}
    `.execute(db);
  }
  await sql`
    alter table signing_request_recipient_activation
      rename column recipient_state to activation_state
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_activation_state_check
      check (activation_state in ('waiting', 'active'))
  `.execute(db);
  await sql`
    alter table signing_request_recipient_activation
      add constraint signing_request_recipient_activation_at_matches_state check (
        (activation_state = 'waiting' and activated_at is null)
        or (activation_state = 'active' and activated_at is not null)
      )
  `.execute(db);

  await sql`
    alter table recipient_submissions
      drop constraint if exists recipient_submissions_identity_key
  `.execute(db);

  for (const constraint of [
    "signing_requests_cancellation_note_scope",
    "signing_requests_termination_agrees",
    "signing_requests_termination_reason_check",
    "signing_requests_completion_ready_at_present",
    "signing_requests_sent_at_matches_state",
    "signing_requests_state_check",
  ]) {
    await sql`
      alter table signing_requests drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
  }
  for (const column of [
    "cancellation_note", "termination_reason", "terminated_at", "completion_ready_at",
  ]) {
    await sql`
      alter table signing_requests drop column if exists ${sql.raw(column)}
    `.execute(db);
  }
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check check (state in ('draft', 'sent'))
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_sent_at_matches_state check (
        (state = 'draft' and sent_at is null)
        or (state = 'sent' and sent_at is not null)
      )
  `.execute(db);
}
