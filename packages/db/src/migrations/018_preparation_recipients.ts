// 018 — preparation recipients, and the end of the participant slot.
//
// ── What a recipient is ────────────────────────────────────────────────────
//
// A SNAPSHOT of a signing participant, scoped to one preparation. Not a
// contact, not a user, not a workspace member, not an invitation. The name and
// email are copied at creation and never dereferenced again — which is the
// whole point, and the other half of the rule
// `docs/backend/contacts/CONTACT_RECIPIENT_BOUNDARY.md` stated.
//
// ── The column this migration retires ──────────────────────────────────────
//
// BACKEND-30 left `preparation_fields.participant_slot`: an opaque editor label
// with no foreign key, because there was nothing to point at. It is dropped
// here and replaced by a real `recipient_id` — the migration
// PREPARATION_RECIPIENT_HANDOFF.md asked for.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// No `access_token`, no `otp`, no `authenticated_at`, no `signed_at`, no
// `viewed_at`, no `email_sent_at`, no `delivery_status`, no `email_verified`.
// A recipient row says where an invitation is INTENDED to go. It proves nothing
// about who controls that mailbox, and BACKEND-34 owns that question.
//
// No `phone` either: `PrepParticipant` has none, and adding one for a future
// SMS OTP would be collecting personal data for a feature nobody has built.

import { type Kysely, sql } from "kysely";

/**
 * The six participant roles, from the product.
 *
 * Each has its own written description in `prepare.ts` — these are LAGDA's own
 * vocabulary rather than a copied one. BACKEND-31 stores the TYPE and enforces
 * exactly one rule from it (viewer and carbon-copy hold no fields); what an
 * approver's approval DOES is ceremony state and belongs to BACKEND-37.
 *
 * `witness` and `in-person signer` are absent because the product has neither.
 */
const RECIPIENT_TYPES = [
  "signer", "approver", "reviewer",
  "acknowledgment-recipient", "viewer", "carbon-copy",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table preparation_recipients (
      recipient_id      varchar(64)  primary key,
      workspace_id      varchar(64)  not null,
      preparation_id    varchar(64)  not null,

      -- PROVENANCE, never authority.
      --
      -- Records that this recipient started from an address-book entry. Nothing
      -- reads it to resolve a name or an email — those are snapshotted below.
      -- ON DELETE SET NULL: deleting a contact must never delete or invalidate
      -- a recipient, and a CASCADE here would do exactly that.
      source_contact_id varchar(64),

      -- ── The snapshot ──────────────────────────────────────────────────────
      --
      -- Copied at creation from a contact or typed by hand, and detached from
      -- both afterwards. A later contact edit does not reach these columns; a
      -- later recipient edit does not reach the contact.
      name              varchar(200) not null,
      -- The DELIVERY address, exactly as entered. This is where an invitation
      -- is intended to go, and it is not evidence that anyone controls it.
      email             varchar(254) not null,
      -- The folded comparison key, for the duplicate rule below. Named
      -- normalized_recipient_email so it can never be confused at a call site
      -- with users.normalized_email, which is an authentication identity.
      normalized_recipient_email varchar(254) not null,
      -- PrepParticipant.organization. Display only.
      organization      varchar(200),

      recipient_type    varchar(32)  not null,
      -- PrepParticipant.isRequired. DISTINCT from a field's required: this
      -- says whether the workflow waits for this participant at all.
      is_required       boolean      not null,

      -- Deterministic editor order. Separate from routing (§33).
      order_index       integer      not null,
      -- The routing step this recipient acts in. EQUAL VALUES MEAN PARALLEL
      -- within a step — stated because §38 requires the meaning of equal values
      -- to be defined rather than assumed.
      --
      -- The routing MODE, the groups and their completion rules are NOT here:
      -- they describe the transaction, not the participant, and the transaction
      -- arrives with BACKEND-32.
      routing_order     integer      not null,

      created_at        timestamptz  not null,
      updated_at        timestamptz  not null,

      -- The compound-key target for a field's assignment. All THREE columns,
      -- so a field can only name a recipient of its own preparation.
      constraint preparation_recipients_preparation_key
        unique (workspace_id, preparation_id, recipient_id),
      -- The two-column form, for anything that references a recipient without
      -- knowing its preparation.
      constraint preparation_recipients_workspace_key
        unique (workspace_id, recipient_id),

      -- ── The duplicate rule ────────────────────────────────────────────────
      --
      -- ONE recipient per address per preparation. Deliberately the OPPOSITE of
      -- the contact rule (§45): a shared inbox is legitimately several
      -- CONTACTS, but two recipients on one document sharing a mailbox means
      -- two invitations and two signing links arriving in one inbox with no way
      -- to tell them apart.
      --
      -- PREPARATION-LOCAL, never workspace-wide: the same person signs many
      -- documents. RECIPIENT_DUPLICATE_POLICY.md records the trade-off.
      constraint preparation_recipients_email_key
        unique (workspace_id, preparation_id, normalized_recipient_email),

      constraint preparation_recipients_name_present
        check (length(btrim(name)) > 0),
      constraint preparation_recipients_email_present
        check (length(btrim(email)) > 0),
      constraint preparation_recipients_email_normalized check (
        normalized_recipient_email = lower(normalized_recipient_email)
      ),
      constraint preparation_recipients_type_check
        check (recipient_type in (${inList(RECIPIENT_TYPES)})),
      constraint preparation_recipients_order_check check (order_index >= 0),
      -- 1-based, matching the product's stepNumber.
      constraint preparation_recipients_routing_check check (routing_order >= 1),

      constraint preparation_recipients_preparation_fk
        foreign key (workspace_id, preparation_id)
        references document_preparations (workspace_id, preparation_id)
        -- CASCADE, matching preparation_fields: a recipient is authoring
        -- state with no meaning outside its preparation, and a signing request
        -- will SNAPSHOT it rather than reference it.
        on delete cascade,

      constraint preparation_recipients_contact_fk
        foreign key (workspace_id, source_contact_id)
        references contacts (workspace_id, contact_id)
        -- The one SET NULL in this schema, and the reason is the whole command:
        -- a deleted contact must leave the recipient standing, with its snapshot
        -- intact and only its provenance forgotten.
        --
        -- (Contacts cannot currently be deleted at all — BACKEND-28 granted no
        -- DELETE. This says what happens if that ever changes, rather than
        -- leaving a RESTRICT that would block the erasure operation OD-110
        -- anticipates.)
        --
        -- ── The column list is LOAD-BEARING ─────────────────────────────────
        --
        -- A bare on delete set null on a COMPOSITE key nulls EVERY
        -- referencing column — here workspace_id as well as
        -- source_contact_id. workspace_id is NOT NULL, so deleting a
        -- contact would not forget the provenance: it would fail outright,
        -- and the recipient would be unreachable behind an error nobody could
        -- act on.
        --
        -- Naming the column (PostgreSQL 15+) sets only that one. The
        -- integration suite deletes a contact and asserts the recipient
        -- survives with its tenancy intact, which is how this was found.
        on delete set null (source_contact_id)
    )
  `.execute(db);

  await sql`
    create index preparation_recipients_order_idx
      on preparation_recipients (workspace_id, preparation_id, order_index, recipient_id)
  `.execute(db);

  // ── Field assignment ──────────────────────────────────────────────────────
  //
  // Replacing BACKEND-30's opaque slot with a real reference.
  await sql`
    alter table preparation_fields add column recipient_id varchar(64)
  `.execute(db);

  // THREE columns, and that is the point (§61, §62).
  //
  // `(workspace_id, recipient_id)` alone would let a field name a recipient of
  // a DIFFERENT preparation in the same workspace — RLS would not catch it,
  // because both rows are in the tenant. Including `preparation_id` makes
  // cross-preparation assignment a constraint violation.
  //
  // RESTRICT: deleting a recipient with assigned fields is refused, and the
  // application says so with a specific error rather than letting the database
  // produce an opaque one. Silently deleting the fields would destroy signing
  // requirements a sender placed deliberately (§58).
  await sql`
    alter table preparation_fields
      add constraint preparation_fields_recipient_fk
      foreign key (workspace_id, preparation_id, recipient_id)
      references preparation_recipients (workspace_id, preparation_id, recipient_id)
      on delete restrict
  `.execute(db);

  // The slot is gone. Dropped rather than left alongside, because two columns
  // answering "who signs this field" is exactly the drift this project has
  // avoided everywhere else (§60).
  //
  // No data migration: `participant_slot` held editor-local labels ("P1") that
  // referenced nothing, and no preparation has ever been saved through a
  // deployed API — the routes were composed in BACKEND-30 and the server
  // bootstrap still wires no workspace dependencies (OD-069).
  await sql`
    alter table preparation_fields drop column participant_slot
  `.execute(db);

  await sql`
    create index preparation_fields_recipient_idx
      on preparation_fields (workspace_id, preparation_id, recipient_id)
      where recipient_id is not null
  `.execute(db);

  // ── RLS ───────────────────────────────────────────────────────────────────
  await sql`
    grant select, insert, update, delete on table preparation_recipients to lagda_app
  `.execute(db);
  await sql`alter table preparation_recipients enable row level security`.execute(db);
  await sql`alter table preparation_recipients force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on preparation_recipients
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists preparation_fields_recipient_idx`.execute(db);
  await sql`
    alter table preparation_fields
      drop constraint if exists preparation_fields_recipient_fk
  `.execute(db);
  await sql`alter table preparation_fields drop column if exists recipient_id`.execute(db);
  await sql`
    alter table preparation_fields add column participant_slot varchar(64)
  `.execute(db);
  await sql`drop policy if exists tenant_isolation on preparation_recipients`.execute(db);
  await db.schema.dropTable("preparation_recipients").ifExists().execute();
}
