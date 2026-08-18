// 030 — the provider-neutral notification substrate.
//
// ── Two tables, because they have different lifetimes ──────────────────────
//
//   notification_intents      the durable decision to communicate. Immutable.
//   notification_deliveries   the transport work it requires. Mutable.
//
// An intent has no state column at all. It exists or it does not; the transport
// status of the work it spawned lives next door. One enum spanning both is how
// "the email bounced" becomes indistinguishable from "we never meant to send
// it" (S54, S118).
//
// ── Scope is a real discriminant, not a nullable workspace ─────────────────
//
// A password reset belongs to an account. A signing invitation belongs to a
// workspace. Forcing the first into a fabricated `workspace_id` (S46, S186)
// would put a global security message behind a tenant filter — readable by a
// workspace admin who has nothing to do with it, and orphaned the day the
// workspace is deleted.
//
// So both columns exist, both are nullable, and a CHECK requires EXACTLY one.
// The RLS policies then split cleanly: a workspace row is visible under a
// matching workspace context, a global row under a matching user context, and
// neither is visible under the other.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// No `sent_at`. No `provider_message_id`, no `sendgrid_*`, no `postmark_*`
// (S183). No rendered subject or body: bodies carry PII and secret-bearing
// URLs, and a column holding one keeps it for the life of the row (S77, S154).
// The frozen template INPUT is persisted instead, and the message is rendered
// just in time.
//
// BACKEND-45 adds transport state. It does not have to widen the CHECK to do
// it: all nine delivery states are already permitted here, because defining the
// vocabulary early costs nothing and a mid-integration constraint migration is
// how a deadline turns into a fake `DELIVERED`.

import { type Kysely, sql } from "kysely";

/**
 * Every provider-neutral delivery state, present from the start.
 *
 * BACKEND-44 can only WRITE `PENDING`, `CANCELLED` and `SUPPRESSED` — the
 * three reachable without a provider. That restriction lives in the domain and
 * in tests, not in this CHECK, because a constraint that has to be widened
 * during an integration is a constraint that gets widened carelessly.
 */
const DELIVERY_STATES = [
  "PENDING", "PROCESSING", "PROVIDER_ACCEPTED", "DELIVERED", "BOUNCED",
  "FAILED_RETRYABLE", "FAILED_TERMINAL", "SUPPRESSED", "CANCELLED",
] as const;

/** The business reasons LAGDA sends mail. Closed; widened by later commands. */
const NOTIFICATION_TYPES = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "MFA_OTP",
  "WORKSPACE_INVITATION", "SIGNING_INVITATION",
] as const;

/** EMAIL alone. SMS and PUSH are not speculatively permitted (S18). */
const CHANNELS = ["EMAIL"] as const;

const AUDIENCE_KINDS = [
  "USER", "SIGNING_REQUEST_RECIPIENT", "WORKSPACE_INVITEE",
] as const;

const SOURCE_KINDS = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
] as const;

/** Why a delivery stopped. Bounded codes, never a provider's response body. */
const FAILURE_CODES = [
  "SECRET_EXPIRED", "SECRET_REVOKED", "SOURCE_CANCELLED", "DESTINATION_INVALID",
] as const;

const SECRET_REF_KINDS = ["SEALED", "CHALLENGE"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Intents ────────────────────────────────────────────────────────────────
  await sql`
    create table notification_intents (
      notification_intent_id  varchar(64)  primary key,

      -- ── Scope: exactly one of these ──────────────────────────────────────
      workspace_id            varchar(64),
      user_id                 varchar(64),

      notification_type       varchar(48)  not null,

      -- ── Why this message exists ──────────────────────────────────────────
      --
      -- Polymorphic by necessity: the three source kinds live in three tables
      -- with three id types, and PostgreSQL cannot foreign-key a (kind, id)
      -- pair. A pseudo-FK naming one of them would be worse than none — it
      -- would look enforced while covering a third of the cases (S192).
      --
      -- Integrity comes from the typed constructors in the application layer
      -- and from the real audience FKs below, which is where tenant safety
      -- actually matters.
      source_kind             varchar(32)  not null,
      source_id               varchar(64)  not null,

      -- ── Who it is for: an identity, never an address (S21) ────────────────
      audience_kind           varchar(32)  not null,
      audience_user_id        varchar(64),
      audience_recipient_id   varchar(64),
      audience_invitation_id  varchar(64),

      -- ── What renders it ──────────────────────────────────────────────────
      --
      -- Frozen at creation. A deployment that ships v2 must not rewrite the
      -- content of mail already promised (S59).
      template_key            varchar(64)  not null,
      template_version        integer      not null,
      locale                  varchar(16)  not null,

      -- The frozen, NON-SECRET inputs. Strictly schema-checked by the template
      -- registry on the way in and again on the way out, so this is bounded
      -- and versioned rather than a free-form metadata bag (S180).
      template_input          jsonb        not null,

      -- ── The secret reference, never the secret ───────────────────────────
      --
      -- SEALED   an AES-256-GCM ciphertext of a credential that cannot be
      --          recovered from a digest — signing links. The mechanism
      --          OD-098 named and migration 020 proved.
      -- CHALLENGE  no credential at all, only the id of the auth challenge
      --          that owns one. Verification, reset and OTP flows persist
      --          digests and never the raw value; forcing them to SEALED would
      --          start storing secrets that today are not stored (S102, S233).
      secret_ref_kind         varchar(16),
      sealed_secret           text,
      sealed_key_version      varchar(32),
      challenge_id            varchar(64),

      created_at              timestamptz  not null,

      -- ── Exactly one scope ────────────────────────────────────────────────
      constraint notification_intents_scope_check check (
        (workspace_id is not null and user_id is null)
        or (workspace_id is null and user_id is not null)
      ),

      constraint notification_intents_type_check
        check (notification_type in (${inList(NOTIFICATION_TYPES)})),
      constraint notification_intents_source_kind_check
        check (source_kind in (${inList(SOURCE_KINDS)})),
      constraint notification_intents_audience_kind_check
        check (audience_kind in (${inList(AUDIENCE_KINDS)})),

      -- The audience column that is populated must match the declared kind.
      -- Without this a row could claim USER while carrying a recipient id, and
      -- every reader would have to re-derive which column to trust.
      constraint notification_intents_audience_match check (
        (audience_kind = 'USER'
          and audience_user_id is not null
          and audience_recipient_id is null and audience_invitation_id is null)
        or (audience_kind = 'SIGNING_REQUEST_RECIPIENT'
          and audience_recipient_id is not null
          and audience_user_id is null and audience_invitation_id is null)
        or (audience_kind = 'WORKSPACE_INVITEE'
          and audience_invitation_id is not null
          and audience_user_id is null and audience_recipient_id is null)
      ),

      -- A secret reference is all-or-nothing per kind. A SEALED row missing its
      -- key version is a ciphertext nobody can open.
      constraint notification_intents_secret_ref_check check (
        (secret_ref_kind is null
          and sealed_secret is null and sealed_key_version is null
          and challenge_id is null)
        or (secret_ref_kind = 'SEALED'
          and sealed_secret is not null and sealed_key_version is not null
          and challenge_id is null)
        or (secret_ref_kind = 'CHALLENGE'
          and challenge_id is not null
          and sealed_secret is null and sealed_key_version is null)
      ),
      constraint notification_intents_secret_kind_check
        check (secret_ref_kind is null
          or secret_ref_kind in (${inList(SECRET_REF_KINDS)})),

      constraint notification_intents_template_version_check
        check (template_version >= 1)
    )
  `.execute(db);

  // ── The idempotency backbone ───────────────────────────────────────────────
  //
  // One logical notification per (source, type, channel). A replayed event, a
  // duplicated outbox row and a restarted worker all converge on the same key
  // and the second insert loses (S36, S137).
  //
  // The channel is on the DELIVERY table, so it cannot be part of this index.
  // With EMAIL as the only channel that costs nothing today; the day a second
  // channel exists this becomes (source, type) per channel and the constraint
  // moves. Recorded rather than silently assumed.
  //
  // What keeps legitimate repeats working (S138): the SOURCE carries the
  // generation. A second OTP is a new `ChallengeId`, a future reminder will be
  // a new occurrence id — both are new rows under this index, not collisions.
  await sql`
    create unique index notification_intents_logical_key
      on notification_intents (source_kind, source_id, notification_type)
  `.execute(db);

  // Support queries answering "why does this message exist" and the audience
  // lookups a support tool needs.
  await sql`
    create index notification_intents_audience_idx
      on notification_intents (audience_kind, audience_user_id,
                               audience_recipient_id, audience_invitation_id)
  `.execute(db);

  // ── Deliveries ─────────────────────────────────────────────────────────────
  await sql`
    create table notification_deliveries (
      notification_delivery_id varchar(64)  primary key,
      notification_intent_id   varchar(64)  not null,

      -- Denormalized from the intent so the reconciliation sweep and RLS can
      -- work on this table alone. A delivery is read far more often than an
      -- intent, and a join to answer "whose row is this" would put the tenant
      -- predicate one join away from the rows it protects.
      workspace_id             varchar(64),
      user_id                  varchar(64),

      channel                  varchar(16)  not null,

      -- ── The frozen destination ───────────────────────────────────────────
      --
      -- Snapshotted from the authoritative identity for the source operation,
      -- and never re-read at send time (S22, S28). A queued invitation
      -- addressed to alice@example.com must not follow an unrelated profile
      -- edit to changed@example.com hours later (S29) — that is an unrelated
      -- write redirecting a security-bearing message.
      --
      -- PII. Never logged (S26, S281), never a metric label (S282).
      destination              varchar(254) not null,

      state                    varchar(32)  not null,
      -- Bounded internal code. Never a provider's raw response (S165).
      failure_code             varchar(32),

      created_at               timestamptz  not null,

      constraint notification_deliveries_intent_fk
        foreign key (notification_intent_id)
        references notification_intents (notification_intent_id)
        -- RESTRICT, like every other evidence-adjacent record. A delivery
        -- without its intent is transport work nobody can explain.
        on delete restrict,

      constraint notification_deliveries_scope_check check (
        (workspace_id is not null and user_id is null)
        or (workspace_id is null and user_id is not null)
      ),
      constraint notification_deliveries_channel_check
        check (channel in (${inList(CHANNELS)})),
      constraint notification_deliveries_state_check
        check (state in (${inList(DELIVERY_STATES)})),
      constraint notification_deliveries_failure_code_check
        check (failure_code is null or failure_code in (${inList(FAILURE_CODES)})),
      constraint notification_deliveries_destination_present
        check (length(btrim(destination)) > 0),

      -- One EMAIL delivery per intent (S195). Two would mean one decision to
      -- communicate produced two messages, and a retry would not know which it
      -- was retrying.
      constraint notification_deliveries_intent_channel_key
        unique (notification_intent_id, channel)
    )
  `.execute(db);

  // How reconciliation finds work that lost its queue row (S131, S293).
  //
  // Partial, so the index stays the size of the backlog rather than the size of
  // history — the same shape migration 020 used for the same reason.
  await sql`
    create index notification_deliveries_pending_idx
      on notification_deliveries (created_at)
      where state = 'PENDING'
  `.execute(db);

  // ── Grants and RLS ─────────────────────────────────────────────────────────
  //
  // Intents take no UPDATE: they are immutable by construction (S55), and the
  // absence of the grant is what makes that true rather than merely intended.
  await sql`
    grant select, insert, delete on table notification_intents to lagda_app
  `.execute(db);
  await sql`
    grant select, insert, update, delete on table notification_deliveries to lagda_app
  `.execute(db);

  for (const table of ["notification_intents", "notification_deliveries"]) {
    await sql`alter table ${sql.ref(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.ref(table)} force row level security`.execute(db);

    // Two disjoint predicates, one per scope. A workspace session sees no
    // global rows and a user session sees no workspace rows — so a workspace
    // admin cannot read that one of their members requested a password reset,
    // which a single permissive `workspace_id is null or ...` policy would
    // have allowed (S273, S275).
    await sql`
      create policy tenant_isolation on ${sql.ref(table)}
      using (
        (workspace_id is not null and workspace_id = lagda_current_workspace())
        or (user_id is not null and user_id = lagda_current_user_id())
      )
      with check (
        (workspace_id is not null and workspace_id = lagda_current_workspace())
        or (user_id is not null and user_id = lagda_current_user_id())
      )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists notification_deliveries`.execute(db);
  await sql`drop table if exists notification_intents`.execute(db);
}
