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
    // An ORDERED array, not a map. Vite applies string aliases by prefix, so a
    // bare `@lagda/application` entry rewrites `@lagda/application/test-support`
    // to `.../src/index.ts/test-support` and the import fails. The subpath rule
    // has to be tried first, which an object literal cannot guarantee.
    alias: [
      ...PACKAGES.map(name => ({
        find: `@lagda/${name}/`,
        replacement: `${path.resolve(here, `packages/${name}/src`)}/`,
      })),
      ...PACKAGES.map(name => ({
        find: `@lagda/${name}`,
        replacement: path.resolve(here, `packages/${name}/src/index.ts`),
      })),
    ],
  },
  test: {
    // Backend code runs on a server. jsdom would let a browser-only assumption
    // pass here and fail in production.
    environment: "node",
    // Integration tests are EXCLUDED here and run via vitest.integration.config.ts,
    // so `npm test` never needs a database.
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    // 20s, against Vitest's 5s default.
    //
    // Not because any test does 20 seconds of work. The FIRST `app.inject()` in
    // each API suite pays the cost of transforming the whole application graph
    // — `createApp` pulls in Fastify, the plugins, the error handler and every
    // route module — and on a cold run that reached 5 s and timed out. Adding a
    // fourth API suite in BACKEND-28 made it recur on roughly half of full
    // runs, always on whichever suite happened to compile first.
    //
    // A compile-bound limit disguised as a behavioural one produces failures
    // that point at an innocent test and change with machine load. The headroom
    // is deliberately large: nothing here should ever legitimately approach it,
    // so a test that does hit 20 s is genuinely hung and worth investigating.
    testTimeout: 20_000,
    reporters: "default",
  },
});
