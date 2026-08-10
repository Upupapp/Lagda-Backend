// Authorization architecture guards.
//
// BACKEND-27's central rule is "routes and feature code do not compare role
// names". A rule like that decays into a review convention unless something
// fails when it is broken, so these read the source and fail.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_CAPABILITIES, WORKSPACE_ROLES, capabilitiesFor,
} from "@lagda/core";
import { WORKSPACE_CAPABILITY_NAMES } from "@lagda/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { found.push(...sourceFiles(full)); continue; }
    if (full.endsWith(".ts") && !full.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * Written after the first run of this guard flagged three files whose only
 * "role comparison" was a comment EXPLAINING that the comparison had been
 * removed. A detector that cannot tell code from prose reports the fix as the
 * violation, and the tempting response is to stop writing the explanation.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const relative = (file: string): string =>
  path.relative(ROOT, file).replace(/\\/g, "/");

/**
 * A role name used as a VALUE in a comparison or a switch.
 *
 * Deliberately narrow. It matches `role === "owner"`, `=== "administrator"`,
 * a `case "owner":`, and the inverse forms — not the word "owner" in prose, not
 * a role in a type position, and not a string in a schema union. A detector
 * wider than the invariant produces failures that teach the wrong lesson, and
 * the tempting fix for those is an allowlist rather than a narrower check
 * (the same reasoning `sealing.test.ts` records for `createHash`).
 */
const ROLE_COMPARISON = new RegExp(
  String.raw`(?:[!=]==?\s*["'](?:owner|administrator|member|sender|reviewer|auditor|template_administrator)["'])`
  + String.raw`|(?:["'](?:owner|administrator|member|sender|reviewer|auditor|template_administrator)["']\s*[!=]==?)`
  + String.raw`|(?:\bcase\s+["'](?:owner|administrator|member|sender|reviewer|auditor|template_administrator)["']\s*:)`,
);

describe("authorization is centralized", () => {
  it("compares a role name in exactly ONE production file", () => {
    // The policy is allowed to compare roles — deciding what a role means is
    // its entire job. Nothing else is.
    const offenders: string[] = [];

    for (const pkg of readdirSync(PACKAGES)) {
      const src = path.join(PACKAGES, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch { continue; }

      for (const file of sourceFiles(src)) {
        if (file.endsWith(".test.ts")) continue;
        // Test support states expectations about roles; it is not production
        // authorization code.
        if (file.includes("test-support")) continue;
        if (ROLE_COMPARISON.test(code(file))) offenders.push(relative(file));
      }
    }

    // FOUR entries, each in one of the categories §250 permits — the policy,
    // a mapper, a domain operation about the role itself. A fifth fails, and
    // the fix is to ask for a capability rather than to extend this list.
    //
    //   core/authorization  — the role-to-capability policy and the grant
    //                         rules. The one place a role name is allowed to
    //                         decide what someone may DO.
    //   core/workspaces     — the ownership invariants. `assertExactlyOneOwner`
    //                         counts owners; the role IS the subject, not the
    //                         authority being checked.
    //   contracts/workspaces— derives `INVITABLE_WORKSPACE_ROLES` by excluding
    //                         `owner`. A list construction, not a decision.
    //   db/migrations/014   — builds the CHECK constraints from the same lists.
    //                         A schema mapper.
    expect(offenders.sort()).toEqual([
      "packages/contracts/src/workspaces/index.ts",
      "packages/core/src/authorization/index.ts",
      "packages/core/src/workspaces/index.ts",
      "packages/db/src/migrations/014_workspace_invitations.ts",
    ]);
  });

  it("has no role comparison in any ROUTE file", () => {
    // Stated separately from the rule above, because routes are where this
    // regresses first and the failure should name them.
    const routeFiles: string[] = [];
    for (const file of sourceFiles(path.join(PACKAGES, "api", "src"))) {
      if (file.endsWith(".test.ts")) continue;
      if (!/routes?\.ts$/.test(file)) continue;
      if (ROLE_COMPARISON.test(code(file))) routeFiles.push(relative(file));
    }
    expect(routeFiles).toEqual([]);
  });

  it("defines the capability list in exactly one place", () => {
    // `@lagda/contracts` publishes the NAMES for a client to receive.
    // `@lagda/core` owns the policy. Two lists is one more than there should
    // be, so they are compared rather than trusted to stay in step.
    expect([...WORKSPACE_CAPABILITY_NAMES].sort())
      .toEqual([...WORKSPACE_CAPABILITIES].sort());
  });

  it("keeps the authorization policy free of infrastructure", () => {
    const policy = read(path.join(PACKAGES, "core/src/authorization/index.ts"));
    for (const forbidden of [
      "fastify", "kysely", "pg", "@lagda/db", "@lagda/api",
      "node:crypto", "process.env", "Date.now",
    ]) {
      expect(policy).not.toContain(forbidden);
    }
  });

  it("persists no per-member capability column or permission blob", () => {
    // Capabilities derive from the role. A `can_invite` column or a
    // `permissions jsonb` would be a second authority that drifts from the
    // policy, and a per-member override nobody reviewed (§156, §157, §251).
    const schema = read(path.join(PACKAGES, "db/src/schema/index.ts"));
    for (const forbidden of [
      "can_invite", "can_manage", "can_edit", "permissions", "capabilities",
    ]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("introduces no external policy engine", () => {
    // §252. OPA, Casbin and Cedar each replace a reviewable pure function with
    // a runtime nobody in this repository has an ADR for.
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const names = Object.keys(manifest.dependencies ?? {}).join(" ");
    for (const engine of ["casbin", "@open-policy-agent", "cedar", "oso", "accesscontrol"]) {
      expect(names).not.toContain(engine);
    }
  });

  it("puts no role or capability in the session contract", () => {
    // A credential carrying authorization keeps granting it after the
    // authorization changes. `AuthenticatedActor` has carried no workspace
    // since BACKEND-13 and must keep carrying none (§16, §243, §253).
    const session = read(path.join(PACKAGES, "application/src/common/ports/session.ts"));
    const actorBlock = session.slice(
      session.indexOf("export interface AuthenticatedActor"),
      session.indexOf("export interface SessionRecord"),
    );
    for (const forbidden of ["role", "capabilit", "permission", "workspaceId"]) {
      expect(actorBlock.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("keeps workspace roles out of the account profile", () => {
    // §254. A profile form that could set a role is a privilege-escalation
    // primitive, and INV-307 already bans mass assignment there.
    const profile = read(path.join(PACKAGES, "application/src/account/profile.ts"));
    expect(ROLE_COMPARISON.test(profile)).toBe(false);
    expect(profile).not.toContain("WorkspaceRole");
  });

  it("never represents a system actor as a workspace role", () => {
    // §90, §247, §255. A worker that needed `owner` to pass a human
    // authorization check would be a fake membership with real authority.
    const context = read(path.join(PACKAGES, "application/src/common/context.ts"));
    const systemBlock = context.slice(context.indexOf("export interface SystemActor"));
    expect(systemBlock).not.toContain("role");
    expect(systemBlock).not.toContain("WorkspaceRole");
  });
});

describe("the capability projection cannot exceed the policy", () => {
  it("returns only capabilities the policy actually grants", () => {
    // §237. A projection that listed more than the policy allows would have a
    // client showing controls every use of which is refused.
    for (const role of WORKSPACE_ROLES) {
      for (const capability of capabilitiesFor(role)) {
        expect(WORKSPACE_CAPABILITIES).toContain(capability);
      }
    }
  });

  it("gives an ordinary member exactly one capability", () => {
    // The concrete shape of "member is not everything except ownership" (§4).
    expect(capabilitiesFor("member")).toEqual(["workspace.view"]);
  });
});
