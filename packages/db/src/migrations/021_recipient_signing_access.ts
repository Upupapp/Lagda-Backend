// 021 — recipient signing access: a second authentication realm.
//
// ── The problem this solves ────────────────────────────────────────────────
//
// A recipient is not a LAGDA user. They have no account, no membership, no
// workspace context — and they must nonetheless reach exactly one document.
//
// Every existing read path starts from workspace context, which a recipient
// cannot establish. The credential has to establish it instead:
//
//   raw credential -> digest -> the ONE grant that matches -> its workspace
//
// ── The precedent, followed exactly ────────────────────────────────────────
//
// BACKEND-26 solved this shape for workspace invitations, and the argument
// transfers without modification: a `FOR SELECT` policy matching equality
// against a UNIQUE digest column, keyed off a transaction-local setting.
//
// Equality on a unique column matches at most ONE row. So the policy cannot
// enumerate, cannot scan a workspace, and cannot answer any question except
// "the grant whose credential I already hold". `FOR SELECT` means it cannot
// write anything either.
//
// No BYPASSRLS. No SUPERUSER. The runtime role gains one more way to see one
// more row it was already entitled to see.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No OTP challenge table. The implemented policy is LINK_ONLY - the product's
// own default - and a challenge table for a code nothing can generate, deliver
// or verify would be the "foundation without callers" this codebase has
// recorded before. SIGNING_ACCESS_PRODUCT_INVENTORY.md gives the three reasons.
//
// No `viewed_at`, no `consented_at`, no signature or field state. Authenticating
// is not viewing, viewing is not consenting, and neither is signing.

import { type Kysely, sql } from "kysely";

/**
 * The transaction-local setting a signing credential resolves through.
 *
 * A DIFFERENT setting from the invitation digest, deliberately. Two credential
 * realms sharing one setting would let an invitation transaction see a signing
 * grant, which is precisely the confusion per-purpose digest domains exist to
 * prevent one layer down.
 */
const DIGEST_SETTING = "lagda.signing_access_digest";

/**
 * The setting an established recipient SESSION resolves through.
 *
 * A third credential realm, and a third setting. A bootstrap credential and
 * a session credential must never resolve through the same door: the first
 * is in an email that may be forwarded, the second is an HttpOnly cookie.
 */
const SESSION_DIGEST_SETTING = "lagda.recipient_session_digest";

/**
 * How a recipient proved they may act.
 *
 * `link-only` is implemented and is the product's default. `email-otp` is
 * declared because the session must be able to SAY which method authenticated
 * it, and a column that could not express the second method would have to be
 * migrated the day it arrives - along with every row already written under the
 * first.
 *
 * Declaring it costs one CHECK value. It does NOT mean OTP works: nothing can
 * issue, deliver or verify a code today, and the CHECK is not what would make
 * it real.
 */
const AUTHENTICATION_METHODS = ["link-only", "email-otp"] as const;

/**
 * Why a recipient session ended.
 *
 * The same shape `user_sessions` uses. `superseded` is the multi-device case:
 * a second bootstrap does not currently revoke the first, but if the
 * one-active-session policy is ever chosen (OD-141) the reason already exists.
 */
const REVOCATION_REASONS = [
  "expired", "superseded", "request-terminal", "grant-revoked", "security-action",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The narrow credential read path ─────────────────────────────────────────
  //
  // `true` as the second argument so a MISSING setting yields NULL and the
  // policy matches nothing. Fail closed: a transaction that forgot to set the
  // digest sees zero grants rather than all of them.
  //
  // STABLE, not IMMUTABLE, because the value varies per transaction. A planner
  // that cached it across transactions would be the leak this exists to
  // prevent.
  await sql`
    create or replace function lagda_current_signing_access_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(DIGEST_SETTING)}, true), '') $$;
  `.execute(db);
  await sql`
    grant execute on function lagda_current_signing_access_digest() to lagda_app
  `.execute(db);

  await sql`
    create policy signing_access_credential_read on signing_access_grants
    for select
    using (credential_digest = lagda_current_signing_access_digest())
  `.execute(db);

  // The grant resolves the request, and the ceremony needs the request's own
  // row - its state, and the title a landing page shows. Same argument, one
  // join away: a grant the caller already resolved names exactly one request.
  await sql`
    create policy signing_access_request_read on signing_requests
    for select
    using (
      exists (
        select 1 from signing_access_grants grant_row
        where grant_row.credential_digest = lagda_current_signing_access_digest()
          and grant_row.signing_request_id = signing_requests.signing_request_id
          and grant_row.workspace_id = signing_requests.workspace_id
      )
    )
  `.execute(db);

  // And the ONE recipient the grant names. Not every recipient of the request:
  // a signer must not learn who else was asked, and the landing page needs
  // only its own name and masked address.
  await sql`
    create policy signing_access_recipient_read on signing_request_recipients
    for select
    using (
      exists (
        select 1 from signing_access_grants grant_row
        where grant_row.credential_digest = lagda_current_signing_access_digest()
          and grant_row.workspace_id = signing_request_recipients.workspace_id
          and grant_row.signing_request_id
                = signing_request_recipients.signing_request_id
          and grant_row.request_recipient_id
                = signing_request_recipients.request_recipient_id
      )
    )
  `.execute(db);

  // Routing eligibility. A waiting recipient must be refused even if a grant
  // somehow exists, so the credential path has to be able to read its own
  // activation row - and only its own.
  await sql`
    create policy signing_access_activation_read
    on signing_request_recipient_activation
    for select
    using (
      exists (
        select 1 from signing_access_grants grant_row
        where grant_row.credential_digest = lagda_current_signing_access_digest()
          and grant_row.workspace_id
                = signing_request_recipient_activation.workspace_id
          and grant_row.signing_request_id
                = signing_request_recipient_activation.signing_request_id
          and grant_row.request_recipient_id
                = signing_request_recipient_activation.request_recipient_id
      )
    )
  `.execute(db);

  // ── Recipient signing sessions ──────────────────────────────────────────────
  //
  // The shape of `user_sessions`, with three differences that matter:
  //
  //   it is REQUEST- and RECIPIENT-scoped, not user-scoped;
  //   it carries `workspace_id`, because a recipient's reads are tenant rows;
  //   it names the grant it came from, so revoking a grant can revoke what it
  //   produced.
  await sql`
    create table recipient_signing_sessions (
      signing_session_id    varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- Revocation lineage. If a grant is ever reissued or revoked, the
      -- sessions it produced can be revoked with it (S72, S73).
      source_grant_id       varchar(64)  not null,

      -- Digests, never raw. Two separate credentials: the session cookie and
      -- the CSRF token, exactly as user_sessions carries both.
      token_digest          varchar(64)  not null,
      csrf_token_digest     varchar(64)  not null,

      -- Which ceremony authenticated this session. Recorded on the session
      -- rather than derived, because a future request may hold sessions
      -- created under different policies.
      authentication_method varchar(32)  not null,
      -- Backend-authoritative. The moment the ceremony completed.
      authenticated_at      timestamptz  not null,

      created_at            timestamptz  not null,
      expires_at            timestamptz  not null,
      revoked_at            timestamptz,
      revocation_reason     varchar(32),

      constraint recipient_sessions_token_key unique (token_digest),
      constraint recipient_sessions_token_shape
        check (token_digest ~ '^[a-f0-9]{64}$'),
      constraint recipient_sessions_csrf_shape
        check (csrf_token_digest ~ '^[a-f0-9]{64}$'),
      -- The two credentials must differ. Equal digests would mean the CSRF
      -- token IS the session token, and a double-submit check that compares a
      -- value against itself protects nothing.
      constraint recipient_sessions_distinct_credentials
        check (token_digest <> csrf_token_digest),
      constraint recipient_sessions_expiry check (expires_at > created_at),
      constraint recipient_sessions_method_check
        check (authentication_method in (${inList(AUTHENTICATION_METHODS)})),
      constraint recipient_sessions_reason_check check (
        revocation_reason is null
        or revocation_reason in (${inList(REVOCATION_REASONS)})
      ),
      constraint recipient_sessions_revocation_pair
        check ((revoked_at is null) = (revocation_reason is null)),

      -- THREE columns. A session cannot be bound to a recipient of a different
      -- request, even in the same workspace - the check tenant isolation
      -- cannot make.
      constraint recipient_sessions_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade,

      constraint recipient_sessions_grant_fk
        foreign key (source_grant_id)
        references signing_access_grants (grant_id) on delete cascade
    )
  `.execute(db);

  // The lookup every authenticated recipient request makes.
  await sql`
    create index recipient_signing_sessions_recipient_idx
      on recipient_signing_sessions
         (workspace_id, signing_request_id, request_recipient_id)
  `.execute(db);

  // Revocation lineage: "revoke everything this grant produced" in one
  // statement, which is what BACKEND-46 and a future reissue both need.
  await sql`
    create index recipient_signing_sessions_grant_idx
      on recipient_signing_sessions (source_grant_id)
      where revoked_at is null
  `.execute(db);

  // ── Grants and RLS ──────────────────────────────────────────────────────────
  //
  // UPDATE for revocation. No DELETE: a session that ended is revoked, not
  // erased - the row is the record that someone authenticated, and BACKEND-43
  // may want it.
  await sql`
    grant select, insert, update on table recipient_signing_sessions to lagda_app
  `.execute(db);
  await sql`
    alter table recipient_signing_sessions enable row level security
  `.execute(db);
  await sql`
    alter table recipient_signing_sessions force row level security
  `.execute(db);

  // Tenant isolation, as every other workspace-scoped table has. A recipient
  // session belongs to a workspace even though its holder does not.
  await sql`
    create policy tenant_isolation on recipient_signing_sessions
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  // ── The session's own credential path ───────────────────────────────────────
  //
  // A recipient arriving with a session cookie has no workspace context either
  // - the SESSION is what resolves it. Same argument as the grant policy:
  // equality on a unique digest column, FOR SELECT, at most one row.
  await sql`
    create or replace function lagda_current_recipient_session_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(SESSION_DIGEST_SETTING)}, true), '') $$;
  `.execute(db);
  await sql`
    grant execute on function lagda_current_recipient_session_digest() to lagda_app
  `.execute(db);
  await sql`
    create policy recipient_session_credential_read on recipient_signing_sessions
    for select
    using (token_digest = lagda_current_recipient_session_digest())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("recipient_signing_sessions").ifExists().execute();
  for (const [policy, table] of [
    ["signing_access_credential_read", "signing_access_grants"],
    ["signing_access_request_read", "signing_requests"],
    ["signing_access_recipient_read", "signing_request_recipients"],
    ["signing_access_activation_read", "signing_request_recipient_activation"],
  ] as const) {
    await sql`drop policy if exists ${sql.ref(policy)} on ${sql.ref(table)}`.execute(db);
  }
  await sql`
    drop function if exists lagda_current_recipient_session_digest()
  `.execute(db);
  await sql`drop function if exists lagda_current_signing_access_digest()`.execute(db);
}
