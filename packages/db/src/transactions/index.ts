// PostgreSQL unit of work.
//
// Three responsibilities, and they are deliberately in one place:
//
//   1. `@lagda/application` never learns what a Kysely transaction is.
//   2. A tenant transaction establishes RLS context — and only here, because
//      `SET LOCAL` issued anywhere else reopens the pooling hazard.
//   3. Every repository in one operation is built on the SAME transaction, so
//      "atomic" means atomic rather than looking like it.

import { sql, type Kysely, type Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type {
  TransactionManager, WorkspaceUnitOfWork, GlobalUnitOfWork,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import {
  createScopedWorkspaceRepository, createScopedMembershipRepository,
} from "../repositories/workspaces.js";

/** The setting name RLS policies read. Must match migration 002. */
const WORKSPACE_SETTING = "lagda.workspace_id";

/**
 * Builds the repository set for one transaction and one workspace.
 *
 * Repositories are constructed here and nowhere else. If a caller could build
 * one independently it might hold the pool rather than this transaction, and
 * the resulting write would survive a rollback that was supposed to discard it.
 */
function buildUnitOfWork(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
): WorkspaceUnitOfWork {
  return {
    workspaceId,
    workspaces: createScopedWorkspaceRepository(trx, workspaceId),
    memberships: createScopedMembershipRepository(trx, workspaceId),
  };
}

export function createTransactionManager(db: Kysely<Database>): TransactionManager {
  return {
    async runForWorkspace<T>(
      workspaceId: WorkspaceId,
      operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // SET LOCAL, always — transaction-local, gone at COMMIT or ROLLBACK.
        // Session-level `SET` would ride a pooled connection into the next
        // request. Parameterized through `set_config` so a workspace ID can
        // never be concatenated into SQL, which `SET LOCAL x = '...'` cannot do.
        await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`.execute(trx);
        return operation(buildUnitOfWork(trx, workspaceId));
      });
    },

    async runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
      return db.transaction().execute(async () => {
        // No tenant context and no tenant repositories. Under RLS, workspace
        // tables are invisible from here — global mode is for user accounts and
        // system records, and if it strays into tenant data it fails closed
        // rather than seeing everything.
        return operation({ scope: "global" });
      });
    },
  };
}
