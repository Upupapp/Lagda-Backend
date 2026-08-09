// 013 — workspace lifecycle: membership becomes the single authority.
//
// Four changes, and each closes a specific gap BACKEND-25 found:
//
//   1. `workspaces.owner_user_id` is DROPPED. It was a second authority on
//      ownership alongside the `owner` membership row.
//   2. `workspace_memberships.user_id` gains its foreign key to `users`. The
//      column has existed since 001; `users` only arrived in 008, so the
//      reference was never declared.
//   3. A transaction-local USER context, and SELECT-only policies that use it.
//      Without them, "list my workspaces" is unanswerable without BYPASSRLS.
//   4. The runtime role gains the grants those reads need.
//
// ── On dropping a column ─────────────────────────────────────────────────────
//
// `down` cannot restore the values, and does not pretend to. It re-adds the
// column as nullable, which is honest about what a reversal actually recovers:
// the shape, not the data. No LAGDA database holds production rows yet, so the
// loss is theoretical — but writing a `down` that implied otherwise would be the
// dangerous habit, not this migration.

import { type Kysely, sql } from "kysely";

/** Must match migration 002's tenant setting namespace. */
const USER_SETTING = "lagda.user_id";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1. One authority for ownership ─────────────────────────────────────────
  //
  // Ownership is a membership whose role is `owner`. Keeping a denormalized
  // copy on the workspace row means an ownership transfer has two rows to
  // update and no rule for what to do when only one succeeds — and BACKEND-27
  // is the command that will write that transfer.
  await db.schema.alterTable("workspaces").dropColumn("owner_user_id").execute();

  // ── 2. The missing reference ───────────────────────────────────────────────
  //
  // RESTRICT, matching the workspace reference and for the same reason: account
  // erasure semantics are unresolved (BACKEND-55), and a default CASCADE would
  // answer that question in the destructive direction — deleting a user row
  // would silently remove their memberships and, with them, the record of who
  // could reach a tenant. A workspace whose only owner vanished would become
  // permanently unreachable with no trace of why.
  //
  // This constraint is also what makes the creator's membership meaningful: a
  // membership pointing at a user that does not exist authorizes nobody, and
  // until now nothing prevented one.
  await db.schema
    .alterTable("workspace_memberships")
    .addForeignKeyConstraint(
      "fk_workspace_memberships_user", ["user_id"], "users", ["user_id"],
    )
    .onDelete("restrict")
    .execute();

  // Leads with `user_id`, which is the opposite of every other index on this
  // table — deliberately. The tenant-scoped queries need `(workspace_id, …)`;
  // "list my workspaces" needs to find one user's rows across ALL workspaces,
  // and a `(workspace_id, user_id)` index cannot serve that.
  await db.schema
    .createIndex("idx_workspace_memberships_user")
    .on("workspace_memberships")
    .columns(["user_id", "created_at desc"])
    .execute();

  // ── 3. User context and the user-scoped read path ──────────────────────────
  //
  // The mirror of `lagda_current_workspace()`. Same three properties, same
  // reasons: `true` so a missing setting yields NULL and the policy matches
  // nothing (fail closed), STABLE so the planner cannot cache it across
  // transactions, and NOT SECURITY DEFINER so it grants nothing by itself.
  await sql`
    create or replace function lagda_current_user_id() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(USER_SETTING)}, true), '') $$;
  `.execute(db);

  // A user may read their OWN membership rows, in any workspace.
  //
  // FOR SELECT, and that word is the entire safety argument. PostgreSQL
  // combines permissive policies with OR, so an unrestricted policy here would
  // widen every operation on the table. Restricted to SELECT, a transaction
  // holding user context and no workspace context can read these rows and can
  // perform no INSERT, UPDATE or DELETE against them at all — the write path
  // still requires tenant context, which this transaction does not have.
  await sql`
    create policy member_self_read on workspace_memberships
    for select
    using (user_id = lagda_current_user_id())
  `.execute(db);

  // A user may read a workspace they are a member of.
  //
  // The subquery is itself subject to RLS, and that is load-bearing rather than
  // incidental: under `member_self_read` the only membership rows it can see are
  // the current user's own. So this policy cannot be used to ask "does a
  // membership exist for someone else in workspace X" — the rows that would
  // answer are invisible to the query asking.
  //
  // Also FOR SELECT. A workspace INSERT still requires tenant context matching
  // the row, which is what makes creation work without any escape (§84), and an
  // UPDATE still requires it too — so a rename cannot be performed from a
  // user-scoped transaction.
  await sql`
    create policy member_workspace_read on workspaces
    for select
    using (exists (
      select 1
      from workspace_memberships m
      where m.workspace_id = workspaces.workspace_id
        and m.user_id = lagda_current_user_id()
    ))
  `.execute(db);

  // ── 4. Grants ──────────────────────────────────────────────────────────────
  //
  // The runtime role already holds DML on both workspace tables (002). It gains
  // nothing here except the ability to run the two accessor functions, which is
  // normally implicit — stated so a hardened deployment that revokes PUBLIC
  // EXECUTE does not silently break every tenant query.
  await sql`grant execute on function lagda_current_user_id() to lagda_app`.execute(db);
  await sql`grant execute on function lagda_current_workspace() to lagda_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists member_workspace_read on workspaces`.execute(db);
  await sql`drop policy if exists member_self_read on workspace_memberships`.execute(db);
  await sql`drop function if exists lagda_current_user_id()`.execute(db);

  await db.schema
    .dropIndex("idx_workspace_memberships_user")
    .on("workspace_memberships")
    .ifExists()
    .execute();

  await db.schema
    .alterTable("workspace_memberships")
    .dropConstraint("fk_workspace_memberships_user")
    .ifExists()
    .execute();

  // NULLABLE, unlike the original NOT NULL column. The values are gone; a
  // reversal that recreated the constraint would fail on the first existing row,
  // and one that invented an owner would be worse than failing.
  await db.schema
    .alterTable("workspaces")
    .addColumn("owner_user_id", "varchar(64)")
    .execute();
}
