// Foundation smoke test — and a real architecture gate.
//
// This proves three things at once, which is why it is not a throwaway
// assertion: test discovery works, workspace packages resolve, and the declared
// package graph is actually acyclic. The last one matters because ESLint's
// import restrictions catch a layer importing something forbidden, but they do
// not catch two packages that legitimately may import each other forming a
// cycle. A cycle would make the build order non-deterministic.
//
// It reads the real package.json and tsconfig.json files rather than a
// hand-maintained list, so adding a package cannot bypass the check.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

interface PackageManifest {
  name?: string;
  private?: boolean;
  type?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
}

interface TsConfig {
  references?: { path: string }[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

const packageNames = fs
  .readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

/** Internal dependency graph, taken from each package's declared dependencies. */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const name of packageNames) {
    const manifest = readJson<PackageManifest>(
      path.join(PACKAGES_DIR, name, "package.json"),
    );
    const internal = Object.keys(manifest.dependencies ?? {})
      .filter(dep => dep.startsWith("@lagda/"))
      .map(dep => dep.slice("@lagda/".length));
    graph.set(name, internal);
  }
  return graph;
}

describe("workspace foundation", () => {
  it("discovers every backend package", () => {
    // Guards the rest of the file: an empty list would make every other
    // assertion below pass without checking anything.
    expect(packageNames).toEqual([
      "api", "application", "contracts", "core", "db", "sealing", "storage", "worker",
    ]);
  });

  it("keeps every package private and ESM", () => {
    // A backend package must never be publishable to the public registry.
    for (const name of packageNames) {
      const manifest = readJson<PackageManifest>(
        path.join(PACKAGES_DIR, name, "package.json"),
      );
      expect(manifest.name, `${name} package name`).toBe(`@lagda/${name}`);
      expect(manifest.private, `${name} must be private`).toBe(true);
      expect(manifest.type, `${name} must be ESM`).toBe("module");
    }
  });

  it("gives every package a declared entry point", () => {
    // Catches a broken export that would otherwise only surface when another
    // package first tries to import it.
    for (const name of packageNames) {
      const manifest = readJson<PackageManifest>(
        path.join(PACKAGES_DIR, name, "package.json"),
      );
      expect(manifest.exports?.["."], `${name} must declare exports["."]`).toBeDefined();
      expect(
        fs.existsSync(path.join(PACKAGES_DIR, name, "src", "index.ts")),
        `${name} must have src/index.ts`,
      ).toBe(true);
    }
  });

  it("has no dependency cycles", () => {
    const graph = buildGraph();
    const state = new Map<string, "visiting" | "done">();
    const cycles: string[] = [];

    const visit = (node: string, trail: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "visiting") {
        cycles.push([...trail.slice(trail.indexOf(node)), node].join(" → "));
        return;
      }
      state.set(node, "visiting");
      for (const dep of graph.get(node) ?? []) visit(dep, [...trail, node]);
      state.set(node, "done");
    };

    for (const name of packageNames) visit(name, []);
    expect(cycles).toEqual([]);
  });

  it("keeps package.json dependencies and tsconfig references in agreement", () => {
    // Two places declare the same graph. If they drift, the build order stops
    // matching the dependency the code actually has, and `tsc --build` succeeds
    // or fails for reasons unrelated to the source.
    const mismatches: string[] = [];
    for (const name of packageNames) {
      const manifest = readJson<PackageManifest>(
        path.join(PACKAGES_DIR, name, "package.json"),
      );
      const tsconfig = readJson<TsConfig>(
        path.join(PACKAGES_DIR, name, "tsconfig.json"),
      );

      const declared = new Set(
        Object.keys(manifest.dependencies ?? {})
          .filter(dep => dep.startsWith("@lagda/"))
          .map(dep => dep.slice("@lagda/".length)),
      );
      const referenced = new Set(
        (tsconfig.references ?? []).map(ref => path.basename(ref.path)),
      );

      for (const dep of declared) {
        if (!referenced.has(dep)) {
          mismatches.push(`${name}: depends on ${dep} but does not reference it`);
        }
      }
      for (const ref of referenced) {
        if (!declared.has(ref)) {
          mismatches.push(`${name}: references ${ref} but does not depend on it`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("does not depend on the LAGDA frontend (INV-006)", () => {
    // The backend shares contracts through @lagda/contracts, never by reaching
    // into the frontend's source tree.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (full.endsWith(".ts")) {
          const source = fs.readFileSync(full, "utf8");
          if (/from\s+["'][^"']*src\/app\/models/.test(source)) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    walk(PACKAGES_DIR);
    expect(offenders).toEqual([]);
  });
});
