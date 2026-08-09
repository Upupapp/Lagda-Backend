// 002 — workspace tenancy: runtime role and Row Level Security.
//
// RLS is DEFENCE IN DEPTH. Repository scoping stays mandatory (INV-003): a
// query relying on an invisible policy is one nobody can review by reading it.
// What RLS adds is protection against the query that FORGOT its scope — a bug
// application-level scoping cannot catch, because the forgetting happens there.
//
// Three pieces have to be right together, and any one missing makes the rest
// decorative:
//
//   1. A runtime role that does not own the tables and lacks BYPASSRLS.
//   2. FORCE ROW LEVEL SECURITY, so even the owner is subject to policies.
//   3. Transaction-local context via SET LOCAL — never session-level, which
//      would ride a pooled connection into the next request.

import { type Kysely, sql } from "kysely";

/**
 * The setting policies read. Namespaced so it cannot collide with a PostgreSQL
 * or extension setting.
 */
const SETTING = "lagda.workspace_id";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Runtime role ───────────────────────────────────────────────────────────
  //
  // Roles are cluster-level, so this is idempotent rather than a plain CREATE:
  // several databases in one cluster would otherwise fight over it. The role
  // has NO password here — deployment assigns credentials, and a password in a
  // migration would be a committed secret.
  //
  // Deliberately NOT the owner of these tables and deliberately without
  // BYPASSRLS. An owner bypasses RLS unless forced, and BYPASSRLS defeats the
  // whole mechanism.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'lagda_app') then
        create role lagda_app nologin;
      end if;
    end
    $$;
  `.execute(db);

  await sql`grant usage on schema public to lagda_app`.execute(db);
  await sql`
    grant select, insert, update, delete
    on table workspaces, workspace_memberships
    to lagda_app
  `.execute(db);

  // ── Tenant context accessor ────────────────────────────────────────────────
  //
  // Reads the transaction-local setting. `true` as the second argument makes a
  // missing setting return NULL rather than raising — the policy then matches
  // nothing, which is the fail-closed behaviour we want.
  //
  // STABLE, not IMMUTABLE: the value varies per transaction. Marking it
  // IMMUTABLE would let the planner cache it across transactions, which is
  // exactly the leak this design exists to prevent.
  //
  // Not SECURITY DEFINER: it needs no elevated privilege, and SECURITY DEFINER
  // on a function policies depend on would be a way around them.
  await sql`
    create or replace function lagda_current_workspace() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(SETTING)}, true), '') $$;
  `.execute(db);

  // ── Policies ───────────────────────────────────────────────────────────────
  for (const table of ["workspaces", "workspace_memberships"] as const) {
    const column = table === "workspaces" ? sql.ref("workspace_id") : sql.ref("workspace_id");

    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    // FORCE applies policies to the table OWNER too. Without it, anything
    // connecting as the owner — including a careless script — sees everything,
    // and the tests would pass while production leaked.
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);

    // USING governs what is visible; WITH CHECK governs what may be written.
    // A policy with only USING protects reads while leaving INSERT and UPDATE
    // unrestricted — half a control, and the more dangerous half missing.
    await sql`
      create policy tenant_isolation on ${sql.table(table)}
      using (${column} = lagda_current_workspace())
      with check (${column} = lagda_current_workspace())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["workspaces", "workspace_memberships"] as const) {
    await sql`drop policy if exists tenant_isolation on ${sql.table(table)}`.execute(db);
    await sql`alter table ${sql.table(table)} no force row level security`.execute(db);
    await sql`alter table ${sql.table(table)} disable row level security`.execute(db);
  }
  await sql`drop function if exists lagda_current_workspace()`.execute(db);
  // The role is intentionally NOT dropped: it is cluster-level and may be in
  // use by another database in the same cluster.
}
