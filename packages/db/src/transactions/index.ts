// PostgreSQL implementation of the application's TransactionManager port.
//
// The whole point of this file is that `@lagda/application` never learns what a
// Kysely transaction is. Application declares an opaque `TransactionContext`;
// this carries a real transaction inside one and unwraps it here.

import type { Kysely, Transaction } from "kysely";
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

export function createTransactionManager(db: Kysely<Database>): TransactionManager {
  return {
    async run<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T> {
      // Kysely commits when the callback resolves and rolls back when it
      // throws, releasing the pooled connection either way. That is what stops
      // repeated failures leaking connections until the pool is exhausted.
      return db.transaction().execute(async trx => {
        const context = { [HANDLE]: trx } as unknown as TransactionContext;
        return operation(context);
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
