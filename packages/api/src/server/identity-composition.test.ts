// What the identity composition must keep true without a database to prove it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSITION = readFileSync(join(HERE, "identity-composition.ts"), "utf8");

describe("identity composition", () => {
  /**
   * The one duplicated string in the file.
   *
   * `lagda.user_id` is private to `@lagda/db`'s transaction module, and the
   * identity commits need it because none of the existing units of work covers
   * the account tables. A copied constant that nothing pins is how two
   * definitions drift; the failure it would produce is silent and severe --
   * `set_config` on a name no policy reads succeeds, so every notification
   * write would simply see nothing and the flow would look like it worked.
   */
  it("uses the same user-context setting the db package sets", () => {
    const transactions = readFileSync(
      join(HERE, "../../../db/src/transactions/index.ts"), "utf8",
    );
    const declared = /const USER_SETTING = "([^"]+)"/.exec(transactions)?.[1];
    expect(declared, "USER_SETTING not found in @lagda/db").toBeDefined();

    const copied = /const USER_CONTEXT_SETTING = "([^"]+)"/.exec(COMPOSITION)?.[1];
    expect(copied).toBe(declared);
  });

  /**
   * Every graph the port declares has to be supplied.
   *
   * `IdentityDependencies` is all-or-nothing, so a missing key is a type error
   * -- but only for the graphs. This checks the list against the interface so
   * that a graph ADDED later is noticed here rather than by whoever finds the
   * route returning 500.
   */
  it("supplies every graph the identity surface declares", () => {
    const routes = readFileSync(join(HERE, "../app/identity-routes.ts"), "utf8");
    const declared = [...(routes
      .split("interface IdentityDependencies")[1] ?? "")
      .matchAll(/readonly ([a-zA-Z]+): \(\) =>/g)].map((m) => m[1] as string);

    expect(declared.length).toBeGreaterThan(15);
    const missing = declared.filter(
      (graph) => !new RegExp(`\\b${graph}: \\(\\) =>`).test(COMPOSITION));
    expect(missing).toEqual([]);
  });

  /**
   * The surface is gated on the MFA key, not on individual graphs.
   *
   * Wiring sign-in while enrolment throws would ship an account that can be
   * created and then locked out of. The early return is the thing that makes
   * that unrepresentable, so it is asserted rather than left to review.
   */
  it("declines to build any of it without an MFA key", () => {
    expect(COMPOSITION).toMatch(/if \(config\.mfaSecretKey === null\) return \{\};/);
  });

  it("composes from real repositories, never a test double", () => {
    const code = COMPOSITION
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/test-support/);
    expect(code).not.toMatch(/InMemory[A-Za-z]*/);
    expect(code).not.toMatch(/Fake[A-Za-z]*/);
  });
});
