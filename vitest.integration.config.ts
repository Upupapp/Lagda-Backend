import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const PACKAGES = [
  "contracts", "core", "application", "db", "sealing", "storage", "api", "worker",
];

/**
 * Integration tests — REAL PostgreSQL required.
 *
 * Standalone rather than merged from `vitest.config.ts`. `mergeConfig`
 * concatenates the base `exclude`, which bans `*.integration.test.ts` — so the
 * merged config silently ran the unit suite and skipped every integration test
 * while reporting success. A separate config cannot inherit that exclusion.
 */
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      PACKAGES.map(name => [
        `@lagda/${name}`,
        path.resolve(here, `packages/${name}/src/index.ts`),
      ]),
    ),
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.integration.test.ts"],
    // Migrations and pooled connections are slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One database, shared schema, TRUNCATE between tests — parallel files
    // would race each other's truncation.
    fileParallelism: false,
    reporters: "default",
  },
});
