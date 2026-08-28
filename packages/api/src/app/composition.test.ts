// Every route module is actually mounted.
//
// Twice now a route module has been written, tested, exported and never
// composed, and both times the unit tests stayed green because a unit test
// proves a module WORKS, never that it is REACHABLE:
//
//   OD-069  Eleven auth routes existed across five commands with none
//           registered. The emitted contract had no way to sign in.
//
//   Upload  upload-route.ts had its own suite -- accepts one file, refuses an
//           unauthorized caller, rejects extra files -- and was mounted
//           nowhere. The contract carried zero multipart endpoints, and every
//           document failed preparation with `document_has_no_source`: the
//           precondition was real and the only route that could satisfy it was
//           unreachable.
//
// Neither was found by a test. Both were found by driving the API and noticing
// that something the product needs could not be done. This test is the cheaper
// version of that discovery.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where composition happens.
 *
 * `create-app.ts` mounts most groups; `identity-routes.ts` is itself mounted by
 * it and composes the auth surface, so a registrar named there is reachable
 * too.
 */
const COMPOSITION_ROOTS = ["app/create-app.ts", "app/identity-routes.ts"];

/**
 * Registrars that are deliberately not mounted.
 *
 * Empty on purpose. A module belongs here only with a reason, and adding one
 * should feel like a decision rather than a formality -- that is the entire
 * value of the list.
 */
const DELIBERATELY_UNCOMPOSED: Record<string, string> = {};

const REGISTRAR = /^export (?:async )?function (register[A-Za-z]*Routes?)\b/gm;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

function declaredRegistrars(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const file of sourceFiles(API_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(REGISTRAR)) {
      found.push({ name: match[1] as string, file: relative(API_SRC, file) });
    }
  }
  return found;
}

describe("route composition", () => {
  const registrars = declaredRegistrars();

  it("finds the route modules to check", () => {
    // A regex that silently matched nothing would make this whole file a
    // no-op that reports success.
    expect(registrars.length).toBeGreaterThan(20);
  });

  it("mounts every route module that exists", () => {
    const composition = COMPOSITION_ROOTS
      .map((rel) => readFileSync(join(API_SRC, rel), "utf8"))
      .join("\n");

    const unmounted = registrars
      .filter(({ name }) => !new RegExp(`\\b${name}\\s*\\(`).test(composition))
      .filter(({ name }) => DELIBERATELY_UNCOMPOSED[name] === undefined)
      .map(({ name, file }) => `${name} (${file})`);

    expect(
      unmounted,
      "declared, exported, and mounted nowhere — see the header of this file",
    ).toEqual([]);
  });

  it("keeps the exclusion list honest", () => {
    // An entry for a registrar that no longer exists is a stale excuse, and it
    // would quietly exempt a future module that happened to take the name.
    const names = new Set(registrars.map((r) => r.name));
    for (const excluded of Object.keys(DELIBERATELY_UNCOMPOSED)) {
      expect(names.has(excluded), `${excluded} is excluded but does not exist`).toBe(true);
    }
  });
});
