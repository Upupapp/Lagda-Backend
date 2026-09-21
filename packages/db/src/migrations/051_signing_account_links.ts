// 051 — binding a signed-in account to a recipient of a signing request.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE RULE THIS TABLE MUST NOT OUTLIVE
// ══════════════════════════════════════════════════════════════════════════
//
//  `signing_account_links` is WRITE-ONLY FROM THE CEREMONY and READ-ONLY FOR
//  AUDIT. It must never become a join key for a list, an inbox, a dashboard or
//  a notification.
//
//  The reason is the whole security argument of the recipient realm. That
//  realm's isolation is not a convention; it is enforced five separate ways —
//  a separate cookie namespace, a separate CSRF derivation domain, a separate
//  RLS setting, a deliberately narrow unit of work, and a separate frontend
//  HTTP client whose header forbids the other one. Every one of those exists
//  because a signer with no account must not be reachable through the
//  workspace surface, and vice versa.
//
//  The moment a `user_id ↔ (workspace_id, signing_request_id, recipient_id)`
//  row exists, the cheapest next feature is "show me my pending documents in
//  the app" — and that is a workspace-realm read of recipient-realm rows,
//  which none of those five controls permits. It would be implemented by
//  widening `RecipientCeremonyUnitOfWork`, or by adding a workspace-scoped
//  repository that reads `signing_request_recipients` by email, and at that
//  point the isolation is gone and nobody notices, because this table made it
//  look intentional.
//
//  If "my pending documents" becomes a product goal, it gets its own feature
//  with its own authorization story. It does not arrive free as a consequence
//  of a table added for provenance.
//
// ── Two tables, because a handoff needs somewhere to wait ─────────────────
//
// Binding spans two credential realms, and no transaction scope carries both
// identities. A single request cannot even express it: there is exactly one
// CSRF header name, `X-CSRF-Token`, read by both realms, and a closed CORS
// allowlist. Proving possession of two CSRF secrets in one request is not
// representable without inventing a fourth realm.
//
// So it is two requests, joined by a short-lived code:
//
//   signing_link_intents   minted in the RECIPIENT realm; says "whoever
//                          presents this code within two minutes is claiming
//                          to be the account for this recipient's address".
//   signing_account_links  written in the WORKSPACE realm, once the account's
//                          own verified address has been compared with it.
//
// The same shape `runForInvitationCredential` and `runForSigningCredential`
// already use: resolve a digest-scoped credential, then act.
//
// ── Why the intent stores an email and not just ids ───────────────────────
//
// The comparison happens in the workspace realm, which must not read
// recipient-realm tables to find out who the recipient was. Carrying the
// address on the intent is what keeps the consuming side from needing a
// cross-realm read — the intent is the message, and it is complete.
//
// ── Digested, never stored raw ────────────────────────────────────────────
//
// Same reasoning as every other credential here: a stolen database backup must
// not yield usable codes. The raw value exists only in the response to the
// request that minted it and in the caller's memory.

import { sql, type Kysely } from "kysely";

// The TTL itself lives with the code that mints intents, not here — a
// migration is a record of a schema change, not a module other code imports.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table signing_link_intents (
      intent_digest               varchar(64)  primary key,

      workspace_id                varchar(64)  not null,
      signing_request_id          varchar(64)  not null,
      request_recipient_id        varchar(64)  not null,

      -- The address the invitation was DELIVERED to, snapshotted. Compared
      -- against users.normalized_email by the consuming side.
      --
      -- Note the deliberate reversal: preparation_recipients names its column
      -- normalized_recipient_email precisely so it can never be confused at a
      -- call site with users.normalized_email, which is an authentication
      -- identity. This table exists to make exactly that comparison, so the
      -- confusion is the feature. The compensating control is that the
      -- account's address must be VERIFIED, checked at bind time rather than
      -- trusted from registration.
      recipient_normalized_email  varchar(254) not null,

      -- WHICH ceremony session asked for this.
      --
      -- Carried so that whatever the claim produces can be bound back to the
      -- browser that started it. A signing link can be forwarded; without
      -- this, someone holding a forwarded link after a claim had happened
      -- would inherit whatever the claim handed over. The credential proves
      -- you may open the document, not that you are the person whose account
      -- was just verified.
      recipient_session_id        varchar(64)  not null,

      created_at                  timestamptz  not null,
      expires_at                  timestamptz  not null,
      consumed_at                 timestamptz,

      constraint signing_link_intents_digest_shape
        check (intent_digest ~ '^[a-f0-9]{64}$'),
      constraint signing_link_intents_email_normalized
        check (recipient_normalized_email = lower(recipient_normalized_email)),
      constraint signing_link_intents_expiry_after_creation
        check (expires_at > created_at)
    )
  `.execute(db);

  // Expired rows are swept, and the sweep wants a range scan.
  await sql`
    create index signing_link_intents_by_expiry
      on signing_link_intents (expires_at)
      where consumed_at is null
  `.execute(db);

  await sql`
    create table signing_account_links (
      signing_account_link_id   varchar(64)  primary key,

      user_id                   varchar(64)  not null
        references users (user_id) on delete cascade,

      workspace_id              varchar(64)  not null,
      signing_request_id        varchar(64)  not null,
      request_recipient_id      varchar(64)  not null,

      -- What was compared, recorded as it stood at bind time. If the account
      -- later changes its address, the audit still says which address the
      -- binding was justified by.
      matched_normalized_email  varchar(254) not null,

      linked_at                 timestamptz  not null,

      -- One account per recipient. A second account claiming the same
      -- recipient is not a race to resolve, it is a contradiction: the
      -- addresses are unique per account and the comparison is equality.
      constraint signing_account_links_one_per_recipient
        unique (signing_request_id, request_recipient_id),

      constraint signing_account_links_email_normalized
        check (matched_normalized_email = lower(matched_normalized_email))
    )
  `.execute(db);

  // The ONLY supported read: "is this recipient bound, and to whom".
  // Deliberately NOT indexed by user_id — an index by user is the index an
  // inbox would want, and this table is not for that (see the rule above).
  await sql`
    create index signing_account_links_by_recipient
      on signing_account_links (signing_request_id, request_recipient_id)
  `.execute(db);

  // Intents are consumed, so they need UPDATE. Links are a record of an act:
  // select and insert only, the same posture the evidence tables take.
  await sql`
    grant select, insert, update, delete on table signing_link_intents to lagda_app
  `.execute(db);
  await sql`
    grant select, insert on table signing_account_links to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists signing_account_links`.execute(db);
  await sql`drop table if exists signing_link_intents`.execute(db);
}
