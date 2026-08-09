// PostgreSQL connection and pool lifecycle.
//
// **Importing this module connects to nothing.** Connections are created only
// by calling `createDatabase`. A module that dials a database on import makes
// every unit test and every CLI invocation depend on a running server.

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "../schema/index.js";
import { type DatabaseConfig, describeDatabase } from "../config/index.js";

/**
 * `timestamptz` arrives as a string by default in some driver configurations,
 * and as a Date in others. Pinning the parser makes the boundary explicit
 * rather than environment-dependent — a lesson learned the expensive way on a
 * sibling product, where every timestamp silently became a string and
 * `new Date(x)` was needed at each call site.
 */
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, value => new Date(value));

export interface LagdaDatabase {
  /**
   * The query builder. Reachable from repository adapters and composition
   * roots only — application and core must never receive it (INV-046).
   */
  readonly db: Kysely<Database>;
  /** Cheap liveness probe for readiness checks. Fails fast. */
  ping(): Promise<boolean>;
  /** Releases every pooled connection. Required for clean shutdown. */
  close(): Promise<void>;
  /** Host and database only — never the credentials. */
  describe(): string;
}

export function createDatabase(config: DatabaseConfig): LagdaDatabase {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    min: config.poolMin,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    db,

    async ping(): Promise<boolean> {
      // `select 1` and nothing more. A readiness probe must not run a real
      // query, and must not report the server version — that is reconnaissance
      // for anyone who reaches the endpoint.
      try {
        await db.selectNoFrom(eb => eb.lit(1).as("ok")).execute();
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      // Destroys the Kysely instance and the underlying pool. Without this a
      // test process hangs on open handles.
      await db.destroy();
    },

    describe: () => describeDatabase(config),
  };
}
