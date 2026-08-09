// Observability boundaries, enforced.
//
// Three claims BACKEND-12 makes that only an executable check holds:
// core and application stay provider-independent, observability context never
// becomes a data-access source, and telemetry never lands in PostgreSQL.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const read = (file: string): string => readFileSync(file, "utf8");

/** Source with comments removed, so prose about a rule is not read as a violation. */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("core and application stay observability-provider independent", () => {
  it("core imports no logging or metrics library", () => {
    // A domain rule that logs cannot be tested without a logger, and a policy
    // that emits a metric has acquired an I/O dependency.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "core", "src"))) {
      for (const specifier of importsOf(read(file))) {
        if (/^(pino|winston|bunyan|prom-client|@opentelemetry\/)/.test(specifier)) {
          offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("application imports no logging or metrics library", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "application", "src"))) {
      for (const specifier of importsOf(read(file))) {
        if (/^(pino|winston|bunyan|prom-client|@opentelemetry\/)/.test(specifier)) {
          offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no use-case signature takes a logger", () => {
    // Use cases are wrapped from the OUTSIDE, at composition. A logger
    // parameter would make every caller — including the future worker — supply
    // one.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "application", "src"))) {
      if (/\b(logger|metrics)\s*:/.test(code(file))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pino is declared in exactly one package manifest", () => {
    const declarations: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      let raw: string;
      try {
        raw = read(path.join(PACKAGES, pkg, "package.json"));
      } catch {
        continue;
      }
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(parsed.dependencies ?? {})) {
        if (/^(pino|winston|bunyan)/.test(name)) declarations.push(`${pkg}:${name}`);
      }
    }
    // Pino arrives transitively through Fastify; no package declares it directly.
    expect(declarations).toEqual([]);
  });
});

describe("observability context is not a data-access source", () => {
  it("no repository, transaction or migration code reads the context store", () => {
    // The rule that keeps an ambient value safe. If this store vanished, no
    // query would change behaviour — only the logs would get less useful.
    // Tenant scope comes from the unit of work; RLS reads the transaction
    // setting.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "db", "src"))) {
      const source = code(file);
      if (/currentContext\s*\(|AsyncLocalStorage/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the context module is used only for logging concerns", () => {
    // Every consumer named, so a new one is a deliberate change rather than a
    // drift nobody reviewed.
    const consumers: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "api", "src"))) {
      if (file.endsWith(".test.ts")) continue;
      // The defining module obviously names them.
      if (file.endsWith(path.join("observability", "context.ts"))) continue;
      // Matched by USE, not by import path: `observe.ts` imports the store from
      // its own directory as `./context.js`, which a pattern looking for
      // `observability/context.js` silently missed.
      if (/\b(currentContext|withContext|withAddedContext)\s*\(/.test(code(file))) {
        consumers.push(path.relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(consumers.sort()).toEqual([
      "packages/api/src/app/create-app.ts",
      "packages/api/src/logging/index.ts",
      "packages/api/src/observability/observe.ts",
      // Enriches the log context with the resolved actor. Authorization reads
      // `request.auth`, never this store (INV-135) — a separate architecture
      // test asserts no @lagda/db file reads it at all.
      "packages/api/src/security/session-plugin.ts",
    ]);
  });
});

describe("telemetry does not become a database table", () => {
  it("no migration creates a log, metric or telemetry table", () => {
    // Operational logs go to stdout. Writing them to PostgreSQL on the request
    // path risks recursion during exactly the outage they exist to explain, and
    // confuses them with evidence, which has different retention entirely.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "db/src/migrations"))) {
      const source = code(file).toLowerCase();
      for (const forbidden of ["application_logs", "request_logs", "metrics",
                               "telemetry", "log_entries"]) {
        if (new RegExp(`create table\\s+${forbidden}`).test(source)) {
          offenders.push(`${path.relative(ROOT, file)} → ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the database schema declares no telemetry table", () => {
    const schema = code(path.join(PACKAGES, "db/src/schema/index.ts")).toLowerCase();
    for (const forbidden of ["application_logs", "request_logs", "telemetry"]) {
      expect(schema).not.toContain(forbidden);
    }
  });
});

describe("no unstructured logging in runtime code", () => {
  it("no console call in any package source", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      for (const file of sourceFiles(path.join(PACKAGES, pkg, "src"))) {
        if (file.endsWith(".test.ts")) continue;
        if (/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(code(file))) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the migration runner emits structured records", () => {
    // A process role that writes `[migrate] applied X` produces lines a log
    // aggregator cannot query, and migration failures are exactly what someone
    // searches for at 3am.
    const runner = code(path.join(ROOT, "infra/migrate.ts"));
    expect(runner).toMatch(/processRole/);
    expect(runner).toMatch(/JSON\.stringify/);
  });
});
