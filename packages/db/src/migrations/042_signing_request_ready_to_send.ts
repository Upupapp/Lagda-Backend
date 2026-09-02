// 042 — `ready-to-send`, the last state the contract declared and the database
// refused.
//
// ── What it is, read out of the product ────────────────────────────────────
//
// `status-map.ts` calls it "Ready to Send" and describes it as "Document is
// prepared and ready to send to recipients". `transaction-detail.service.ts`
// computes `isDraft = status === "draft" || status === "ready-to-send"`, so it
// is a SUB-STATE OF NOT-YET-SENT: the same actions remain available, and the
// same things may still be changed.
//
// `@lagda/core` agrees and has since BACKEND-32 -- `isEditable` and
// `isEditableForSend` both already return true for it. Nothing about the
// meaning is being invented here; only the CHECK that refused to store it.
//
// ── It is OPTIONAL, and that is core's decision, not this migration's ──────
//
// `isEditableForSend` accepts `draft` AND `ready-to-send`, so send still works
// straight from a draft. Making the intermediate state mandatory would break
// every existing send flow to buy a review step nobody asked for.
//
// ── The constraint this state would have broken ────────────────────────────
//
// `signing_requests_sent_at_matches_state` reads, after 024 widened it:
//
//     (state = 'draft' AND sent_at IS NULL)
//     OR (state <> 'draft' AND sent_at IS NOT NULL)
//
// `ready-to-send` is not `draft`, so that constraint would demand a `sent_at`
// for a request NOBODY HAS SENT -- and the first `markReadyToSend` would have
// failed at the write with a constraint violation. The rule was never "not
// draft implies sent"; it was "not yet sent implies no timestamp", and there
// is now more than one state that means not yet sent.

import { type Kysely, sql } from "kysely";

/** Request states the database admits AFTER this migration. All NINE. */
const REQUEST_STATES = [
  "draft",
  "ready-to-send",
  "sent",
  "partially-completed",
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;

/** 041's vocabulary, for `down`. */
const OLD_REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;

/**
 * The states that mean "not sent yet", and therefore carry no `sent_at`.
 *
 * Named once because the constraint below is the only thing that enforces it,
 * and a second copy in a WHERE clause somewhere is how the two drift.
 */
const UNSENT_STATES = ["draft", "ready-to-send"] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(REQUEST_STATES)}))
  `.execute(db);

  // Still biconditional, and still for 020's reason: a state and its timestamp
  // that can disagree is a request claiming something nobody did. What changes
  // is the left-hand side -- "not sent yet" is now a set, not a single value.
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_sent_at_matches_state
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_sent_at_matches_state check (
        (state in (${inList(UNSENT_STATES)}) and sent_at is null)
        or (state not in (${inList(UNSENT_STATES)}) and sent_at is not null)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refuses rather than choosing a state for somebody. A `ready-to-send`
  // request narrowed to `draft` would silently discard the fact that a person
  // reviewed it and said it was finished.
  const { rows } = await sql<{ count: string }>`
    select count(*)::text as count from signing_requests where state = 'ready-to-send'
  `.execute(db);
  const ready = Number(rows[0]?.count ?? "0");
  if (ready > 0) {
    throw new Error(
      `Refusing to revert 042: ${String(ready)} request(s) are 'ready-to-send' `
      + "and the previous vocabulary has no value for them.",
    );
  }

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

  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(OLD_REQUEST_STATES)}))
  `.execute(db);
}
