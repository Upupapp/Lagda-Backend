import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Workspace packages resolve to their SOURCE, not their build output.
 *
 * Without this, `npm test` would require `npm run build` first, and a stale
 * `dist/` would let tests pass against code that no longer exists. Aliasing to
 * `src` keeps the test run honest about what is currently written.
 */
const PACKAGES = [
  "contracts", "core", "application", "db", "sealing", "storage", "scanning", "api", "worker",
];

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
    // Backend code runs on a server. jsdom would let a browser-only assumption
    // pass here and fail in production.
    environment: "node",
    // Integration tests are EXCLUDED here and run via vitest.integration.config.ts,
    // so `npm test` never needs a database.
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    reporters: "default",
  },
});
