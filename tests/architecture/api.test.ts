// The API boundary, enforced.
//
// Two claims BACKEND-11 makes that only an executable check can hold:
// HTTP stays inside `@lagda/api`, and importing that package starts nothing.

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

/** Includes the bare `import "x"` form — the one with no `from`. */
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

const HTTP_FRAMEWORKS = /^(fastify|@fastify\/|express|koa|@nestjs\/|@hapi\/)/;

describe("HTTP stays in the API adapter", () => {
  it("no other package imports an HTTP framework", () => {
    // The whole point of the layering: a use case that imports Fastify cannot
    // be called by the worker, and a domain rule that knows about a Reply
    // cannot be tested without one.
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      if (pkg === "api") continue;
      for (const file of sourceFiles(path.join(PACKAGES, pkg, "src"))) {
        for (const specifier of importsOf(read(file))) {
          if (HTTP_FRAMEWORKS.test(specifier)) {
            offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the api package DOES import fastify — the negative control", () => {
    const found = sourceFiles(path.join(PACKAGES, "api", "src")).some(file =>
      importsOf(read(file)).some(s => HTTP_FRAMEWORKS.test(s)),
    );
    expect(found).toBe(true);
  });

  it("declares an HTTP framework in exactly one manifest", () => {
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
        if (HTTP_FRAMEWORKS.test(name)) declarations.push(pkg);
      }
    }
    expect([...new Set(declarations)]).toEqual(["api"]);
  });

  it("installs no HTTP framework other than Fastify", () => {
    const root = JSON.parse(read(path.join(ROOT, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const api = JSON.parse(read(path.join(PACKAGES, "api", "package.json"))) as {
      dependencies?: Record<string, string>;
    };
    const all = Object.keys({
      ...root.dependencies, ...root.devDependencies, ...api.dependencies,
    });
    for (const banned of ["express", "koa", "@nestjs/core", "@hapi/hapi", "supertest",
                          "inversify", "tsyringe", "jsonwebtoken", "passport"]) {
      expect(all).not.toContain(banned);
    }
  });
});

describe("the package starts nothing on import", () => {
  const entry = read(path.join(PACKAGES, "api/src/index.ts"));

  it("the entry point contains no executable statement", () => {
    // A top-level `startServer()` would bind a port in every test run that
    // imported the package, and in any tool that merely typechecks it.
    //
    // Checked by looking for a CALL at statement position rather than by
    // classifying every line: a line-shape heuristic breaks on multi-line export
    // blocks, and the natural fix is to loosen it until it stops testing
    // anything. The first attempt here did exactly that.
    const code = entry
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const calls = code.match(/^\s*[A-Za-z_$][\w$.]*\s*\(/gm) ?? [];
    expect(calls).toEqual([]);
  });

  it("never calls listen outside the server entry", () => {
    const offenders = sourceFiles(path.join(PACKAGES, "api", "src"))
      .filter(f => !f.endsWith("start-server.ts") && !f.endsWith(".test.ts"))
      .filter(file => /\.listen\s*\(/.test(read(file)));
    expect(offenders.map(f => path.relative(ROOT, f))).toEqual([]);
  });

  it("reads process.env only in the config loader and the process entry", () => {
    // A route or plugin reading the environment behaves differently in tests
    // than in production for reasons invisible at the call site.
    const readers = sourceFiles(path.join(PACKAGES, "api", "src"))
      .filter(f => !f.endsWith(".test.ts"))
      .filter(file => /process\.env/.test(
        read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      ))
      .map(f => path.relative(ROOT, f).replace(/\\/g, "/"));

    expect(readers).toEqual(["packages/api/src/config/index.ts"]);
  });

  it("uses no console logging", () => {
    const offenders = sourceFiles(path.join(PACKAGES, "api", "src"))
      .filter(f => !f.endsWith(".test.ts"))
      .filter(file => /\bconsole\.(log|error|warn|info|debug)\s*\(/.test(read(file)))
      .map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("never applies migrations at startup", () => {
    // BACKEND-06 made migration an explicit deployment step. An API that
    // migrates on boot means every replica races to alter the schema during a
    // rolling deploy.
    const offenders = sourceFiles(path.join(PACKAGES, "api", "src"))
      .filter(f => !f.endsWith(".test.ts"))
      .filter(file => /\b(migrateToLatest|runMigrations|migrator|Migrator)\b/.test(read(file)))
      .map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("leaves no unresolved markers on the foundation path", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "api", "src"))) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(read(file))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every production route declares schemas", () => {
  it("each registered route has a response schema", () => {
    // Response schemas are a security boundary here, not documentation: Fastify
    // serializes through them, so an undeclared field cannot escape. A route
    // without one returns whatever the handler happened to build.
    const routeFiles = sourceFiles(path.join(PACKAGES, "api/src/routes"));
    expect(routeFiles.length).toBeGreaterThan(0);

    for (const file of routeFiles) {
      const source = read(file);
      const handlers = source.match(/app\.(get|post|put|patch|delete)\s*\(/g) ?? [];
      const responses = source.match(/response:\s*\{/g) ?? [];
      expect(
        responses.length,
        `${path.relative(ROOT, file)} declares ${String(handlers.length)} routes `
        + `but ${String(responses.length)} response schemas`,
      ).toBe(handlers.length);
    }
  });
});
