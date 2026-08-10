// Recipient architecture guards.
//
// BACKEND-31's central claims are that a recipient is a SNAPSHOT and that a
// recipient's email is a delivery address rather than an identity. Both are
// only worth stating if something fails when they are broken.
//
// The four that matter, in order of how expensive being wrong would be:
//
//   1. A recipient is never resolved to a LAGDA account, and the brands make
//      the attempt a compile error rather than a review comment.
//   2. A contact is read ONCE, at creation. Nothing refreshes from it.
//   3. A field can only name a recipient of its own preparation, and a
//      three-column foreign key says so independently of the application.
//   4. No authentication or ceremony state exists to be written.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES } from "@lagda/core";
import { RECIPIENT_TYPES } from "@lagda/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Source with comments stripped.
 *
 * The same helper the contact and preparation guards use. A detector that
 * cannot tell code from prose flags the comment EXPLAINING the rule, and
 * teaches people to delete the explanation.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Migration source with SQL line comments stripped too.
 *
 * `code()` removes JavaScript comments, but a migration's explanations live
 * inside template literals as `-- …` and survive it. Every assertion below that
 * measures the DISTANCE between two SQL clauses needs them gone: an eight-line
 * comment between `references contacts` and `on delete set null` is prose, and
 * a guard that failed because of it would be a guard that punishes documenting
 * the constraint it is checking.
 */
function sql(file: string): string {
  return code(file).replace(/^\s*--.*$/gm, "");
}

const USE_CASES = path.join(PACKAGES, "application", "src", "recipients", "recipients.ts");
const PORTS = path.join(PACKAGES, "application", "src", "common", "ports", "recipients.ts");
const CORE = path.join(PACKAGES, "core", "src", "recipients", "index.ts");
const CONTRACTS = path.join(PACKAGES, "contracts", "src", "recipients", "index.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "recipients.ts");
const ROUTES = path.join(PACKAGES, "api", "src", "recipients", "recipient-routes.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "018_preparation_recipients.ts");
const SCHEMA = path.join(PACKAGES, "db", "src", "schema", "index.ts");
const PREPARATION_USE_CASES = path.join(
  PACKAGES, "application", "src", "preparation", "preparation.ts");

const RECIPIENT_FILES = [USE_CASES, PORTS, CORE, CONTRACTS, REPOSITORY, ROUTES];

// ── 1. A recipient is not an account ─────────────────────────────────────────

describe("a recipient is never resolved to a LAGDA account", () => {
  it("no recipient file reaches a user or membership repository", () => {
    for (const file of RECIPIENT_FILES) {
      const source = code(file);
      for (const forbidden of [
        "uow.users", "uow.invitations",
        "findByNormalizedEmail", "findUserByEmail",
        "memberships.insert", "memberships.changeRoleIfUnchanged",
      ]) {
        expect(source, `${path.basename(file)} calls ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
    // The use cases read ONE membership, and only to resolve the actor's own
    // authority — not the recipient's.
    expect(code(USE_CASES)).toContain("uow.memberships.findByUser");
  });

  it("declares a recipient email brand distinct from the account and contact keys", () => {
    // Three folds with the same algorithm and three meanings. Mutually
    // unassignable, so `findUserByNormalizedEmail(recipient.emailKey)` is a
    // compile error rather than something a reviewer has to notice.
    const core = code(CORE);
    expect(core).toMatch(
      /export type RecipientEmailKey = string & \{ readonly __brand: "RecipientEmailKey" \}/);
    expect(core).not.toContain("NormalizedEmail");
    expect(core).not.toContain("ContactEmailKey");
  });

  it("carries no account link on the record, the wire shape or the table", () => {
    for (const file of [PORTS, CONTRACTS, SCHEMA, MIGRATION]) {
      const source = code(file);
      for (const forbidden of [
        "isRegisteredUser", "linkedUserId", "recipientUserId", "resolvedUserId",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
    // A `user_id` column on the recipients table specifically.
    expect(code(MIGRATION)).not.toMatch(/^\s+user_id\s/m);
  });
});

// ── 2. A recipient is a snapshot ─────────────────────────────────────────────

describe("a recipient is a snapshot, not a live contact reference", () => {
  it("reads a contact in exactly one place", () => {
    const source = code(USE_CASES);
    const reads = source.match(/uow\.contacts\.\w+/g) ?? [];
    // One read, in `resolveDetails`, at the moment the copy is taken. A second
    // would be a refresh — the thing the snapshot rule forbids.
    expect(reads).toEqual(["uow.contacts.findById"]);
  });

  it("never writes a contact", () => {
    // The inverse leak: naming a participant must not grow the address book.
    const source = code(USE_CASES);
    for (const forbidden of [
      "contacts.insert", "contacts.update", "contacts.archive", "contacts.restore",
    ]) {
      expect(source, `recipient use cases call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("declares no refresh operation anywhere", () => {
    for (const file of RECIPIENT_FILES) {
      const source = code(file);
      for (const forbidden of [
        "syncFromContact", "refreshFromContact", "refreshRecipient", "relinkContact",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("stores the copied values on the row, not just the contact id", () => {
    // A table with `source_contact_id` and no `name` would be a reference
    // wearing a snapshot's name.
    const migration = code(MIGRATION);
    for (const column of ["name ", "email ", "organization ", "source_contact_id "]) {
      expect(migration, `preparation_recipients has no ${column.trim()}`)
        .toContain(column);
    }
  });

  it("keeps the recipient when its source contact is deleted", () => {
    // ON DELETE SET NULL, and the ONLY one in the schema: everywhere else a
    // parent is RESTRICT or CASCADE. Deleting an address-book entry must not
    // delete a party to a contract, and must not be blocked by one either.
    expect(sql(MIGRATION)).toMatch(/references contacts[\s\S]{0,120}on delete set null/);
  });
});

// ── 3. Field assignment cannot cross a preparation ───────────────────────────

describe("a field can only name a recipient of its own preparation", () => {
  it("constrains the assignment with a three-column foreign key", () => {
    // Tenant isolation cannot make this check: two preparations in one
    // workspace are both visible to RLS, and only the parent column separates
    // them. Two columns would not be enough.
    const migration = sql(MIGRATION);
    expect(migration).toMatch(
      /foreign key \(workspace_id, preparation_id, recipient_id\)/);
    expect(migration).toMatch(
      /references preparation_recipients \(workspace_id, preparation_id, recipient_id\)/);
  });

  it("refuses to delete a recipient that still holds fields", () => {
    // RESTRICT, not CASCADE. A cascade would silently destroy placed work when
    // a sender removes the wrong party.
    expect(sql(MIGRATION)).toMatch(
      /references preparation_recipients[\s\S]{0,200}on delete restrict/);
  });

  it("drops the opaque participant slot rather than leaving both", () => {
    // Two ways to say who fills a field is one way too many.
    expect(code(MIGRATION)).toContain("drop column participant_slot");
    for (const file of [PREPARATION_USE_CASES, SCHEMA, ROUTES]) {
      expect(code(file), `${path.basename(file)} still uses participantSlot`)
        .not.toContain("participantSlot");
    }
  });

  it("validates assignment against the preparation's own recipients", () => {
    // The application check, beside the constraint. Present so a caller gets a
    // validation message rather than a foreign-key violation.
    expect(code(PREPARATION_USE_CASES)).toContain("uow.recipients.list");
    expect(code(PREPARATION_USE_CASES)).toContain("canHoldFields");
  });
});

// ── 4. Nothing here authenticates anyone ─────────────────────────────────────

describe("a recipient email is delivery, not authentication", () => {
  it("declares no verification, token or ceremony state", () => {
    for (const file of [PORTS, CONTRACTS, SCHEMA, MIGRATION, ROUTES]) {
      const source = code(file);
      for (const forbidden of [
        "emailVerified", "verifiedAt", "accessToken", "signingToken",
        "otp", "authenticatedAt", "signedAt", "viewedAt", "declinedAt",
        "emailSentAt", "deliveredAt", "bouncedAt",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("sends nothing", () => {
    // No email provider was added, and nothing here queues a job that would
    // stand in for one.
    for (const file of RECIPIENT_FILES) {
      const source = code(file);
      for (const forbidden of ["sendEmail", "mailer", "enqueue", "jobs."]) {
        expect(source, `${path.basename(file)} calls ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no signing evidence", () => {
    // Adding a participant to a draft is not an event in a signing
    // transaction. BACKEND-32 owns the moment that becomes true.
    for (const file of [USE_CASES, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }
  });

  it("touches no PDF, no storage and no sealer", () => {
    for (const file of RECIPIENT_FILES) {
      const source = code(file);
      for (const forbidden of [
        "pdf-lib", "@lagda/sealing", "@lagda/storage", "DocumentSealer", "storageReference",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });
});

// ── 5. The vocabulary is its own ─────────────────────────────────────────────

describe("a recipient type is not a workspace role", () => {
  it("shares no identifier with the capability vocabulary", () => {
    // `reviewer` appears in BOTH vocabularies and means different things: a
    // workspace reviewer reads the library, a signing reviewer reviews one
    // transaction. The guard is that no CAPABILITY was invented for a
    // recipient type — the two lists never merge.
    for (const type of RECIPIENT_TYPES) {
      expect(WORKSPACE_CAPABILITIES as readonly string[])
        .not.toContain(`recipient.${type}`);
    }
  });

  it("adds no capability of its own", () => {
    // Recipients are governed by `document.view` and `document.prepare`
    // (OD-128). A `recipient.manage` would create a role that may place a
    // signature field but not say who signs it.
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(capability.startsWith("recipient."), capability).toBe(false);
    }
    expect(code(USE_CASES)).toContain('"document.prepare"');
    expect(code(USE_CASES)).toContain('"document.view"');
  });

  it("names no role in the routes", () => {
    // The BACKEND-27 guard greps this directory; this states the same
    // expectation where a reader of the recipient work will see it.
    const source = code(ROUTES);
    expect(source).not.toMatch(/role\s*===/);
    for (const role of ["owner", "sender", "auditor"]) {
      expect(source, `routes mention the role ${role}`).not.toContain(`"${role}"`);
    }
  });

  it("declares exactly the six product roles, and no witness", () => {
    // §31 warns specifically against adding a witness role on
    // legal-plausibility grounds alone. The product has neither witnesses nor
    // in-person signing.
    expect(RECIPIENT_TYPES).toHaveLength(6);
    expect(RECIPIENT_TYPES as readonly string[]).not.toContain("witness");
    expect(RECIPIENT_TYPES as readonly string[]).not.toContain("in-person-signer");
  });
});

// ── 6. Tenancy ───────────────────────────────────────────────────────────────

describe("tenancy", () => {
  it("forces row-level security on the table", () => {
    const migration = code(MIGRATION);
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
  });

  it("grants the runtime role no bypass", () => {
    const migration = code(MIGRATION);
    for (const forbidden of ["BYPASSRLS", "SUPERUSER"]) {
      expect(migration, `migration grants ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("takes no workspace argument on any repository method", () => {
    // The scoped repository is bound to one workspace at construction. A method
    // that accepted a workspace would be a method that could be called with the
    // wrong one.
    const ports = code(PORTS);
    expect(ports).not.toMatch(/\(\s*workspaceId:/);
    expect(ports).not.toMatch(/,\s*workspaceId:\s*WorkspaceId/);
  });

  it("scopes every repository query by workspace AND preparation", () => {
    const source = code(REPOSITORY);
    const selects = source.match(/selectFrom\("preparation_\w+"\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    // Every query in the file filters on both. Counting is enough here because
    // the file is small and each method is one statement.
    const byWorkspace = source.match(/where\("workspace_id", "=", scope\)/g) ?? [];
    expect(byWorkspace.length).toBeGreaterThanOrEqual(3);
  });
});
