// 029 — evidence event versioning, provenance, and source uniqueness.
//
// ── What BACKEND-43 found ──────────────────────────────────────────────────
//
// `evidence_events` has existed since migration 003 and has NEVER been written
// to by anything except its own repository contract suite. Thirteen event types,
// a closed actor model, RLS, forced privilege separation, an 8 KB payload cap, a
// timeline index — and zero producers.
//
// BACKEND-43 is the cross-cutting command that wires the lifecycle into it. Three
// things must exist first, and none of them do.
//
// ── 1. A mandatory event version ───────────────────────────────────────────
//
// `details_version` exists, but a CHECK ties it to the payload:
//
//     check ((details is null) = (details_version is null))
//
// So an event with no payload carries no version at all — and most evidence
// events have no payload, because their facts are typed columns. That column
// versions the DETAILS BLOB. BACKEND-43 §12 needs something different: a version
// per event TYPE, present on every row, so a `transaction-sent` written today
// stays interpretable after the meaning of `transaction-sent` is refined.
//
// The two are kept separate rather than merged. A payload can gain a field
// without the event's semantics changing, and the event's semantics can change
// while the payload stays empty.
//
// ── 2. Source provenance ───────────────────────────────────────────────────
//
// `source_type` and `source_id` do not exist. They are the idempotency backbone
// (§118): the durable identity of the authoritative fact an event was derived
// from — a `RecipientSubmissionId`, a `CompletionRunId` plus its step, a
// `SigningRequestCompletionId`.
//
// ── 3. Uniqueness on that source ───────────────────────────────────────────
//
// Without it, §44's "retries must not duplicate events" can only be enforced by
// check-then-insert, which §46 forbids outright — two workers racing both read
// "absent" and both insert.
//
// The unique index is PARTIAL, and that is the whole design. `document-viewed`
// may legitimately occur many times (003 §4 says so, and deliberately declined a
// `UNIQUE (signing_request_id, event_type)` for exactly this reason). An event
// with no single durable source is unconstrained; an event WITH one can appear at
// most once. §305 warns against one broad constraint blocking legitimate repeats,
// and a partial index is how the two live together.
//
// ── Six new event types ────────────────────────────────────────────────────
//
// The 2026-08-11 gap analysis found six authoritative facts with no type to
// record them. Kebab-case, matching the existing vocabulary rather than starting
// a second SCREAMING_SNAKE one.
//
// `submission-accepted` is deliberately NOT folded into `signature-completed`.
// They are different facts: the backend accepting an immutable submission (§62)
// versus the workflow transitioning that recipient to SIGNED (§63). They share a
// timestamp by design — §248 requires it — and §43's precedence rule is what
// orders them for a reader.

import { type Kysely, sql } from "kysely";

/**
 * The evidence event vocabulary as of BACKEND-43.
 *
 * Duplicated from the application package on purpose — a migration describes the
 * schema at ITS point in history, not a constant that keeps moving underneath
 * it. Migration 026 shipped a defect by widening one of two CHECKs for the same
 * vocabulary, so a guard test asserts these lists agree with the application's.
 */
export const MIGRATION_029_EVENT_TYPES = [
  // 003's thirteen.
  "transaction-created", "transaction-sent", "transaction-cancelled",
  "transaction-expired", "transaction-completed", "invitation-sent",
  "authentication-completed", "consent-accepted", "document-viewed",
  "signature-completed", "participant-declined", "document-sealed",
  "verification-record-created",
  // BACKEND-43's six.
  "recipient-activated", "submission-accepted", "completion-ready",
  "field-merge-completed", "certificate-generated", "final-seal-completed",
] as const;

/** 003's vocabulary — what the CHECK admits before this migration. */
const OLD_EVENT_TYPES: readonly string[] = MIGRATION_029_EVENT_TYPES.slice(0, 13);

/**
 * The durable records an evidence event may be derived from.
 *
 * Closed, and small on purpose. A source is not "anything with an id" — it is
 * the specific immutable row whose existence makes the event a fact, which is
 * what lets uniqueness on it mean "this fact was already recorded".
 */
export const MIGRATION_029_SOURCE_TYPES = [
  "signing-request", "signing-request-recipient", "recipient-submission",
  "recipient-consent", "recipient-session", "completion-run",
  "completion-step", "signing-request-completion", "document-seal",
  "verification-record",
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The event version ─────────────────────────────────────────────────────
  //
  // NOT NULL with a default, then the default is dropped. Existing rows get 1;
  // every future writer must state a version explicitly, because "whatever the
  // column defaults to" is not a version an event asserted about itself.
  //
  // Backfilling existing rows is vacuous here — the table is empty and provably
  // so, since nothing has ever appended to it — but the migration must be
  // correct against a populated table too, not merely against this one.
  await sql`
    alter table evidence_events
      add column if not exists event_version integer not null default 1
  `.execute(db);
  await sql`
    alter table evidence_events alter column event_version drop default
  `.execute(db);
  await sql`
    alter table evidence_events
      add constraint evidence_events_event_version_positive
      check (event_version > 0)
  `.execute(db);

  // ── Source provenance ─────────────────────────────────────────────────────
  await sql`
    alter table evidence_events
      add column if not exists source_type varchar(32),
      add column if not exists source_id   varchar(64)
  `.execute(db);

  await sql`
    alter table evidence_events
      add constraint evidence_events_source_type_check
      check (source_type is null or source_type in (${inList(MIGRATION_029_SOURCE_TYPES)}))
  `.execute(db);

  // Both or neither. A source type with no id identifies nothing, and an id with
  // no type is ambiguous across tables — either half alone would make the
  // uniqueness below meaningless while looking populated.
  await sql`
    alter table evidence_events
      add constraint evidence_events_source_pair_check
      check ((source_type is null) = (source_id is null))
  `.execute(db);

  // ── Uniqueness, partial ───────────────────────────────────────────────────
  //
  // One event of a given type per authoritative source. Scoped by workspace
  // first, matching every other index on this table and keeping the constraint
  // tenant-safe if two workspaces ever mint the same source id.
  //
  // Rows with no source are excluded by the WHERE clause, so repeatable events
  // like `document-viewed` are untouched.
  await sql`
    create unique index evidence_events_source_unique
      on evidence_events (workspace_id, event_type, source_type, source_id)
      where source_id is not null
  `.execute(db);

  // The dedupe lookup: "has this fact already been recorded?" asked by source
  // rather than by timeline. Distinct from the unique index above because a
  // producer resolving an existing event needs to read the row, not just be
  // refused.
  await sql`
    create index evidence_events_source_idx
      on evidence_events (source_type, source_id, event_type)
  `.execute(db);

  // ── The widened type vocabulary ───────────────────────────────────────────
  await sql`
    alter table evidence_events drop constraint if exists evidence_events_type_check
  `.execute(db);
  await sql`
    alter table evidence_events
      add constraint evidence_events_type_check
      check (event_type in (${inList(MIGRATION_029_EVENT_TYPES)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Remove the rows the widened vocabulary permitted before narrowing it. A
  // reversible migration that fails on the data it admitted is not reversible —
  // the same reasoning 026 and 027 used.
  //
  // A DELETE against an append-only evidence table is defensible only here:
  // `down` runs as the migration role, not `lagda_app`, and these are rows that
  // could not have existed before this migration created their type.
  await sql`
    delete from evidence_events
     where event_type in (${inList(MIGRATION_029_EVENT_TYPES.slice(13))})
  `.execute(db);

  await sql`
    alter table evidence_events drop constraint if exists evidence_events_type_check
  `.execute(db);
  await sql`
    alter table evidence_events
      add constraint evidence_events_type_check
      check (event_type in (${inList(OLD_EVENT_TYPES)}))
  `.execute(db);

  await sql`drop index if exists evidence_events_source_idx`.execute(db);
  await sql`drop index if exists evidence_events_source_unique`.execute(db);

  await sql`
    alter table evidence_events
      drop constraint if exists evidence_events_source_pair_check
  `.execute(db);
  await sql`
    alter table evidence_events
      drop constraint if exists evidence_events_source_type_check
  `.execute(db);
  await sql`
    alter table evidence_events
      drop column if exists source_id,
      drop column if exists source_type
  `.execute(db);

  await sql`
    alter table evidence_events
      drop constraint if exists evidence_events_event_version_positive
  `.execute(db);
  await sql`
    alter table evidence_events drop column if exists event_version
  `.execute(db);
}
