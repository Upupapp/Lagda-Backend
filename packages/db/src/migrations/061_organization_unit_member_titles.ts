// 061 — a member of a unit may hold a TITLE within it.
//
// ── What this closes ────────────────────────────────────────────────────────
//
// 039's own header names the gap directly: "Department Administrator,
// Department Head -- referred to a thing with no representation." Units gave
// the product a container; nothing yet says WHO, right now, is the Department
// Head of a given department. Membership alone cannot answer that — several
// people can belong to a unit, and none of them need be its head.
//
// This migration adds exactly that one fact: a nullable `title` on
// `organization_unit_members`. It names the ROLE a member holds inside the
// unit ("Department Head", "Records Officer"), not an authorization level —
// 039's header rule still holds: a unit (and now a title inside one) grants
// nothing by itself.
//
// ── Why "at most one holder per title, per unit" is a DATABASE rule ────────
//
// A workflow template slot (060) will resolve "whoever currently holds
// Department Head in Records" to exactly one person — see the application
// layer's `resolveWorkflowRoleAssignments`. That resolution is only
// meaningful if the title is unambiguous at the moment it is read, so the
// uniqueness is enforced here, not merely hoped for by the application: two
// people can never simultaneously hold the same title in the same unit.
//
// Partial (title is not null), so a member with no title — the ordinary
// case, unchanged from 039 — takes no part in this constraint. Case- and
// whitespace-insensitive, the same normalization 039 already applies to a
// unit's own name, for the same reason: "Department Head" and "department
// head" are the same title typed twice.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_unit_members")
    .addColumn("title", "varchar(120)")
    .execute();

  await sql`
    alter table organization_unit_members
      add constraint organization_unit_members_title_not_blank
        check (title is null or length(btrim(title)) > 0)
  `.execute(db);

  await sql`
    create unique index organization_unit_members_title_idx
      on organization_unit_members (workspace_id, unit_id, lower(btrim(title)))
      where title is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists organization_unit_members_title_idx
  `.execute(db);
  await sql`
    alter table organization_unit_members
      drop constraint if exists organization_unit_members_title_not_blank
  `.execute(db);
  await db.schema
    .alterTable("organization_unit_members")
    .dropColumn("title")
    .execute();
}
