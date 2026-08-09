// PostgreSQL implementation of the application's TransactionManager port.
//
// Two responsibilities. The first is that `@lagda/application` never learns what
// a Kysely transaction is. The second — added by BACKEND-07 — is that a tenant
// transaction establishes RLS context, and does so in exactly one place.
//
// THE POOLING HAZARD, and why this is the only file that touches tenant context:
// `SET` is session-level, so a connection carrying `lagda.workspace_id` back to
// the pool would hand it to the next request — a silent, intermittent,
// load-dependent cross-tenant read. `SET LOCAL` is scoped to the transaction and
// disappears on COMMIT or ROLLBACK. Setting it anywhere but here would reopen
// that hazard.

import { sql, type Kysely, type Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type { TransactionContext, TransactionManager } from "@lagda/application";
import type { Database } from "../schema/index.js";

/**
 * The real transaction, hidden behind the opaque context.
 *
 * A symbol key rather than a property name: it cannot be reached by an
 * application module that does not import this file, and it will not appear in
 * `Object.keys` or a JSON dump of the context.
 */
const HANDLE = Symbol("lagda.transaction");

interface CarriedContext {
  readonly [HANDLE]: Transaction<Database>;
}

/** The setting name RLS policies read. Must match migration 002. */
const WORKSPACE_SETTING = "lagda.workspace_id";

export function createTransactionManager(db: Kysely<Database>): TransactionManager {
  const wrap = (trx: Transaction<Database>): TransactionContext =>
    ({ [HANDLE]: trx } as unknown as TransactionContext);

  return {
    async runForWorkspace<T>(
      workspaceId: WorkspaceId,
      operation: (tx: TransactionContext) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // SET LOCAL, always. Parameterized through Kysely so a workspace ID can
        // never be concatenated into SQL — `set_config` takes the value as a
        // bind parameter, which `SET LOCAL x = '...'` cannot.
        //
        // `true` as the third argument makes it transaction-local, which is the
        // entire safety property.
        await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`.execute(trx);
        return operation(wrap(trx));
      });
    },

    async runGlobal<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return db.transaction().execute(async trx => {
        // No tenant context is set, so RLS policies match nothing and every
        // workspace-owned table is invisible. That is deliberate: a global
        // transaction is for user accounts and system records, and if it
        // accidentally touches tenant data it fails closed rather than seeing
        // everything.
        return operation(wrap(trx));
      });
    },
  };
}

/**
 * Unwraps the transaction inside a repository adapter.
 *
 * Repositories in this package call it; nothing outside can, because nothing
 * outside has the symbol.
 *
 * @throws if handed a context this manager did not create — which means a
 *         second transaction implementation is in play, and silently starting
 *         an independent transaction would break the atomicity the caller
 *         believes it has.
 */
export function unwrapTransaction(tx: TransactionContext): Transaction<Database> {
  const carried = tx as unknown as Partial<CarriedContext>;
  const handle = carried[HANDLE];
  if (handle === undefined) {
    throw new Error(
      "Transaction context was not created by the PostgreSQL transaction manager.",
    );
  }
  return handle;
}
