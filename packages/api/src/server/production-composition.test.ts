// What the production executable actually serves.
//
// composition.test.ts proves every route module is REFERENCED in create-app.
// Being referenced buys nothing on its own: every group is gated on
// `dependencies.X !== undefined`, so a module can be mounted in the code and
// absent from the running API because nothing supplies its dependencies.
//
// That was not hypothetical. `createProductionDependencies` supplied TWO
// groups -- `databaseHealth`, and `providerWebhook` only when a credential
// exists. A deployment running `npm run start:api` served /health, /ready and
// possibly the provider callback: no sign-in, no workspace, no document, no
// signing surface, no rate limiter.
//
// Sessions, identity and the workspace surface are now wired. The rest is
// still listed below, and each entry has to say why.
//
// ── Why sub-groups are checked too ─────────────────────────────────────────
//
// `workspaces` being supplied says nothing about `workspaces.invitations`.
// Every sub-group is independently gated the same way, so a composition that
// supplies the parent and omits four children would read as "workspaces: wired"
// while four route surfaces stayed unreachable. Both levels are enumerated.

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

/**
 * Sub-groups of `workspaces` the composition does not supply, and why.
 *
 * The first two share ONE cause: both mint a link into the web app, and there
 * is no `appBaseUrl` in `ApiConfig` for them to build it from. Adding that key
 * is a deployment-facing decision -- a new required environment variable --
 * rather than something to introduce as a side effect of wiring.
 */
const WORKSPACE_SUBGROUPS_NOT_WIRED: Record<string, string> = {
  invitations:
    "InvitationLinkBuilder needs an app base URL, and ApiConfig has no key " +
    "for one. Also wants a DeliverySecretSealer for the sealed credential.",
  sendSigningRequest:
    "Same missing app base URL, for the signing link, plus a sealer keyed by " +
    "SIGNING_DELIVERY_KEY and a real notification template registry.",
  audit:
    "AuditTrailDependencies is request-scoped -- it carries the actor, the " +
    "workspace and the signing request -- so it cannot be built at boot the " +
    "way the other thunks are.",
  cancelSigningRequest:
    "Depends on the signing-workflow graph, which is not composed anywhere " +
    "outside its own tests.",
};

function dependencySource(): string {
  return readFileSync(join(API_SRC, "app/dependencies.ts"), "utf8");
}

function optionalGroups(): string[] {
  const appBlock = dependencySource()
    .split("export interface AppDependencies")[1]
    ?.split("export interface WorkspaceDependencies")[0] ?? "";
  return [...appBlock.matchAll(/readonly ([a-zA-Z]+)\?:/g)].map((m) => m[1] as string);
}

function workspaceSubgroups(): string[] {
  const block = dependencySource()
    .split("export interface WorkspaceDependencies")[1] ?? "";
  return [...block.matchAll(/readonly ([a-zA-Z]+)\?:/g)].map((m) => m[1] as string);
}

function productionBody(): string {
  // Both files: identity is composed in its own module because inline it would
  // be four times the length of everything else, and a group must not read as
  // unwired merely because it was moved somewhere legible.
  const source = readFileSync(join(API_SRC, "server/start-server.ts"), "utf8")
    + readFileSync(join(API_SRC, "server/identity-composition.ts"), "utf8");
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

  it("accounts for every workspace sub-group, wired or explicitly not", () => {
    const body = productionBody();
    const unaccounted = workspaceSubgroups().filter((group) =>
      !new RegExp(`\\b${group}\\s*:`).test(body)
      && WORKSPACE_SUBGROUPS_NOT_WIRED[group] === undefined);

    expect(
      unaccounted,
      "a workspace sub-group production neither supplies nor deliberately " +
      "omits -- the parent being wired does not mount it",
    ).toEqual([]);
  });

  it("keeps the sub-group omission list honest", () => {
    const subgroups = workspaceSubgroups();
    for (const omitted of Object.keys(WORKSPACE_SUBGROUPS_NOT_WIRED)) {
      expect(
        subgroups.includes(omitted), `${omitted} is listed but is not a sub-group`,
      ).toBe(true);
    }
  });

  it("records how much of the API a deployment actually serves", () => {
    // Deliberately an assertion rather than a comment: when someone wires a
    // group, this number moves and the change is visible in the diff.
    const wired = groups.length - Object.keys(NOT_WIRED_IN_PRODUCTION).length;
    expect(wired).toBe(4);

    const subWired =
      workspaceSubgroups().length - Object.keys(WORKSPACE_SUBGROUPS_NOT_WIRED).length;
    expect(subWired).toBe(7);
  });
});
