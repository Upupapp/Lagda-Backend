// Database row types.
//
// These describe PostgreSQL tables. They are NOT contracts and NOT domain
// entities: `WorkspaceRow` is deliberately different from `Workspace` and from
// `WorkspaceResponse`, and none of them may be substituted for another.
//
// Hand-maintained rather than generated. Generation from a live database makes
// the database the source of truth for types while migrations are the source of
// truth for schema — two sources that drift the moment someone forgets to
// regenerate. Here, a migration and its row type change in the same commit, and
// the integration tests fail if they disagree.
//
// snake_case throughout, matching PostgreSQL. Mapping to camelCase happens at
// the repository boundary, never by exposing these outward.

import type { ColumnType, Generated } from "kysely";

/**
 * A `timestamptz` column.
 *
 * Read as a `Date` and written as a `Date`, converted at the mapping boundary
 * to the domain's numeric `Instant`. The domain never sees a `Date` — it is
 * mutable, and handing one out lets a caller change an aggregate's timestamps.
 */
type Timestamptz = ColumnType<Date, Date, Date>;

export interface WorkspacesTable {
  /** Opaque branded identifier, e.g. `ws_...`. Not a sequential integer. */
  workspace_id: string;
  name: string;
  owner_user_id: string;
  created_at: Timestamptz;
}

export interface WorkspaceMembershipsTable {
  member_id: string;
  /** First-class tenant column. Every workspace-owned table carries it. */
  workspace_id: string;
  user_id: string;
  /** Constrained by CHECK to the canonical role vocabulary. */
  role: string;
  created_at: Timestamptz;
}

/**
 * Migration bookkeeping, owned by Kysely's migrator.
 *
 * Declared so the type-checker knows it exists; application code never reads it.
 */
export interface KyselyMigrationTable {
  name: string;
  timestamp: string;
}

/** The complete database. Kysely resolves table names from these keys. */
export interface Database {
  workspaces: WorkspacesTable;
  workspace_memberships: WorkspaceMembershipsTable;
  kysely_migration: KyselyMigrationTable;
}

/** Re-exported so the unused-import rule does not flag the Kysely helper. */
export type { Generated };
