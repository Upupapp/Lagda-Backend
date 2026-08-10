// 022 — the signing ceremony: recipient progress and consent acceptance.
//
// ── Two facts, deliberately separated ──────────────────────────────────────
//
// A recipient who reaches the ceremony produces two different kinds of fact,
// and collapsing them would make both less useful:
//
//   ENTERED    workflow state. The authenticated recipient asked for the
//              ceremony and was given it. Set once, never rewritten.
//   CONSENTED  a legal act. This recipient accepted THIS disclosure version
//              at THIS backend time. Append-only, versioned.
//
// Neither is signing, and neither is evidence that a human read anything.
// CEREMONY_VIEW_EVENT.md states exactly what each one means and does not.
//
// ── Why not on signing_request_recipients ──────────────────────────────────
//
// That table is the immutable snapshot of who was asked. Writing progress onto
// it would make the record of the ask mutable, and the whole point of
// BACKEND-32 was that a request stops depending on anything that can change.
//
// ── Why not on signing_request_recipient_activation ────────────────────────
//
// It exists and it is per-recipient and it already takes UPDATE, so it is the
// tempting place. But BACKEND-33 wrote at its declaration: "Routing activation.
// Two values, and neither is a ceremony state." Routing is about whose turn it
// is; entering is about what the recipient did. Two lifecycles, two tables.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No signature values, no field values, no signed/declined/completed state, no
// draft storage. BACKEND-36 owns submission and BACKEND-37 owns the recipient
// state machine. The product itself says in-progress input is "in-memory only;
// never stored or uploaded", so a draft table would have no writer.
//
// No legal text. Consent stores a type and a VERSION. The disclosure the
// frontend renders today closes with "provided for demonstration purposes
// only" — copying that into a row and calling it evidence would be worse than
// storing nothing, because it would look like a legal record.

import { type Kysely, sql } from "kysely";

/**
 * The recipient-session setting BACKEND-34 established.
 *
 * Referenced, not redefined. The restrictive policies below key off the same
 * function 021 created, because two definitions of "which recipient is asking"
 * is exactly one too many.
 */
const RECIPIENT_SESSION_DIGEST_FN = "lagda_current_recipient_session_digest()";

/**
 * Consent types the product actually has: one.
 *
 * `ConsentPage.tsx` presents one disclosure and one checkbox. Modelling four
 * types because other products have four would be inventing product, and §73's
 * warning against merging distinct consents into one boolean has an inverse
 * that applies here.
 */
const CONSENT_TYPES = ["electronic-records-and-signature"] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Recipient ceremony progress ─────────────────────────────────────────────
  //
  // The row's EXISTENCE is the fact. There is no `entered boolean` to get out
  // of step with a timestamp, and no null state meaning "maybe".
  //
  // `insert ... on conflict do nothing` makes repeated entry naturally
  // idempotent (§145, §192) without a read-then-write race.
  await sql`
    create table signing_recipient_progress (
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- Backend Clock. The first time an authenticated recipient session was
      -- granted the ceremony. NOT when an email was opened, a link was
      -- scanned, a token was exchanged, or a page was rendered.
      first_entered_at      timestamptz  not null,

      created_at            timestamptz  not null,

      -- The recipient IS the identity. A progress row has no life of its own,
      -- exactly as the activation row does not.
      constraint signing_recipient_progress_pk
        primary key (workspace_id, signing_request_id, request_recipient_id),

      -- THREE columns. Progress cannot be attached to a recipient of a
      -- different request even inside one tenant.
      constraint signing_recipient_progress_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  // ── Consent acceptance ──────────────────────────────────────────────────────
  //
  // Append-only and versioned. An acceptance is bound to the exact version
  // presented; changing the disclosure later cannot rewrite what was agreed to
  // (§135, §136).
  await sql`
    create table signing_recipient_consents (
      consent_id            varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      consent_type          varchar(64)  not null,
      -- An identifier, never the text. The operative wording lives in a
      -- versioned product/legal artifact; this row records WHICH one.
      consent_version       varchar(32)  not null,

      -- Backend Clock, always. A client-supplied acceptance time is a claim,
      -- not a fact, and this row is meant to be the fact.
      accepted_at           timestamptz  not null,

      -- Attribution only, and deliberately NOT a foreign key.
      --
      -- A consent record is legal evidence and must outlive operational rows.
      -- An FK to recipient_signing_sessions would let session lifecycle cascade
      -- into evidence, which is the wrong direction of dependency. Same reason
      -- evidence_events carries a plain recipient_id.
      signing_session_id    varchar(64)  not null,
      -- Denormalized from the session at acceptance time. What the recipient
      -- had actually proven when they agreed - which is a different question
      -- from what the session can prove today.
      authentication_method varchar(32)  not null,

      created_at            timestamptz  not null,

      constraint signing_recipient_consents_type_check
        check (consent_type in (${inList(CONSENT_TYPES)})),

      -- One acceptance per recipient per type per VERSION. Accepting twice
      -- converges instead of duplicating (§137, §138), and a NEW version is a
      -- new row rather than an edit to an old one (§136).
      constraint signing_recipient_consents_unique
        unique (workspace_id, signing_request_id, request_recipient_id,
                consent_type, consent_version),

      constraint signing_recipient_consents_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete cascade
    )
  `.execute(db);

  await sql`
    create index signing_recipient_consents_recipient_idx
      on signing_recipient_consents
         (workspace_id, signing_request_id, request_recipient_id)
  `.execute(db);

  // ── Grants ──────────────────────────────────────────────────────────────────
  //
  // SELECT and INSERT. No UPDATE and no DELETE on either table.
  //
  // This is a privilege-level guarantee, not a convention: the runtime role
  // cannot rewrite a first-entry time or amend an acceptance, because it has
  // no statement that could. BACKEND-37 grants UPDATE on progress when it adds
  // columns that legitimately change; consent should never need it.
  await sql`grant select, insert on table signing_recipient_progress to lagda_app`
    .execute(db);
  await sql`grant select, insert on table signing_recipient_consents to lagda_app`
    .execute(db);

  for (const table of ["signing_recipient_progress", "signing_recipient_consents"]) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);

    // Tenant isolation, as every workspace-scoped table has. The sender's
    // future "Viewed" display reads these rows through the workspace realm.
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }

  // ── The restrictive recipient scope ─────────────────────────────────────────
  //
  // RESTRICTIVE, and that word is the whole point.
  //
  // PostgreSQL ORs permissive policies together, so adding a narrow PERMISSIVE
  // policy beside `tenant_isolation` would WIDEN access, not narrow it: once a
  // recipient realm has entered a workspace, tenant isolation alone would let
  // it read every row of that tenant. A restrictive policy ANDs instead.
  //
  // The `is null` arm makes every one of these inert outside the recipient
  // realm — the workspace realm and the bootstrap-credential realm never set
  // this setting, so nothing they do changes.
  //
  // Inside the recipient realm they turn recipient scoping from a predicate
  // somebody has to remember into a fact the database enforces. That matters
  // most for `signing_request_fields`: field filtering is the control that
  // stops one signer seeing what another was asked for, and it should not rest
  // on a `where` clause surviving every future refactor.
  const scope = async (table: string, join: string) => {
    const predicate = `
      ${RECIPIENT_SESSION_DIGEST_FN} is null
      or exists (
        select 1 from recipient_signing_sessions s
        where s.token_digest = ${RECIPIENT_SESSION_DIGEST_FN}
          and ${join}
      )
    `;
    await sql`
      create policy recipient_ceremony_scope on ${sql.raw(table)}
      as restrictive
      using (${sql.raw(predicate)})
      with check (${sql.raw(predicate)})
    `.execute(db);
  };

  // Own progress, own consent: bound to the exact recipient the session names.
  for (const table of ["signing_recipient_progress", "signing_recipient_consents"]) {
    await scope(table, `
      s.workspace_id         = ${table}.workspace_id
      and s.signing_request_id   = ${table}.signing_request_id
      and s.request_recipient_id = ${table}.request_recipient_id`);
  }

  // Exactly one request. Not "requests in this workspace".
  await scope("signing_requests", `
    s.workspace_id       = signing_requests.workspace_id
    and s.signing_request_id = signing_requests.signing_request_id`);

  // The recipient's OWN row only — not the other participants of the same
  // request. This is what makes "other recipient PII is not exposed" (§44,
  // §45, §180) a database property rather than a promise about DTOs.
  await scope("signing_request_recipients", `
    s.workspace_id         = signing_request_recipients.workspace_id
    and s.signing_request_id   = signing_request_recipients.signing_request_id
    and s.request_recipient_id = signing_request_recipients.request_recipient_id`);

  // Only fields assigned to this recipient. `request_recipient_id` is NOT NULL
  // on every field, so there is no third category to reason about.
  await scope("signing_request_fields", `
    s.workspace_id         = signing_request_fields.workspace_id
    and s.signing_request_id   = signing_request_fields.signing_request_id
    and s.request_recipient_id = signing_request_fields.request_recipient_id`);

  // Exactly the artifact the request froze. A recipient realm cannot see the
  // document's other artifacts, its later versions, or anything else in the
  // tenant's library — the join IS the "no current-artifact lookup" rule (§104)
  // expressed where it cannot be bypassed.
  await scope("document_artifacts", `
    exists (
      select 1 from signing_requests r
      where r.workspace_id       = s.workspace_id
        and r.signing_request_id = s.signing_request_id
        and r.source_artifact_id = document_artifacts.artifact_id
        and r.workspace_id       = document_artifacts.workspace_id
    )`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The scope policies on PRE-EXISTING tables must come off explicitly.
  // Dropping the two new tables would leave four dangling policies behind on
  // tables this migration did not create.
  for (const table of [
    "signing_requests",
    "signing_request_recipients",
    "signing_request_fields",
    "document_artifacts",
  ]) {
    await sql`drop policy if exists recipient_ceremony_scope on ${sql.raw(table)}`
      .execute(db);
  }
  await db.schema.dropTable("signing_recipient_consents").ifExists().execute();
  await db.schema.dropTable("signing_recipient_progress").ifExists().execute();
}
