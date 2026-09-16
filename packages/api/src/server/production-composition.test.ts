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

import { describe, it, expect, vi, afterEach } from "vitest";
import { createProductionDependencies } from "./start-server.js";
import { loadApiConfig } from "../config/index.js";
import type { LagdaDatabase } from "@lagda/db";
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
  // `signingAccess` LEFT this list. Its reason -- "depends on the signing-access
  // graph" -- described the shape of the work rather than a blocker: every
  // piece it needed already existed in the composition root. What the omission
  // cost was concrete, and only visible from outside: send mints a grant and
  // writes an invitation carrying a link, and the route that link points at
  // did not exist in a deployment.
  // ── EMPTY, and that is the point of keeping it ────────────────────────────
  //
  // Every route surface this API mounts is now reachable in a deployment.
  //
  // The five that were here all left in one day, and their reasons are worth
  // remembering because none was a blocker. `signingAccess`, `signingCeremony`,
  // `signingSubmission` and `signingDecline` said "depends on the X graph";
  // every port already had an implementation, and what was actually missing was
  // three ID generators nothing had needed because nothing had composed them.
  // `publicVerification` said "needs the evidence projection lookup", and the
  // lookup had been written all along -- merely unexported.
  //
  // So a reason in this list is a hypothesis, not a finding. The next entry
  // should be checked against the code before it is believed.
  //
  // The register stays rather than being deleted: the next surface added will
  // be unreachable on the day it is mounted, and this is where it goes. The
  // accounting below then fails until it is either wired or listed here.
};

/**
 * Sub-groups of `workspaces` the composition does not supply, and why.
 *
 * `invitations` and `sendSigningRequest` were both listed here and are now
 * wired: `APP_BASE_URL` exists, and both are CONDITIONAL on it rather than
 * absent. That conditionality is why they still cannot be asserted as
 * unconditionally present -- see the deployment-shape test below.
 *
 * `audit` was listed with a reason that was simply WRONG: it was called
 * request-scoped because `AuditTrailDependencies` sits next to a type carrying
 * an actor and a signing-request id. Those belong to the use case's INPUT. The
 * dependency object is `{ transactions }` and always could have been built.
 * Recorded rather than quietly deleted, because a confidently-worded excuse is
 * how a wireable group stays unwired.
 */
const WORKSPACE_SUBGROUPS_NOT_WIRED: Record<string, string> = {
  cancelSigningRequest:
    "Needs a CompletionIdGenerator, which has no production implementation, " +
    "and the send provisioner's `access` slice -- so it follows send rather " +
    "than standing alone.",
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

/**
 * Does the composition supply this group?
 *
 * Comments are STRIPPED first: this file's prose names every group it
 * discusses, and matching raw text made a documented omission read as a
 * wiring.
 *
 * Shorthand counts. `return { invitations }` supplies the group exactly as
 * `invitations: x` does, and an earlier version of this matched only the
 * colon -- so a correctly wired surface reported as missing, which is the
 * failure that teaches people to distrust the gate.
 */
function supplies(body: string, group: string): boolean {
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return new RegExp(`\\b${group}\\s*[:,}]`).test(code)
    || new RegExp(`build${group[0]?.toUpperCase() ?? ""}${group.slice(1)}`, "i").test(code);
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
    const unaccounted = groups.filter((group) =>
      !supplies(body, group) && NOT_WIRED_IN_PRODUCTION[group] === undefined);

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

  /**
   * And an entry for a group that IS wired is the same lie, pointing the other
   * way.
   *
   * This direction was unchecked, so wiring `signingAccess` left its excuse in
   * place and nothing failed. A stale entry is worse than a missing one: it
   * exempts the group from the accounting above, so a later change that
   * UNWIRED it would pass silently -- the list would still say it was never
   * wired, and the test would still agree.
   */
  it("lists nothing it has since wired", () => {
    const body = productionBody();
    const wiredButListed = Object.keys(NOT_WIRED_IN_PRODUCTION).filter(
      group => supplies(body, group));
    expect(
      wiredButListed,
      "these are supplied now and must leave NOT_WIRED_IN_PRODUCTION",
    ).toEqual([]);
  });

  it("accounts for every workspace sub-group, wired or explicitly not", () => {
    const body = productionBody();
    const unaccounted = workspaceSubgroups().filter((group) =>
      !supplies(body, group) && WORKSPACE_SUBGROUPS_NOT_WIRED[group] === undefined);

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
    // 6 -> 7 with `signingAccess`, 7 -> 10 with the ceremony, submission and
    // decline, and 10 -> 11 with public verification. The number moving IS the
    // record, and it now equals `groups.length`: every surface is reachable.
    expect(wired).toBe(11);
    expect(wired, "every group is wired; the register is empty")
      .toBe(groups.length);

    const subWired =
      workspaceSubgroups().length - Object.keys(WORKSPACE_SUBGROUPS_NOT_WIRED).length;
    // 11 -> 12 with `completedArtifact` (Phase 1-C).
    expect(subWired).toBe(12);
  });
});

/**
 * What a deployment actually gets, asked of the composition root itself.
 *
 * The tests above read source text, which is the only way to check a group that
 * is absent. These BUILD the object -- no database is touched, because every
 * repository factory only wraps a handle and none of them queries at
 * construction -- so a group that is wired but mis-shaped fails here rather
 * than passing a grep.
 */
describe("what a deployment serves", () => {
  const BASE_ENV = {
    NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "3000",
    CORS_ORIGINS: "https://app.example.com", SESSION_COOKIE_SECURE: "true",
  } as const;

  // Never queried: construction wraps, it does not connect.
  const database = {
    db: {} as never,
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
    describe: () => "test",
  } as unknown as LagdaDatabase;

  // Real keys: the secret box decodes and length-checks at construction, so a
  // 44-character placeholder fails for the wrong reason.
  const KEY = Buffer.alloc(32, 7).toString("base64");

  const build = async (extra: Record<string, string>) =>
    createProductionDependencies(
      database, loadApiConfig({ ...BASE_ENV, ...extra }));

  it("serves no identity surface without an MFA key", async () => {
    const deps = await build({});
    // Three of the seventeen graphs seal a TOTP secret. Half a surface would
    // be an account that can be created and then locked out of.
    expect(deps.identity).toBeUndefined();
  });

  it("serves identity once an MFA key exists", async () => {
    const deps = await build({ MFA_SECRET_KEY: KEY });
    expect(deps.identity).toBeDefined();
  });

  it("mints no links without an app origin", async () => {
    const deps = await build({});
    expect(deps.workspaces?.invitations).toBeUndefined();
    expect(deps.workspaces?.sendSigningRequest).toBeUndefined();
  });

  it("serves invitations, but not send, on the origin alone", async () => {
    const deps = await build({ APP_BASE_URL: "https://app.example.com" });
    expect(deps.workspaces?.invitations).toBeDefined();
    // Send's sealer protects the recipient credential. Without a key it would
    // refuse at every call, so the route does not exist instead.
    expect(deps.workspaces?.sendSigningRequest).toBeUndefined();
  });

  it("serves send once the delivery key joins the origin", async () => {
    const deps = await build({
      APP_BASE_URL: "https://app.example.com",
      SIGNING_DELIVERY_KEY: KEY,
    });
    expect(deps.workspaces?.sendSigningRequest).toBeDefined();
  });

  it("always serves the surfaces that need no configuration", async () => {
    const deps = await build({});
    expect(deps.sessions).toBeDefined();
    expect(deps.workspaces?.documents).toBeDefined();
    expect(deps.workspaces?.audit).toBeDefined();
    expect(deps.workspaces?.organization).toBeDefined();
  });

  /**
   * Upload needs BOTH object storage and a scanner, and refuses on either.
   *
   * `loadScannerConfig` states there is no configuration that disables
   * scanning, so a deployment with storage and no scanner must get NO upload
   * route rather than one that stores unscanned bytes.
   */
  it("mounts no upload route without object storage", async () => {
    const deps = await build({});
    expect(deps.upload).toBeUndefined();
  });

  const STORAGE_ENV = {
    OBJECT_STORAGE_REGION: "ap-southeast-1",
    OBJECT_STORAGE_BUCKET_ARTIFACTS: "lagda-artifacts",
    // Two buckets, not one. An accepted document and a file still being
    // scanned must not share a namespace.
    OBJECT_STORAGE_BUCKET_QUARANTINE: "lagda-quarantine",
    OBJECT_STORAGE_ACCESS_KEY_ID: "key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
  } as const;

  /**
   * Stubbed on `process.env`, not passed to `loadApiConfig`.
   *
   * Object storage and the scanner carry their own loaders, and each reads the
   * environment itself -- the same shape as `loadDatabaseConfig`. The
   * composition root is the one place allowed to read it, so a test of the
   * composition root has to set it there too.
   */
  const stubEnv = (vars: Record<string, string>) => {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("mounts no upload route with storage but no scanner", async () => {
    stubEnv(STORAGE_ENV);
    const deps = await build({});
    expect(deps.upload).toBeUndefined();
  });

  it("mounts upload once storage AND a scanner are configured", async () => {
    stubEnv({ ...STORAGE_ENV, MALWARE_SCANNER_HOST: "clamav.internal" });
    const deps = await build({});
    expect(deps.upload).toBeDefined();
  });

  it("always limits, because a limiter needs no configuration to be correct", async () => {
    // Unconditional on purpose. Every other optional group here is gated on a
    // key or an origin; this one is gated on nothing, because there is no
    // deployment that is better off unthrottled and the counters live in the
    // database the API already has.
    const deps = await build({});
    expect(deps.limiter).toBeDefined();
  });
});
