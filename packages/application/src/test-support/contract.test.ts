// The repository contract, run against the IN-MEMORY FAKE.
//
// The PostgreSQL run of the same suite lives in @lagda/db. Divergence between
// the two means either the fake is lying to application tests or the adapter is
// wrong — and this pair is how that surfaces.

import { describe, it, expect, beforeEach } from "vitest";
import { runRepositoryContract, type ContractTestApi } from "./repository-contract.js";
import { FakeTransactionManager, InMemoryStore } from "./fakes.js";

const api = { describe, it, beforeEach, expect } as unknown as ContractTestApi;

runRepositoryContract("in-memory fake", () => {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  return {
    transactions,
    reset: () => {
      store.workspaces.clear();
      store.memberships.length = 0;
      return Promise.resolve();
    },
  };
}, api);
