// INV-190, enforced as a test because the lint rule is disabled in the file
// this reads.
//
// The ban on importing `pg-boss` inside packages/api is really a ban on the
// API being ABLE to consume jobs: an HTTP replica that calls `.work()` starts
// a background consumer inside a web process, and the two roles scale and
// restart for different reasons. One file is exempt from the import ban —
// `job-scheduler.ts`, which IS the adapter the rule says to extract — so the
// thing the ban was protecting has to be asserted directly there.
//
// Source text rather than behaviour, deliberately. There is no runtime moment
// at which "this module never consumes" can be observed: a consumer that is
// never started looks identical to one that does not exist. The repo already
// uses this technique for the same class of invariant — see
// production-composition.test.ts and security/identifiers.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * pg-boss's consumption surface.
 *
 * Every one of these registers or manages a handler, which is the capability
 * an HTTP process must not have. `send` and `stop` are deliberately absent:
 * publishing and shutting down are exactly what the API is allowed to do.
 */
const CONSUMPTION_CALLS = [".work(", ".schedule(", ".offWork(", ".subscribe("];

describe("the API's queue adapter", () => {
  const source = readFileSync(
    new URL("./job-scheduler.ts", import.meta.url), "utf8",
  );

  // Comments are stripped first: this file's own header names `.work()` while
  // explaining why it must not appear, and a test that fails on its own
  // explanation would be deleted rather than heeded.
  const code = source
    .split("\n")
    .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  for (const call of CONSUMPTION_CALLS) {
    it(`never calls ${call})`, () => {
      expect(code).not.toContain(call);
    });
  }

  it("hands back a queue handle that carries no pg-boss instance", () => {
    // The structural half of the same guarantee. `createCompletionQueue`
    // returns `{ scheduler, close }`; if a `boss` were ever added to that
    // object, every caller would regain the consumption surface regardless of
    // what this module itself calls.
    const returned = /return\s*\{([^}]*)\}/s.exec(
      code.slice(code.indexOf("export async function createCompletionQueue")));
    expect(returned, "createCompletionQueue should return an object literal").not.toBeNull();
    expect(returned?.[1]).not.toContain("boss,");
    expect(returned?.[1]).not.toMatch(/\bboss\b\s*:/);
  });
});
