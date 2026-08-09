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

/** Concrete infrastructure. Adapters may import these; domain layers may not. */
const INFRA_PACKAGES = [
  "fastify", "@fastify/cookie", "@fastify/csrf-protection", "@fastify/rate-limit",
  "pg", "postgres", "pg-boss",
  "pino", "pino-http",
  "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "aws-sdk", "minio",
  "nodemailer",
  ...PDF_PACKAGES,
];

/** Builds a `no-restricted-imports` entry with a message that says why. */
const restrict = (names, message, patterns = []) => [
  "error",
  {
    paths: names.map(name => ({ name, message })),
    ...(patterns.length ? { patterns: patterns.map(group => ({ group: [group], message })) } : {}),
  },
];

const SEALING_ONLY =
  "PDF and signing libraries may only be imported inside packages/sealing (INV-001). " +
  "The sealing package is the seam that lets certificate-backed signing move to a " +
  "dedicated service later; an import here would defeat it. " +
  "See docs/backend/ARCHITECTURE_INVARIANTS.md.";

const NO_INFRA =
  "This package may not depend on concrete infrastructure. Depend on a port owned " +
  "by @lagda/application and let the composition root (api/worker) inject the " +
  "implementation (INV-005). See docs/backend/architecture.md.";

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

  // ── INV-001 · PDF libraries are confined to packages/sealing ───────────────
  // Applied to every package except sealing. No PDF dependency is installed yet,
  // so this passes trivially today; it exists to stop the first violation.
  {
    files: [
      "packages/contracts/**/*.ts", "packages/core/**/*.ts",
      "packages/application/**/*.ts", "packages/db/**/*.ts",
      "packages/storage/**/*.ts", "packages/api/**/*.ts",
      "packages/worker/**/*.ts", "tests/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": restrict(PDF_PACKAGES, SEALING_ONLY, PDF_PATTERNS),
    },
  },

  // ── INV-005 · core is pure domain logic ────────────────────────────────────
  // Core must be executable in tests without a server or a database.
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(INFRA_PACKAGES, NO_INFRA, PDF_PATTERNS),
    },
  },

  // ── INV-007 · contracts stays consumable by the frontend ───────────────────
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        [...INFRA_PACKAGES, "react", "react-dom", "vite"],
        CONTRACTS_PURE,
        PDF_PATTERNS,
      ),
    },
  },

  // ── Application depends on ports it owns, never on concrete infrastructure ─
  //
  // Two bans, for two different reasons.
  //
  // Third-party infrastructure (fastify, pg, pdf-lib …) would make a use case
  // untestable without that infrastructure present.
  //
  // LAGDA's OWN adapter packages are banned too, and that one is easy to miss:
  // `@lagda/db` implements the ports application declares, so an import in the
  // other direction inverts the dependency the architecture is built on and
  // creates a cycle. Only the composition roots — api and worker — may import
  // both sides, because wiring is exactly their job.
  {
    files: ["packages/application/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        [...INFRA_PACKAGES, "@lagda/db", "@lagda/storage", "@lagda/sealing", "@lagda/api", "@lagda/worker"],
        NO_INFRA,
        [...PDF_PATTERNS, "@lagda/db/*", "@lagda/storage/*", "@lagda/sealing/*"],
      ),
    },
  },

  // ── Tooling files ──────────────────────────────────────────────────────────
  {
    files: ["*.config.ts", "*.config.js"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
);
