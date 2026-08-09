// 001 — workspaces and memberships.
//
// The MINIMUM schema that makes the persistence foundation real: enough to
// implement BACKEND-05's two representative use cases and to prove transactions,
// tenant scoping, constraints and mapping against actual PostgreSQL.
//
// Deliberately absent: users, documents, signing requests, recipients,
// evidence, notifications, billing. Those belong to their own commands, and
// creating them here would freeze schema decisions before the domain questions
// behind them are answered — OD-013 in particular, which is unresolved and
// would otherwise dictate how signing state is stored.

import { Kysely, sql } from "kysely";

/** Canonical roles, from `WORKSPACE_ROLES` in @lagda/core. */
const ROLES = [
  "owner", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .addColumn("workspace_id", "varchar(64)", col => col.primaryKey())
    .addColumn("name", "varchar(200)", col => col.notNull())
    .addColumn("owner_user_id", "varchar(64)", col => col.notNull())
    // `timestamptz`, never `timestamp`. A naive column stores whatever the
    // server's timezone happened to be, and a host reconfiguration silently
    // reinterprets every historical row.
    .addColumn("created_at", "timestamptz", col => col.notNull())
    // Bounded, and checked. A workspace with a blank name is not a lifecycle
    // state, it is bad data, and the database is the last place that can say so.
    .addCheckConstraint("chk_workspaces_name_not_blank", sql`length(btrim(name)) > 0`)
    .execute();

  await db.schema
    .createTable("workspace_memberships")
    .addColumn("member_id", "varchar(64)", col => col.primaryKey())
    // First-class tenant column. Ownership is never left to be derived through
    // a chain of joins — repositories scope on it, indexes lead with it, and a
    // future RLS policy would read it.
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())
    .addColumn("user_id", "varchar(64)", col => col.notNull())
    .addColumn("role", "varchar(40)", col => col.notNull())
    .addColumn("created_at", "timestamptz", col => col.notNull())
    .addForeignKeyConstraint(
      "fk_workspace_memberships_workspace",
      ["workspace_id"],
      "workspaces",
      ["workspace_id"],
      // RESTRICT, not CASCADE, and this is deliberate. Deleting a workspace must
      // not silently erase who belonged to it: this is a legal-evidence system,
      // and deletion semantics are an unresolved product decision (BACKEND-55).
      // A default CASCADE would quietly answer that question in the destructive
      // direction.
      builder => builder.onDelete("restrict"),
    )
    .addCheckConstraint(
      "chk_workspace_memberships_role",
      sql`role in (${sql.join(ROLES.map(r => sql.lit(r)))})`,
    )
    .execute();

  // A user belongs to a workspace at most once. Application pre-checks improve
  // the error message; only this constraint survives two concurrent requests.
  await db.schema
    .createIndex("uq_workspace_memberships_workspace_user")
    .on("workspace_memberships")
    .columns(["workspace_id", "user_id"])
    .unique()
    .execute();

  // THE COMPOUND-KEY FOUNDATION.
  //
  // Redundant today — `member_id` is already the primary key — and present on
  // purpose. It is the target a compound foreign key needs:
  //
  //   FOREIGN KEY (workspace_id, member_id)
  //     REFERENCES workspace_memberships (workspace_id, member_id)
  //
  // A child table referencing only `member_id` would let a row in workspace A
  // point at a member of workspace B, with nothing but application code to stop
  // it. Adding this now means BACKEND-07 can add tenant-safe references without
  // a migration that rewrites this table.
  await db.schema
    .createIndex("uq_workspace_memberships_workspace_member")
    .on("workspace_memberships")
    .columns(["workspace_id", "member_id"])
    .unique()
    .execute();

  // Leads with `workspace_id` because every query is tenant-scoped first. An
  // index on `(created_at, workspace_id)` would be near-useless for the queries
  // this system actually runs.
  await db.schema
    .createIndex("idx_workspace_memberships_workspace_created_at")
    .on("workspace_memberships")
    .columns(["workspace_id", "created_at desc"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Safe to reverse only because these tables are new and hold no production
  // data. Most later migrations will NOT be safely reversible, and a `down`
  // must not be written to pretend otherwise.
  await db.schema.dropTable("workspace_memberships").ifExists().execute();
  await db.schema.dropTable("workspaces").ifExists().execute();
}
