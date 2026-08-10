// 020 — send: the request becomes externally actionable.
//
// ── What SENT means ────────────────────────────────────────────────────────
//
// The sender committed the request for recipient delivery, and every piece of
// durable work required for initial recipient access was written in one
// transaction.
//
// It does NOT mean an email was delivered, opened, viewed, authenticated
// against or signed. Those are provider and ceremony facts, owned by
// BACKEND-45 and BACKEND-37, and none of them has a column here.
//
// ── Three tables, three different lifetimes ────────────────────────────────
//
//   signing_request_recipient_activation   routing state. WAITING or ACTIVE
//   signing_access_grants                  a bearer credential's DIGEST
//   signing_delivery_intents               the durable "send this" record,
//                                          carrying the SEALED raw credential
//
// The split matters. A recipient's routing position is workflow state that
// changes; a grant is a security credential with its own expiry and
// revocation; a delivery intent is operational work a provider will retry.
// Folding them into one row would give one lifecycle to three things.
//
// ── Why the raw credential is sealed rather than dropped ───────────────────
//
// Every other LAGDA credential is stored as a one-way digest, because the
// server only ever needs to COMPARE. A signing link is the exception for the
// same reason a TOTP seed is: an asynchronous renderer must RECOVER it minutes
// or hours later to build the email.
//
// OD-098 recorded this as the blocker on invitation delivery and named the
// resolution — encrypt it the way BACKEND-23 encrypts TOTP secrets. That is
// what `sealed_credential` is: AES-256-GCM through the existing `SecretBox`,
// with the key version stamped beside it so rotation needs no migration.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// No `viewed_at`, `authenticated_at`, `signed_at`, `declined_at`,
// `completed_at` on any table. No provider delivery status — `QUEUED`,
// `BOUNCED`, `DELIVERED` are BACKEND-45's and belong to a notification
// subsystem, not to a signing workflow. No `subject` or `message`: the product
// has no send screen to configure them.

import { type Kysely, sql } from "kysely";

/**
 * The states a signing request can now be in.
 *
 * Widened by exactly one value. `completed`, `declined`, `cancelled` and
 * `expired` are all still claims nothing can make true, so they stay out of
 * the CHECK until the command that earns them arrives.
 */
const REQUEST_STATES = ["draft", "sent"] as const;

/**
 * Routing activation. Two values, and neither is a ceremony state.
 *
 * `waiting`  a later routing cohort. Holds no credential (S47)
 * `active`   currently eligible for access
 *
 * BACKEND-37 adds `viewed`, `signed`, `declined` and the rest to its OWN
 * table. This one answers a single question: should this recipient currently
 * be able to reach the document?
 */
const ACTIVATION_STATES = ["waiting", "active"] as const;

/**
 * What a delivery intent is FOR.
 *
 * One value today. Declared as a constrained column rather than assumed,
 * because a completion copy and a reminder are both deliveries to the same
 * recipient with different meanings, and BACKEND-45/46 will need to tell them
 * apart.
 */
const DELIVERY_PURPOSES = ["signing-invitation"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The request gains a send moment ─────────────────────────────────────────
  await sql`
    alter table signing_requests
      drop constraint signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(REQUEST_STATES)}))
  `.execute(db);

  await sql`alter table signing_requests add column sent_at timestamptz`.execute(db);

  // The two must agree. A request that says `sent` with no timestamp, or
  // carries a timestamp while still `draft`, is a state nothing should be able
  // to write - so the database refuses it rather than trusting every future
  // transition to remember.
  await sql`
    alter table signing_requests
      add constraint signing_requests_sent_at_matches_state check (
        (state = 'draft' and sent_at is null)
        or (state = 'sent' and sent_at is not null)
      )
  `.execute(db);

  // ── Routing activation ──────────────────────────────────────────────────────
  await sql`
    create table signing_request_recipient_activation (
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      activation_state      varchar(32)  not null,
      -- NULL while waiting. Set once, when the recipient becomes eligible.
      activated_at          timestamptz,

      created_at            timestamptz  not null,

      -- One row per recipient. The recipient IS the key; there is no separate
      -- activation id, because an activation has no identity of its own.
      constraint signing_request_recipient_activation_pk
        primary key (workspace_id, signing_request_id, request_recipient_id),

      constraint signing_request_recipient_activation_state_check
        check (activation_state in (${inList(ACTIVATION_STATES)})),
      -- The same agreement rule as the request's.
      constraint signing_request_recipient_activation_at_matches_state check (
        (activation_state = 'waiting' and activated_at is null)
        or (activation_state = 'active' and activated_at is not null)
      ),

      constraint signing_request_recipient_activation_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  // ── Signing access grants ───────────────────────────────────────────────────
  //
  // A bearer credential's digest, bound to ONE recipient of ONE request.
  //
  // Note what it does not carry: no email (the recipient snapshot has it), no
  // session, no authentication state, no attempt counter. Possession of the
  // credential begins BACKEND-34's ceremony; it proves nothing by itself.
  await sql`
    create table signing_access_grants (
      grant_id              varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- SHA-256 of the raw credential, domain-separated. The raw value is
      -- never here, and an architecture guard asserts the column is a digest.
      credential_digest     varchar(64)  not null,

      created_at            timestamptz  not null,
      -- Explicit, always. A bearer credential that never expires is a
      -- permanent key to a legal document sitting in an inbox (S49). Request
      -- expiration is BACKEND-46's separate question.
      expires_at            timestamptz  not null,
      revoked_at            timestamptz,

      -- The lookup BACKEND-34 makes, and the reason the digest is unique
      -- rather than merely indexed: two grants sharing a digest would make
      -- "which recipient is this" ambiguous at exactly the wrong moment.
      constraint signing_access_grants_digest_key unique (credential_digest),
      constraint signing_access_grants_digest_shape
        check (credential_digest ~ '^[a-f0-9]{64}$'),
      constraint signing_access_grants_expiry_after_creation
        check (expires_at > created_at),

      -- THREE columns. A grant cannot reference a recipient of a different
      -- request, even in the same workspace - the check tenant isolation
      -- cannot make.
      constraint signing_access_grants_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  // ONE active grant per recipient, enforced rather than intended.
  //
  // A partial unique index, because the rule applies only to grants that are
  // still usable: a revoked or superseded grant may coexist with the live one,
  // and BACKEND-34 will need that when it implements reissue. Without this, an
  // idempotency edge or a future resend bug could leave two valid bearer
  // credentials for one person with no way to tell which was intended.
  await sql`
    create unique index signing_access_grants_one_active_idx
      on signing_access_grants (workspace_id, signing_request_id, request_recipient_id)
      where revoked_at is null
  `.execute(db);

  // ── Delivery intents ────────────────────────────────────────────────────────
  //
  // The durable "send this" record. It exists because Send must not call an
  // email provider inside a database transaction, and because a provider that
  // is down must not prevent a request from being sent.
  await sql`
    create table signing_delivery_intents (
      delivery_intent_id    varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,
      -- Which credential this delivery carries. A provider RETRY reuses this
      -- row and therefore this grant; it never mints a new one (S74).
      grant_id              varchar(64)  not null,

      purpose               varchar(32)  not null,

      -- ── The delivery snapshot ─────────────────────────────────────────────
      --
      -- Copied so a retry three hours later renders the same email. Reading
      -- the recipient row would also work today - it is immutable - but the
      -- workspace and sender names are NOT, and a retry that silently changed
      -- the sender's display name would be rendering a different message than
      -- the first attempt (S182).
      --
      -- PII. Follows notification data policy: never logged.
      recipient_email       varchar(254) not null,
      recipient_name        varchar(200) not null,
      document_title        varchar(300) not null,
      sender_display_name   varchar(200) not null,
      workspace_name        varchar(200) not null,

      -- ── The sealed credential ─────────────────────────────────────────────
      --
      -- AES-256-GCM through the established SecretBox, the mechanism OD-098
      -- named. The RAW TOKEN, not the full URL: the renderer builds the URL
      -- from configured canonical base, so a stored value can never carry a
      -- host somebody injected.
      --
      -- The key version is stored beside it so a key can be rotated without a
      -- migration and without guessing which key sealed which row.
      sealed_credential     text         not null,
      sealed_key_version    varchar(32)  not null,

      created_at            timestamptz  not null,
      -- Set by BACKEND-45 when a provider accepts it. NULL means outstanding,
      -- and the partial index below is how a dispatcher finds those.
      dispatched_at         timestamptz,

      constraint signing_delivery_intents_purpose_check
        check (purpose in (${inList(DELIVERY_PURPOSES)})),
      constraint signing_delivery_intents_email_present
        check (length(btrim(recipient_email)) > 0),

      -- ONE intent per grant. A grant is provisioned once per activation, so
      -- two intents for one grant would mean two invitations carrying the same
      -- credential from two different rows - and a retry would not know which
      -- it was retrying.
      constraint signing_delivery_intents_grant_key unique (grant_id),

      constraint signing_delivery_intents_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade,

      constraint signing_delivery_intents_grant_fk
        foreign key (grant_id)
        references signing_access_grants (grant_id)
        -- RESTRICT: a delivery intent without its grant is an email nobody can
        -- act on. Deleting the grant must go through the recipient cascade,
        -- which takes both.
        on delete restrict
    )
  `.execute(db);

  // How a dispatcher finds outstanding work. Partial, so the index stays the
  // size of the backlog rather than the size of history.
  await sql`
    create index signing_delivery_intents_pending_idx
      on signing_delivery_intents (created_at)
      where dispatched_at is null
  `.execute(db);

  // ── Grants and RLS ──────────────────────────────────────────────────────────
  //
  // Activation and grants take UPDATE because both evolve: a waiting recipient
  // activates later, and a grant is revoked. The delivery intent takes UPDATE
  // for `dispatched_at` alone.
  for (const table of [
    "signing_request_recipient_activation",
    "signing_access_grants",
    "signing_delivery_intents",
  ]) {
    await sql`
      grant select, insert, update, delete on table ${sql.ref(table)} to lagda_app
    `.execute(db);
    await sql`alter table ${sql.ref(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.ref(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.ref(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "signing_delivery_intents",
    "signing_access_grants",
    "signing_request_recipient_activation",
  ]) {
    await sql`drop policy if exists tenant_isolation on ${sql.ref(table)}`.execute(db);
    await db.schema.dropTable(table).ifExists().execute();
  }
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_sent_at_matches_state
  `.execute(db);
  await sql`alter table signing_requests drop column if exists sent_at`.execute(db);
  await sql`
    alter table signing_requests drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check check (state in ('draft'))
  `.execute(db);
}
