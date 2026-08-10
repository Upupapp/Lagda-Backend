// Contact architecture guards.
//
// BACKEND-28's central claim is that a contact is address-book data and never
// an identity. That claim is only worth making if something fails when it is
// broken, so these read the source and the schema and fail.
//
// The three that matter, in order of how expensive being wrong would be:
//
//   1. The contact domain cannot reach users, memberships or invitations.
//   2. Nothing can DELETE a contact — not the repository, not the runtime
//      database role.
//   3. The contact email key is not the account email key, and no code path
//      converts one into the other.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES, capabilitiesFor } from "@lagda/core";
import { WORKSPACE_CAPABILITY_NAMES, WORKSPACE_ROLES } from "@lagda/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Source with comments stripped.
 *
 * The same helper `authorization.test.ts` grew after its first run flagged
 * three files whose only violation was a comment EXPLAINING the rule. A
 * detector that cannot tell code from prose teaches people to delete the prose.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CONTACT_USE_CASES = path.join(
  PACKAGES, "application", "src", "contacts", "contacts.ts");
const CONTACT_PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "contacts.ts");
const CONTACT_REPOSITORY = path.join(
  PACKAGES, "db", "src", "repositories", "contacts.ts");
const MIGRATION = path.join(PACKAGES, "db", "src", "migrations", "015_contacts.ts");
const CONTACT_ROUTES = path.join(PACKAGES, "api", "src", "contacts", "contact-routes.ts");
const SCHEMA = path.join(PACKAGES, "db", "src", "schema", "index.ts");

// ── 1. Contacts are not identities ───────────────────────────────────────────

describe("a contact can never become an identity", () => {
  it("the use cases reach NO identity repository", () => {
    const source = code(CONTACT_USE_CASES);
    // The only repository the module may touch. If a later change reaches for
    // `uow.memberships.insert` or `uow.invitations`, this fails — and the
    // failure is the point, because the alternative is a contact form that
    // quietly provisions accounts.
    for (const forbidden of [
      "uow.invitations", "uow.users", "uow.workspaces.insert",
      "memberships.insert", "memberships.changeRoleIfUnchanged",
      "memberships.removeIfRole",
    ]) {
      expect(source, `contact use cases must not call ${forbidden}`)
        .not.toContain(forbidden);
    }
    // It reads ONE membership, and only to resolve the actor's own authority.
    expect(source).toContain("uow.memberships.findByUser");
  });

  it("no contact file resolves an account from an email", () => {
    for (const file of [CONTACT_USE_CASES, CONTACT_PORTS, CONTACT_REPOSITORY, CONTACT_ROUTES]) {
      const source = code(file);
      for (const forbidden of [
        "findByNormalizedEmail", "normalizeEmail", "assertNormalized",
        "NormalizedEmail",
      ]) {
        expect(source, `${path.basename(file)} must not use ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("the contacts table has no column linking it to a user", () => {
    const migration = code(MIGRATION);
    for (const column of [
      "user_id", "member_id", "membership_id", "invitation_id",
      "verified_at", "is_verified", "account_id",
    ]) {
      expect(migration, `contacts must not have a ${column} column`)
        .not.toContain(`"${column}"`);
    }
    // And exactly one foreign key: the tenant.
    expect(migration.match(/addForeignKeyConstraint/g) ?? []).toHaveLength(1);
    expect(migration).toContain('"workspaces"');
  });

  it("the response shape carries neither the comparison key nor the tenant", () => {
    const routes = code(CONTACT_ROUTES);
    expect(routes).not.toContain("emailKey");
    // `workspaceId` appears in the PATH and in log fields; what must not exist
    // is a presenter that copies it into the body.
    expect(code(CONTACT_USE_CASES)).not.toContain("workspaceId: record.workspaceId");
  });
});

// ── 2. Nothing deletes a contact ─────────────────────────────────────────────

describe("contacts are archived, never deleted", () => {
  it("the runtime role has no DELETE grant on the table", () => {
    const migration = read(MIGRATION);
    const grant = /grant\s+([a-z,\s]+?)\s+on\s+table\s+contacts/i.exec(migration);
    expect(grant, "migration 015 must grant explicitly").not.toBeNull();
    expect(grant?.[1]).toBe("select, insert, update");
    expect(grant?.[1]).not.toContain("delete");
  });

  it("no contact file issues a delete statement", () => {
    for (const file of [CONTACT_REPOSITORY, CONTACT_USE_CASES, CONTACT_PORTS]) {
      const source = code(file);
      expect(source, `${path.basename(file)} must not delete`)
        .not.toMatch(/deleteFrom|DELETE\s+FROM/i);
    }
  });

  it("the port declares no delete method", () => {
    const ports = code(CONTACT_PORTS);
    expect(ports).not.toMatch(/^\s*delete\s*\(/m);
    expect(ports).not.toContain("hardDelete");
    // What it declares instead.
    expect(ports).toContain("archiveIfActive");
    expect(ports).toContain("restoreIfArchived");
  });

  it("the API exposes no DELETE route for a contact", () => {
    const routes = code(CONTACT_ROUTES);
    expect(routes).not.toMatch(/app\.delete\s*\(/);
    expect(routes).toContain("/contacts/:contactId/archive");
    expect(routes).toContain("/contacts/:contactId/restore");
  });

  it("state is derived, not stored", () => {
    // A `status` column and an `archived_at` timestamp are two representations
    // of one fact, and the denormalised one is always the one that drifts.
    const migration = code(MIGRATION);
    expect(migration).toContain('"archived_at"');
    expect(migration).not.toContain('"status"');
    expect(code(SCHEMA)).not.toMatch(/contacts[\s\S]{0,900}?\bstatus:/);
  });
});

// ── 3. Tenancy ───────────────────────────────────────────────────────────────

describe("contacts are workspace-owned", () => {
  it("the table carries workspace_id with FORCE RLS and tenant isolation", () => {
    const migration = read(MIGRATION);
    expect(migration).toContain('"workspace_id"');
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("create policy tenant_isolation on contacts");
    // Both halves. A USING clause without WITH CHECK filters reads and permits
    // a write that plants a row in another tenant.
    expect(migration).toContain("using (workspace_id = lagda_current_workspace())");
    expect(migration).toContain("with check (workspace_id = lagda_current_workspace())");
  });

  it("adds NO new RLS bypass or credential scope", () => {
    // BACKEND-26 needed a fourth transaction scope for a non-member. Contacts
    // need none: every caller is an authenticated member. If a later change
    // adds one, it should be a deliberate ADR rather than a quiet import.
    const migration = read(MIGRATION);
    expect(migration).not.toContain("BYPASSRLS");
    expect(migration).not.toContain("security definer");
    for (const file of [CONTACT_REPOSITORY, CONTACT_USE_CASES]) {
      expect(code(file)).not.toContain("runGlobal");
      expect(code(file)).not.toContain("runForInvitationCredential");
    }
  });

  it("no repository method takes a workspace argument", () => {
    const ports = code(CONTACT_PORTS);
    // The scope is bound by the unit of work, so "read another tenant's address
    // book" is not a call that can be typed.
    expect(ports).not.toMatch(/\(\s*workspaceId\s*:/);
    expect(ports).not.toMatch(/readonly workspaceId\s*:\s*WorkspaceId;\s*\n\s*readonly search/);
  });

  it("has no unique constraint on the contact email", () => {
    // Deliberate, and asserted so it cannot be "tidied up" later. Shared
    // inboxes are legitimately several contacts, and the product DETECTS
    // duplicates rather than preventing them.
    //
    // `code()`, not `read()`. The first run of this assertion failed on the
    // migration's own comment explaining that the index is NOT unique — the
    // same trap `authorization.test.ts` records, where the detector reports the
    // explanation as the violation and the tempting fix is to delete the prose.
    const migration = code(MIGRATION);
    expect(migration).not.toMatch(/unique[\s\S]{0,200}normalized_contact_email/i);
    expect(migration).toMatch(/createIndex\("idx_contacts_workspace_email"\)/);
  });
});

// ── 4. The capability policy ─────────────────────────────────────────────────

describe("contact capabilities", () => {
  it("are governed by the central policy, not by a role check", () => {
    const source = code(CONTACT_USE_CASES);
    expect(source).toContain('"contact.view"');
    expect(source).toContain('"contact.create"');
    expect(source).toContain('"contact.update"');
    expect(source).toContain('"contact.archive"');
    expect(source).toContain("assertCapability");
  });

  it("appear in BOTH the policy and the shared contract, identically", () => {
    // A shared name list that drifted from the policy would let a client
    // branch on a capability the server does not have.
    expect([...WORKSPACE_CAPABILITY_NAMES].sort())
      .toEqual([...WORKSPACE_CAPABILITIES].sort());
  });

  it("are held by exactly the four roles the product grants manage_contacts", () => {
    const holders = WORKSPACE_ROLES.filter(
      role => capabilitiesFor(role).includes("contact.view"));
    expect([...holders].sort())
      .toEqual(["administrator", "owner", "sender", "template_administrator"]);
  });

  it("travel together — no role holds a subset", () => {
    // Four capabilities and one product permission behind them. A role holding
    // `contact.create` but not `contact.view` would be a policy nobody decided.
    for (const role of WORKSPACE_ROLES) {
      const held = capabilitiesFor(role).filter(c => c.startsWith("contact."));
      expect([0, 4], `${role} holds ${String(held.length)} contact capabilities`)
        .toContain(held.length);
    }
  });

  it("declares no capability for an operation that does not exist", () => {
    // No `contact.delete`, no `contact.merge`, no `contact.import`. A
    // capability with nothing behind it is a promise the policy cannot keep.
    for (const absent of ["contact.delete", "contact.merge", "contact.import",
      "contact.export", "contact.tag"]) {
      expect(WORKSPACE_CAPABILITIES as readonly string[]).not.toContain(absent);
    }
  });
});

// ── 5. Personal data does not reach logs or metrics ──────────────────────────

describe("contact PII stays out of telemetry", () => {
  it("no log or metric field carries a contact's details", () => {
    const routes = code(CONTACT_ROUTES);
    // Everything between `record(request,` and its closing brace is a log
    // payload. None of it may name a contact field.
    const payloads = [...routes.matchAll(/record\(request,[\s\S]*?\}\);/g)]
      .map(match => match[0]);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      for (const field of ["email", "name", "phone", "organization", "title"]) {
        expect(payload, `a log payload names ${field}`)
          .not.toMatch(new RegExp(`\\b${field}\\b`));
      }
    }
  });

  it("the metric labels are a closed set with no identifier", () => {
    const routes = code(CONTACT_ROUTES);
    const metric = /increment\("contact_operations_total",\s*\{([\s\S]*?)\}\)/.exec(routes);
    expect(metric).not.toBeNull();
    const labels = metric?.[1] ?? "";
    for (const forbidden of ["contactId", "workspaceId", "userId", "email"]) {
      expect(labels, `metric label ${forbidden} is unbounded or personal`)
        .not.toContain(forbidden);
    }
  });

  it("responses are marked no-store", () => {
    // An address book is a list of named people with their phone numbers.
    const routes = code(CONTACT_ROUTES);
    const handlers = (routes.match(/app\.(get|post|put)\(/g) ?? []).length;
    const noStore = (routes.match(/noStore\(reply\);/g) ?? []).length;
    expect(noStore).toBe(handlers);
  });
});
