// 058 — reusable workflow templates.
//
// ── What a template is, and what it is NOT ─────────────────────────────────
//
// A template is a SHAPE a workspace reuses: named role slots ("Client Signer",
// "Approver"), the routing step each sits in, and the completion-notification
// defaults. It names ROLES, never people — that is the whole reason it is
// reusable, and it is why this table carries no email address, no contact
// reference and no recipient reference.
//
// It is NOT a signing request. A request created from a template is an
// ordinary signing request; nothing about it points back here (see "Snapshot,
// not reference" below).
//
// UPDATE (059): a template MAY now reference a document — see 059's header
// for why "holds no file" was revised and what changed. This table still
// stores no bytes and no new copy of anything; 059 adds a reference to an
// ordinary document uploaded through the ordinary path.
//
// ── Snapshot, not reference ───────────────────────────────────────────────
//
// Applying a template COPIES its slots into a preparation draft. There is
// deliberately no foreign key FROM a document, preparation or signing request
// INTO this table, and nothing downstream stores a template id as a live
// pointer. Editing a template next week must not silently re-route a document
// somebody already prepared from it, and the absence of the reference is what
// makes that impossible rather than merely unlikely.
//
// ── Why `role_slots` is JSONB and what that costs ────────────────────────
//
// The slots are an ordered list whose length varies per template, read and
// written only as a whole. A child table would buy per-slot constraints at the
// price of a join on every read and an ordering column to maintain, for data
// that is never queried by slot.
//
// The cost is real and stated: PostgreSQL cannot check the SHAPE inside the
// JSONB. So the application validates every slot on write AND again on apply
// (`validateRoleSlots`) — a row that somehow holds a malformed slot must fail
// loudly when applied, never produce a half-built routing configuration. The
// CHECK below enforces only what SQL can honestly enforce: that this is a
// JSON array, and a non-empty one.
//
// ── DELETE is granted here, unlike contacts ───────────────────────────────
//
// Migration 015 withholds DELETE on `contacts` because the product archives
// them and a contact is referenced by recipients as provenance. A template is
// workspace CONFIGURATION that nothing references (see above), so removing one
// destroys no record of anything that happened. The product asks for delete,
// and there is nothing here for it to orphan.

import { type Kysely, sql } from "kysely";

/** The routing vocabulary the frontend's `RoutingMode` already uses. */
const ROUTING_MODES = ["parallel", "sequential", "mixed", "approval-based"] as const;

function inList(values: readonly string[]) {
  return sql.join(values.map(value => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspace_workflow_templates")
    .addColumn("workflow_template_id", "varchar(64)", col => col.primaryKey())
    // First-class tenant column. Every workspace-owned table carries it.
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())

    .addColumn("name", "varchar(200)", col => col.notNull())

    // The named mode the admin chose. Stored rather than inferred: the real
    // signing request stores only a `routing_order` integer per recipient, and
    // "two people share step 1" cannot tell you whether the admin meant
    // parallel or approval-based. Losing that on reload is a real defect in
    // the draft path today (`participant-sync.ts` re-infers and can only ever
    // guess `sequential` or `mixed`), and a template must not inherit it.
    .addColumn("routing_mode", "varchar(32)", col => col.notNull())

    // An ordered array of slots. See the header for why JSONB, and for what
    // the application must therefore validate.
    .addColumn("role_slots", "jsonb", col => col.notNull())

    // The completion-notification defaults this template applies to a draft.
    // A JSON object of booleans today; an object rather than columns because
    // it is copied wholesale into the draft and never queried by field.
    .addColumn("completion_notification_settings", "jsonb", col => col.notNull())

    // WHO made it. No foreign key to `users`: a template outlives the account
    // that created it, exactly as a signing request outlives its sender
    // (migration 019's `created_by_user_id` takes the same position).
    .addColumn("created_by", "varchar(64)", col => col.notNull())

    .addColumn("created_at", "timestamptz", col => col.notNull())
    .addColumn("updated_at", "timestamptz", col => col.notNull())

    .addCheckConstraint(
      "workflow_templates_routing_mode_check",
      sql`routing_mode in (${inList(ROUTING_MODES)})`,
    )
    // A name that is only whitespace is not a name. Trimmed by the
    // application; this refuses the value it would have stored anyway.
    .addCheckConstraint(
      "workflow_templates_name_not_blank",
      sql`length(btrim(name)) > 0`,
    )
    // The two things SQL can honestly say about the slots: it is an array,
    // and a template with no slots routes nobody.
    .addCheckConstraint(
      "workflow_templates_slots_are_array",
      sql`jsonb_typeof(role_slots) = 'array' and jsonb_array_length(role_slots) > 0`,
    )
    .addCheckConstraint(
      "workflow_templates_settings_are_object",
      sql`jsonb_typeof(completion_notification_settings) = 'object'`,
    )
    .addCheckConstraint(
      "workflow_templates_updated_at_not_before_created",
      sql`updated_at >= created_at`,
    )
    .execute();

  // One template per NAME per workspace. Two templates called "HR Onboarding"
  // in one workspace is an admin picking the wrong one later; the product's
  // whole promise here is "set it up once".
  //
  // Case-insensitive, because "HR Onboarding" and "hr onboarding" are the same
  // mistake. Trimmed for the same reason the CHECK above trims.
  await sql`
    create unique index workflow_templates_unique_name_per_workspace
      on workspace_workflow_templates (workspace_id, lower(btrim(name)))
  `.execute(db);

  // The listing query: this workspace's templates, most recently changed
  // first. Leads with the tenant, like every other index in this schema,
  // because every query here is workspace-scoped first.
  await db.schema
    .createIndex("idx_workflow_templates_workspace_updated")
    .on("workspace_workflow_templates")
    .columns(["workspace_id", "updated_at desc"])
    .execute();

  // ── Row Level Security ────────────────────────────────────────────────────
  //
  // The ordinary tenant pattern. This is the load-bearing half of the
  // workspace isolation guarantee: not "the repository remembers to filter",
  // but "the database will not return or accept a row from another tenant,
  // whatever the query says". `force` so it binds the table owner too.
  await sql`
    grant select, insert, update, delete on table workspace_workflow_templates to lagda_app
  `.execute(db);

  await sql`alter table workspace_workflow_templates enable row level security`.execute(db);
  await sql`alter table workspace_workflow_templates force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workspace_workflow_templates
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on workspace_workflow_templates`.execute(db);
  await db.schema.dropTable("workspace_workflow_templates").ifExists().execute();
}
