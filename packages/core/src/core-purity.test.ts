// Workspace ownership rules, and an executable audit that core stayed pure.
//
// The purity audit reads core's own source. ESLint already bars infrastructure
// imports (INV-005), but it cannot see the three things that make a domain
// layer untestable in practice: a hidden clock read, a hidden random source,
// and `any` used to escape a hard typing problem.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactlyOneOwner, wouldOrphanWorkspace, canReceiveOwnership,
  WORKSPACE_ROLES, INVITABLE_WORKSPACE_ROLES, type MembershipView,
} from "./workspaces/index.js";
import { InvariantViolationError, instantFromIso, instantToIso, hasPassed } from "./common/index.js";

// ── Workspace ownership ──────────────────────────────────────────────────────

const member = (memberId: string, role: MembershipView["role"]): MembershipView =>
  ({ memberId, role });

describe("workspace ownership", () => {
  it("accepts a workspace with exactly one owner", () => {
    expect(() => assertExactlyOneOwner([
      member("m1", "owner"), member("m2", "sender"),
    ])).not.toThrow();
  });

  it("refuses a workspace with no owner", () => {
    // Unrecoverable: nobody could transfer ownership or delete the workspace.
    expect(() => assertExactlyOneOwner([member("m1", "sender")]))
      .toThrow(InvariantViolationError);
  });

  it("refuses a workspace with two owners", () => {
    expect(() => assertExactlyOneOwner([
      member("m1", "owner"), member("m2", "owner"),
    ])).toThrow(InvariantViolationError);
  });

  it("detects a removal that would leave the workspace ownerless", () => {
    const members = [member("owner1", "owner"), member("m2", "sender")];
    expect(wouldOrphanWorkspace(members, "owner1")).toBe(true);
    expect(wouldOrphanWorkspace(members, "m2")).toBe(false);
  });

  it("transfers ownership only to an existing non-owner member", () => {
    const members = [member("owner1", "owner"), member("m2", "administrator")];
    expect(canReceiveOwnership(members, "m2")).toBe(true);
    expect(canReceiveOwnership(members, "stranger")).toBe(false);
    expect(canReceiveOwnership(members, "owner1")).toBe(false);
  });

  it("recognises every canonical role", () => {
    expect(WORKSPACE_ROLES).toContain("owner");
    // `member` joined in BACKEND-26: it is the product's default invited role
    // (`InvitationsPage.tsx` defaults to `role_member`) and had no backend
    // equivalent. Asserted by VALUE rather than by count, because a count tells
    // a future reader nothing about which role changed.
    expect(WORKSPACE_ROLES).toContain("member");
    expect([...WORKSPACE_ROLES].sort()).toEqual([
      "administrator", "auditor", "member", "owner",
      "reviewer", "sender", "template_administrator",
    ]);
  });

  it("never allows an invitation to grant ownership", () => {
    // Structural, not a check: `owner` is absent from the invitable list, so
    // the request schema built from it cannot express it.
    expect(INVITABLE_WORKSPACE_ROLES).not.toContain("owner");
    expect(INVITABLE_WORKSPACE_ROLES.length).toBe(WORKSPACE_ROLES.length - 1);
  });
});

// ── Time primitives ──────────────────────────────────────────────────────────

describe("instants", () => {
  it("round-trips an ISO timestamp", () => {
    const iso = "2026-08-09T04:15:30.000Z";
    expect(instantToIso(instantFromIso(iso))).toBe(iso);
  });

  it("refuses a malformed timestamp", () => {
    expect(() => instantFromIso("not-a-date")).toThrow(InvariantViolationError);
  });

  it("treats a deadline as exclusive", () => {
    const deadline = instantFromIso("2026-08-09T00:00:00.000Z");
    expect(hasPassed(deadline, deadline)).toBe(false);
    expect(hasPassed(deadline, instantFromIso("2026-08-09T00:00:00.001Z"))).toBe(true);
  });
});

// ── Purity audit ─────────────────────────────────────────────────────────────

const SRC = path.dirname(fileURLToPath(import.meta.url));

function productionSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        out.push({ file: path.relative(SRC, full), source: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

describe("core stays pure", () => {
  const sources = productionSources();

  it("has production sources to audit", () => {
    // Without this, every check below would pass over an empty list.
    expect(sources.length).toBeGreaterThan(3);
  });

  it("never reads the current time", () => {
    // Every time-dependent rule takes `now` as an argument. A hidden clock read
    // makes expiry logic untestable without stubbing globals.
    const offenders = sources
      .filter(s => /Date\.now\(\)|new Date\(\s*\)/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("never generates randomness", () => {
    // Identities and tokens are supplied by the application layer.
    const offenders = sources
      .filter(s => /Math\.random|randomUUID|randomBytes|crypto\./.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("never reads the environment", () => {
    const offenders = sources
      .filter(s => /process\.env|import\.meta\.env/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("imports no Node built-ins or infrastructure", () => {
    const offenders = sources
      .filter(s => /from\s+["'](node:|fastify|pg|pg-boss|pino|pdf-lib|@aws-sdk)/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("uses no `any` escape hatches", () => {
    const offenders = sources
      .filter(s => /:\s*any\b|as\s+any\b/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("leaves no unfinished rules hidden in comments", () => {
    // Unresolved behaviour belongs in OPEN_DECISIONS.md, where it is visible,
    // not in a TODO nobody reads.
    const offenders = sources
      .filter(s => /\b(TODO|FIXME|HACK|XXX)\b/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it("exposes no generic status setter", () => {
    // The rule that keeps transitions auditable: lifecycle changes go through
    // named actions, never `setStatus`.
    const offenders = sources
      .filter(s => /setStatus|setState\b|setWorkspaceId/.test(s.source))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });
});
