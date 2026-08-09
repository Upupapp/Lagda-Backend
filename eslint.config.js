// LAGDA backend lint configuration.
//
// This file is an architecture gate, not only a style checker. The package
// boundaries in docs/backend/architecture.md are enforced here as import
// restrictions, so `npm run lint` fails when a layer reaches for something it
// is not allowed to depend on.
//
// Why lint rather than documentation: the LAGDA frontend already shipped a
// contract that existed and was never consumed — `RouteMeta.status`, declared on
// 225 routes, read by no code, which drifted until three routes misreported
// themselves. A boundary nothing executes is a boundary that will move.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Package names that must never be imported outside `packages/sealing`.
 * Deliberately not exhaustive — extend it when a new PDF or signing library
 * appears rather than assuming this list is complete (INV-001).
 */
const PDF_PACKAGES = [
  "pdf-lib", "@pdf-lib/fontkit", "pdfkit", "jspdf", "pdfmake",
  "hummus", "hummus-recipe", "pdf-parse", "node-signpdf",
];
const PDF_PATTERNS = ["@signpdf/*", "pdf-lib/*", "pdfkit/*"];

/** Database access. Legitimate ONLY inside `packages/db`. */
const DB_PACKAGES = ["pg", "postgres", "pg-boss", "kysely"];
const DB_PATTERNS = ["kysely/*", "pg/*"];

/** Server, mail and object-storage infrastructure. Never a domain dependency. */
const INFRA_NON_PDF = [
  "fastify", "@fastify/cookie", "@fastify/csrf-protection", "@fastify/rate-limit",
  "pino", "pino-http",
  "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "aws-sdk", "minio",
  "nodemailer",
];

/** Frontend-only packages. `@lagda/contracts` is shared and must not pull these in. */
const FRONTEND_PACKAGES = ["react", "react-dom", "vite"];

/** LAGDA's own adapter packages — implementations of ports, never dependencies of them. */
const LAGDA_ADAPTERS = ["@lagda/db", "@lagda/storage", "@lagda/sealing"];
const LAGDA_ADAPTER_PATTERNS = ["@lagda/db/*", "@lagda/storage/*", "@lagda/sealing/*"];

/**
 * Builds ONE `no-restricted-imports` config from several groups, each keeping
 * its own message.
 *
 * A single merged message was the previous approach, and it told a developer
 * importing `pdf-lib` that "Database access belongs in @lagda/db". A rule whose
 * explanation is about the wrong subject gets worked around rather than obeyed.
 */
const restrictGroups = (groups) => [
  "error",
  {
    paths: groups.flatMap(({ names, message }) =>
      names.map(name => ({ name, message })),
    ),
    patterns: groups.flatMap(({ patterns = [], message }) =>
      patterns.map(group => ({ group: [group], message })),
    ),
  },
];

const SEALING_ONLY =
  "PDF and signing libraries may only be imported inside packages/sealing (INV-001). " +
  "The sealing package is the seam that lets certificate-backed signing move to a " +
  "dedicated service later; an import here would defeat it. " +
  "See docs/backend/ARCHITECTURE_INVARIANTS.md.";

const PERSISTENCE_ONLY =
  "Database access belongs in @lagda/db. Depend on a repository port owned by " +
  "@lagda/application and let the composition root inject the adapter (INV-046). " +
  "See docs/backend/db/DATABASE_CONVENTIONS.md.";

const NO_INFRA =
  "This package may not depend on concrete infrastructure. Depend on a port owned " +
  "by @lagda/application and let the composition root (api/worker) inject the " +
  "implementation (INV-005). See docs/backend/architecture.md.";

const ROUTES_NO_INFRA =
  "Route handlers receive capabilities; they do not construct or reach for them. " +
  "A route able to import @lagda/db can issue an unscoped query, bypassing the " +
  "unit of work and the tenant context it carries. Take the capability as a " +
  "parameter and let the composition root (api/src/app, api/src/server) wire it.";

const QUEUE_IS_THE_WORKERS =
  "The API must not reach the queue driver or the worker package (INV-190). An " +
  "API process that can call `boss.work` can start a consumer inside a web " +
  "process, and the two roles scale and restart for different reasons. When a " +
  "route needs to enqueue, take a JobScheduler port as a parameter — the adapter " +
  "moves to a shared package at that point (OD-046), it is not imported from here. " +
  "See docs/backend/worker/WORKER_ARCHITECTURE.md.";

const WORKER_SERVES_NO_HTTP =
  "The worker serves no HTTP and must not import a web framework or @lagda/api " +
  "(INV-190). Its liveness is proven by consuming jobs, not by answering a port. " +
  "See docs/backend/worker/WORKER_ARCHITECTURE.md.";

const CONTRACTS_PURE =
  "@lagda/contracts is consumed by both the frontend and the backend and must stay " +
  "free of infrastructure and framework dependencies (INV-007).";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*.d.ts"],
  },

  // ── Baseline for all backend TypeScript ────────────────────────────────────
  {
    files: ["packages/*/src/**/*.ts", "tests/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Listed explicitly rather than using `projectService`, because tests and
        // root config files sit outside the composite build graph on purpose.
        // `tsconfig.tools.json` is what brings them under type-aware linting;
        // without it every rule needing type information would silently not run
        // on them — the failure mode where a whole file's rules quietly vanish.
        project: ["./tsconfig.tools.json", "./packages/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` is how architectural type problems get papered over. Keep it loud.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A floating promise in a worker or a route silently drops the failure.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
    },
  },

  // ── Import boundaries, ONE block per package ───────────────────────────────
  //
  // Structured this way for a reason discovered by probe. `no-restricted-imports`
  // is LAST-WINS per file: when two blocks both match `packages/contracts/**`,
  // the second REPLACES the first rather than adding to it. The previous layout
  // had overlapping blocks, and the final one silently deleted the earlier bans —
  // `contracts` could import `react` and `vite`, and `application` could import
  // `@lagda/api` and `@lagda/worker`, with lint reporting nothing.
  //
  // So each package gets exactly one rule, built from groups that each carry
  // their OWN message. Merging the lists but keeping one message would have
  // produced the other half of that bug: importing `pdf-lib` inside sealing was
  // reported as "Database access belongs in @lagda/db".

  // contracts — consumed by the frontend AND the backend.
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        { names: DB_PACKAGES, patterns: DB_PATTERNS, message: PERSISTENCE_ONLY },
        {
          names: [...INFRA_NON_PDF, ...FRONTEND_PACKAGES, ...LAGDA_ADAPTERS],
          patterns: LAGDA_ADAPTER_PATTERNS,
          message: CONTRACTS_PURE,
        },
      ]),
    },
  },

  // core — pure domain logic, executable with no server and no database.
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        { names: DB_PACKAGES, patterns: DB_PATTERNS, message: PERSISTENCE_ONLY },
        {
          names: [...INFRA_NON_PDF, ...LAGDA_ADAPTERS],
          patterns: LAGDA_ADAPTER_PATTERNS,
          message: NO_INFRA,
        },
      ]),
    },
  },

  // application — owns the ports; depends on none of their implementations.
  //
  // LAGDA's own adapter packages are banned here too, which is easy to miss:
  // `@lagda/db` implements the ports application declares, so an import in the
  // other direction inverts the dependency the architecture is built on. Only
  // the composition roots — api and worker — may import both sides.
  {
    files: ["packages/application/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        { names: DB_PACKAGES, patterns: DB_PATTERNS, message: PERSISTENCE_ONLY },
        {
          names: [...INFRA_NON_PDF, ...LAGDA_ADAPTERS, "@lagda/api", "@lagda/worker"],
          patterns: [...LAGDA_ADAPTER_PATTERNS, "@lagda/api/*", "@lagda/worker/*"],
          message: NO_INFRA,
        },
      ]),
    },
  },

  // sealing — the ONE package permitted a PDF library.
  //
  // No PDF ban here, deliberately. Everything else still applies: sealing is an
  // adapter for one capability, not a second place to reach the database or
  // serve HTTP.
  {
    files: ["packages/sealing/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: DB_PACKAGES, patterns: DB_PATTERNS, message: PERSISTENCE_ONLY },
        {
          names: [...INFRA_NON_PDF, "@lagda/db", "@lagda/storage", "@lagda/api", "@lagda/worker"],
          patterns: ["@lagda/db/*", "@lagda/storage/*", "@lagda/api/*", "@lagda/worker/*"],
          message: NO_INFRA,
        },
      ]),
    },
  },

  // storage — object storage adapter. No PDF library: it moves bytes, it does
  // not interpret them.
  {
    files: ["packages/storage/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        { names: DB_PACKAGES, patterns: DB_PATTERNS, message: PERSISTENCE_ONLY },
        {
          names: ["@lagda/db", "@lagda/sealing", "@lagda/api", "@lagda/worker"],
          patterns: ["@lagda/db/*", "@lagda/sealing/*", "@lagda/api/*", "@lagda/worker/*"],
          message: NO_INFRA,
        },
      ]),
    },
  },

  // db — persistence adapter. `pg` and `kysely` belong here and nowhere else,
  // so this package is exempt from the persistence ban and no other.
  {
    files: ["packages/db/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        {
          names: ["@lagda/sealing", "@lagda/storage", "@lagda/api", "@lagda/worker"],
          patterns: ["@lagda/sealing/*", "@lagda/storage/*", "@lagda/api/*", "@lagda/worker/*"],
          message: NO_INFRA,
        },
      ]),
    },
  },

  // api and worker — the composition roots. They may import both sides, because
  // wiring is exactly their job. They still may not open a PDF themselves.
  //
  // They are TWO blocks, not one. A single block covering both was the earlier
  // shape, and it let the API import `pg-boss` and `@lagda/worker`: everything
  // needed to start a queue consumer inside a web process. The two roles scale,
  // restart and fail differently (INV-190), and a shared block cannot express a
  // ban that applies to one of them.
  {
    files: ["packages/api/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        {
          names: ["pg-boss", "@lagda/worker"],
          patterns: ["pg-boss/*", "@lagda/worker/*"],
          message: QUEUE_IS_THE_WORKERS,
        },
      ]),
    },
  },
  {
    files: ["packages/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        {
          names: ["fastify", "@fastify/cookie", "@fastify/csrf-protection", "@lagda/api"],
          patterns: ["@fastify/*", "@lagda/api/*"],
          message: WORKER_SERVES_NO_HTTP,
        },
      ]),
    },
  },

  // ── Route handlers are NOT the composition root ────────────────────────────
  //
  // The api package as a whole may import `@lagda/db` — that is what a
  // composition root does. But `api/src/routes/**` may not, and the distinction
  // is the entire point: a route that can reach the query builder is a route
  // that can issue an unscoped query, bypassing the unit of work and the tenant
  // context that comes with it.
  //
  // Directory-scoped, so `app/dependencies.ts` and `server/start-server.ts`
  // keep the access they legitimately need.
  {
    files: ["packages/api/src/routes/**/*.ts", "packages/api/src/plugins/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
        {
          names: [...DB_PACKAGES, "@lagda/db"],
          patterns: [...DB_PATTERNS, "@lagda/db/*"],
          message: ROUTES_NO_INFRA,
        },
        {
          // Fastify itself is excluded: a route module is a Fastify route
          // module. What it may not reach for is a DATA source — storage,
          // sealing, mail, object stores.
          names: [
            "@lagda/sealing", "@lagda/storage",
            "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "aws-sdk",
            "minio", "nodemailer",
          ],
          patterns: ["@lagda/sealing/*", "@lagda/storage/*"],
          message: ROUTES_NO_INFRA,
        },
      ]),
    },
  },

  // Cross-cutting tests. `packages/sealing` has its own tests that legitimately
  // open PDFs; those are covered by the sealing block above.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictGroups([
        { names: PDF_PACKAGES, patterns: PDF_PATTERNS, message: SEALING_ONLY },
      ]),
    },
  },

  // ── Tooling files ──────────────────────────────────────────────────────────
  {
    files: ["*.config.ts", "*.config.js"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
);
