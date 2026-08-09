// The repository contract, run against REAL PostgreSQL.
//
// The same specification runs against the in-memory fake in @lagda/application.
// Running both is the point: if they diverge, either the fake is lying to
// application tests or this adapter is wrong.
//
// The fake passing proves the application-visible semantics match. Only THIS
// run exercises RLS, constraints, SQLSTATE and real transactions — a fake is
// never security proof.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { runRepositoryContract, type ContractTestApi } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createTestDatabase, truncateAll, hasIntegrationDatabase } from "./testing/harness.js";

const api = { describe, it, beforeEach, expect } as unknown as ContractTestApi;

if (hasIntegrationDatabase()) {
  let database: LagdaDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  runRepositoryContract("PostgreSQL", () => ({
    transactions: createTransactionManager(database.db),
    reset: () => truncateAll(database),
  }), api);
}
