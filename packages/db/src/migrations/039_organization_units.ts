// 039 — organization units: the layer between a workspace and its people.
//
// ── What the model could not say before this ───────────────────────────────
//
// A workspace had members and nothing between them. Every capability the
// platform is meant to grow needs the middle layer: a workflow stage assigned
// to a department, a document filed under an office, a report grouped by
// division. Two of the roles the product already names -- Department
// Administrator, Department Head -- referred to a thing with no representation.
//
// ── One table, seven labels ────────────────────────────────────────────────
//
// Department, office, division, branch, team, committee and project group are
// the same structural thing with different names: a container, inside a
// workspace, that holds people and nests. Seven tables would multiply every
// query, permission check and join by seven to express a purely nominal
// difference.
//
// ── The hierarchy is a self-FK, and the cycle rule is NOT in the database ──
//
// PostgreSQL cannot express "no cycles" as a constraint without a trigger that
// walks the tree on every write. The rule lives in `@lagda/core` where it is
// pure and testable, and the database enforces what it can express well: the
// parent exists, and it is in the same workspace.
//
// That compound FK is the important half. `(workspace_id, parent_unit_id)`
// referencing `(workspace_id, unit_id)` makes a cross-tenant parent
// unrepresentable rather than merely refused -- the same shape migration 032
// used for notification audiences.

import { type Kysely, sql } from "kysely";

const UNIT_KINDS = [
  "department", "office", "division", "branch", "team", "committee",
  "project_group",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table organization_units (
      unit_id        varchar(64)  primary key,
      workspace_id   varchar(64)  not null,

      -- NULL means a root. A workspace may have several: an LGU has departments
      -- side by side, and forcing a single synthetic root would invent a node
      -- nobody asked for and put it in every breadcrumb.
      parent_unit_id varchar(64),

      kind           varchar(32)  not null,
      name           varchar(120) not null,

      created_at     timestamptz  not null,
      -- Archived, never deleted. A unit is referenced by documents, workflow
      -- assignments and audit records; removing the row would strand all three,
      -- and "this department was dissolved in 2024" is information rather than
      -- an absence.
      archived_at    timestamptz,

      constraint organization_units_kind_check
        check (kind in (${inList(UNIT_KINDS)})),
      constraint organization_units_name_present
        check (length(btrim(name)) > 0),
      -- A unit cannot be its own parent. The cheap half of the cycle rule, and
      -- the only half a CHECK can see.
      constraint organization_units_not_self_parent
        check (parent_unit_id is null or parent_unit_id <> unit_id),

      -- The target of the compound FK below.
      constraint organization_units_tenant_identity
        unique (workspace_id, unit_id),

      constraint organization_units_workspace_fk
        foreign key (workspace_id) references workspaces (workspace_id)
        on delete restrict
    )
  `.execute(db);

  // The compound self-reference. A parent in another workspace is not refused
  // at runtime -- it cannot be written.
  await sql`
    alter table organization_units
      add constraint organization_units_parent_fk
        foreign key (workspace_id, parent_unit_id)
        references organization_units (workspace_id, unit_id)
        -- RESTRICT: dissolving a parent must be a deliberate reparenting of its
        -- children, not a silent cascade that empties an org chart.
        on delete restrict
  `.execute(db);

  // Two names may repeat across a workspace -- "Records" can exist under two
  // departments -- but not under one parent, where it would be ambiguous to a
  // human choosing from a list. Partial on the root case, since NULL parents do
  // not compare equal.
  await sql`
    create unique index organization_units_sibling_name_idx
      on organization_units (workspace_id, parent_unit_id, lower(name))
      where parent_unit_id is not null and archived_at is null
  `.execute(db);
  await sql`
    create unique index organization_units_root_name_idx
      on organization_units (workspace_id, lower(name))
      where parent_unit_id is null and archived_at is null
  `.execute(db);

  await sql`
    create index organization_units_tree_idx
      on organization_units (workspace_id, parent_unit_id)
      where archived_at is null
  `.execute(db);

  // ── Membership ─────────────────────────────────────────────────────────────
  //
  // A person may belong to several units: a records officer sits in Records and
  // on the Bids Committee. So this is its own table rather than a column on
  // membership, and the identity is the PAIR.
  await sql`
    create table organization_unit_members (
      unit_id      varchar(64) not null,
      workspace_id varchar(64) not null,
      user_id      varchar(64) not null,
      created_at   timestamptz not null,

      primary key (unit_id, user_id),

      -- Compound again, so a membership cannot point at a unit in another
      -- workspace even if somebody supplies a valid-looking unit id.
      constraint organization_unit_members_unit_fk
        foreign key (workspace_id, unit_id)
        references organization_units (workspace_id, unit_id)
        on delete cascade,

      -- The person must be a member of the WORKSPACE first. Unit membership is
      -- a subdivision of workspace membership, never a way into one.
      constraint organization_unit_members_workspace_membership_fk
        foreign key (workspace_id, user_id)
        references workspace_memberships (workspace_id, user_id)
        on delete cascade
    )
  `.execute(db);

  await sql`
    create index organization_unit_members_user_idx
      on organization_unit_members (workspace_id, user_id)
  `.execute(db);

  // ── Tenancy ────────────────────────────────────────────────────────────────
  for (const table of ["organization_units", "organization_unit_members"] as const) {
    await sql`grant select, insert, update, delete on table ${sql.ref(table)} to lagda_app`
      .execute(db);
    await sql`alter table ${sql.ref(table)} enable row level security`.execute(db);
    // FORCE, so the policy applies to the table owner too. Without it a
    // careless script connecting as the owner sees every tenant.
    await sql`alter table ${sql.ref(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.ref(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists organization_unit_members`.execute(db);
  await sql`drop table if exists organization_units`.execute(db);
}
