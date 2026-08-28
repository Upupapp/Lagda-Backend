// What the production executable actually serves.
//
// composition.test.ts proves every route module is REFERENCED in create-app.
// Being referenced buys nothing on its own: every group is gated on
// `dependencies.X !== undefined`, so a module can be mounted in the code and
// absent from the running API because nothing supplies its dependencies.
//
// That is not hypothetical. `createProductionDependencies` supplies TWO of the
// twelve groups -- `databaseHealth`, and `providerWebhook` only when a
// credential exists. A deployment running `npm run start:api` serves /health,
// /ready and possibly the provider callback. There is no sign-in, no
// workspace, no document, no upload, no signing surface, and no rate limiter.
//
// This test does not pretend that is fine. It pins it: the gap is enumerated
// below, each entry has to say why, and a group added later without wiring --
// or without a deliberate decision not to wire it -- fails here rather than
// being discovered by someone deploying it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Groups the production composition root does not supply, and why.
 *
 * Every entry is a route surface that exists, is mounted in code, and cannot
 * be reached in a deployment. Shrinking this list is the work; adding to it
 * should require the same argument as any other decision to ship less.
 */
const NOT_WIRED_IN_PRODUCTION: Record<string, string> = {
  sessions: "No session service is constructed, so nothing can authenticate.",
  identity: "Seventeen use-case graphs; none built outside the dev server.",
  workspaces: "Needs a real TransactionManager over the database.",
  upload: "Needs object storage, an inspector and a malware scanner.",
  signingAccess: "Depends on the signing-access graph.",
  signingCeremony: "Depends on the ceremony graph.",
  signingSubmission: "Depends on the submission graph.",
  signingDecline: "Depends on the decline graph.",
  publicVerification: "Needs the evidence projection lookup.",
  limiter:
    "No AbuseLimiter is constructed, so the fourteen rate-limit policies " +
    "defined across the codebase are attached to nothing. Raised as part of " +
    "OD-069 and still open.",
};

function optionalGroups(): string[] {
  const source = readFileSync(join(API_SRC, "app/dependencies.ts"), "utf8");
  const appBlock = source
    .split("export interface AppDependencies")[1]
    ?.split("export interface WorkspaceDependencies")[0] ?? "";
  return [...appBlock.matchAll(/readonly ([a-zA-Z]+)\?:/g)].map((m) => m[1] as string);
}

function productionBody(): string {
  const source = readFileSync(join(API_SRC, "server/start-server.ts"), "utf8");
  // The factory plus its helpers: a group may be supplied by a spread.
  return source.split("createProductionDependencies")[1] ?? "";
}

describe("production composition", () => {
  const groups = optionalGroups();

  it("finds the dependency groups to check", () => {
    expect(groups.length).toBeGreaterThan(5);
  });

  it("accounts for every optional group, wired or explicitly not", () => {
    const body = productionBody();
    const unaccounted = groups.filter((group) => {
      const supplied = new RegExp(`\\b${group}\\s*:`).test(body)
        || new RegExp(`build${group[0]?.toUpperCase()}${group.slice(1)}`, "i").test(body);
      return !supplied && NOT_WIRED_IN_PRODUCTION[group] === undefined;
    });

    expect(
      unaccounted,
      "a route group that production neither supplies nor deliberately omits — " +
      "wire it, or add it above with the reason it ships unreachable",
    ).toEqual([]);
  });

  it("keeps the omission list honest", () => {
    // An entry for a group that no longer exists is a stale excuse, and would
    // silently exempt a future group that took the name.
    for (const omitted of Object.keys(NOT_WIRED_IN_PRODUCTION)) {
      expect(groups.includes(omitted), `${omitted} is listed but is not a group`).toBe(true);
    }
  });

  it("records how much of the API a deployment actually serves", () => {
    // Deliberately an assertion rather than a comment: when someone wires a
    // group, this number moves and the change is visible in the diff.
    const wired = groups.length - Object.keys(NOT_WIRED_IN_PRODUCTION).length;
    expect(wired).toBe(1);
  });
});
