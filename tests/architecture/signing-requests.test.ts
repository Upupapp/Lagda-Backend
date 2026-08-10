// Signing request architecture guards.
//
// BACKEND-32's central claim is that a signing request is an IMMUTABLE snapshot
// which nothing mutable can reach into afterwards. The guards that matter, in
// order of how expensive being wrong would be:
//
//   1. The READ path never joins to a contact, a preparation recipient or a
//      preparation field. A detail endpoint that resolved a name through the
//      current contact would silently undo the entire aggregate.
//   2. Creating sends nothing: no email, no token, no OTP, no job, no PDF, no
//      sealer.
//   3. The snapshot tables have no update path, in the application OR in the
//      database grants.
//   4. The client cannot supply the snapshot.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES } from "@lagda/core";
import { SIGNING_REQUEST_STATES } from "@lagda/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

/** Source with comments stripped. The same helper the sibling guards use. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Migration source with SQL line comments stripped too.
 *
 * Needed by every assertion that measures the DISTANCE between two SQL clauses:
 * a comment explaining a constraint must not fail the guard that checks it.
 */
const sqlOf = (file: string): string => code(file).replace(/^\s*--.*$/gm, "");

const USE_CASES = path.join(
  PACKAGES, "application", "src", "signing-requests", "signing-requests.ts");
const PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "signing-requests.ts");
const CORE = path.join(PACKAGES, "core", "src", "signing", "snapshot.ts");
const CONTRACTS = path.join(PACKAGES, "contracts", "src", "signing-requests", "index.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "signing-requests.ts");
const ROUTES = path.join(
  PACKAGES, "api", "src", "signing-requests", "signing-request-routes.ts");
const MIGRATION = path.join(PACKAGES, "db", "src", "migrations", "019_signing_requests.ts");

const REQUEST_FILES = [USE_CASES, PORTS, CORE, CONTRACTS, REPOSITORY, ROUTES];

// ── 1. Historical authority ──────────────────────────────────────────────────

describe("the request is the historical authority", () => {
  it("reads no contact anywhere", () => {
    // The single most important guard in this file. A read path that resolved
    // a recipient's name through the current contact would undo the snapshot
    // silently, and every independence test would still pass because they
    // assert on the STORE rather than through the read.
    for (const file of REQUEST_FILES) {
      const source = code(file);
      for (const forbidden of ["uow.contacts", "ContactId", "contacts."]) {
        expect(source, `${path.basename(file)} reaches ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("reads preparation ONLY while building the snapshot", () => {
    const source = code(USE_CASES);
    // `buildSnapshot` and `resolveSourceArtifact` are the only readers, and
    // both run inside creation. The guard is positional: every mutable read
    // must appear BEFORE the read use case, which is last in the file.
    const readUseCase = source.indexOf("export async function getSigningRequest");
    expect(readUseCase).toBeGreaterThan(0);
    const afterRead = source.slice(readUseCase);

    for (const forbidden of [
      "uow.preparations", "uow.recipients", "uow.documents", "uow.artifacts",
    ]) {
      expect(afterRead, `getSigningRequest reaches ${forbidden}`)
        .not.toContain(forbidden);
    }
    // And it DOES read its own snapshot rows.
    expect(afterRead).toContain("uow.signingRequests.listRecipients");
    expect(afterRead).toContain("uow.signingRequests.listFields");
  });

  it("stores the copied values rather than only the provenance", () => {
    // A table with `source_preparation_recipient_id` and no `name` would be a
    // reference wearing a snapshot's name.
    const migration = code(MIGRATION);
    for (const column of ["name ", "email ", "organization ", "recipient_type "]) {
      expect(migration, `the recipient table has no ${column.trim()}`)
        .toContain(column);
    }
    for (const column of ["field_type ", "page_number ", "label "]) {
      expect(migration, `the field table has no ${column.trim()}`).toContain(column);
    }
  });

  it("snapshots the document title, because a title is mutable", () => {
    expect(code(MIGRATION)).toContain("document_title");
    expect(code(USE_CASES)).toContain("documentTitle: document.title");
  });

  it("keeps the snapshot when the mutable side is deleted", () => {
    // ON DELETE SET NULL on BOTH provenance columns, each with the column list
    // - a bare clause would null `workspace_id` and make the delete fail.
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(
      /references preparation_recipients[\s\S]{0,160}on delete set null \(source_preparation_recipient_id\)/);
    expect(migration).toMatch(
      /references preparation_fields[\s\S]{0,160}on delete set null \(source_preparation_field_id\)/);
  });
});

// ── 2. Request-scoped identity ───────────────────────────────────────────────

describe("request-scoped identity", () => {
  it("declares three brands distinct from the preparation's", () => {
    const ports = code(PORTS);
    for (const brand of [
      "SigningRequestId", "SigningRequestRecipientId", "SigningRequestFieldId",
    ]) {
      expect(ports).toMatch(
        new RegExp(`export type ${brand} =[\\s\\S]{0,80}__brand: "${brand}"`));
    }
  });

  it("generates all three server-side", () => {
    const source = code(USE_CASES);
    for (const generator of [
      "nextSigningRequestId", "nextSigningRequestRecipientId", "nextSigningRequestFieldId",
    ]) {
      expect(source, `${generator} is never called`).toContain(generator);
    }
  });

  it("constrains a field's assignee with a THREE-column foreign key", () => {
    // Tenant isolation cannot catch a field naming another REQUEST's recipient:
    // both rows are legitimately visible to one tenant.
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(
      /foreign key \(workspace_id, signing_request_id, request_recipient_id\)/);
    expect(migration).toMatch(
      /references signing_request_recipients\s*\(workspace_id, signing_request_id, request_recipient_id\)/);
  });

  it("makes a request field's assignee NOT NULL, unlike a preparation field's", () => {
    // An unassigned field is a legitimate authoring state and an impossible
    // workflow state.
    expect(sqlOf(MIGRATION)).toMatch(/request_recipient_id\s+varchar\(64\)\s+not null/);
  });
});

// ── 3. Creating sends nothing ────────────────────────────────────────────────

describe("creating a request sends nothing", () => {
  it("issues no credential of any kind", () => {
    for (const file of [...REQUEST_FILES, MIGRATION]) {
      const source = code(file);
      for (const forbidden of [
        "accessToken", "access_token", "signingToken", "signing_token",
        "signingUrl", "otp", "tokenDigest", "token_digest", "authenticatedAt",
        "authenticated_at",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("sends and queues nothing", () => {
    for (const file of REQUEST_FILES) {
      const source = code(file);
      for (const forbidden of ["sendEmail", "mailer", "enqueue", "jobs.", "outbox"]) {
        expect(source, `${path.basename(file)} calls ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("touches no PDF, no storage and no sealer", () => {
    for (const file of REQUEST_FILES) {
      const source = code(file);
      for (const forbidden of [
        "pdf-lib", "@lagda/sealing", "@lagda/storage", "DocumentSealer",
        "storageReference", "storage_reference",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no signing evidence", () => {
    // Configuring a workflow is not evidence that anything happened to a
    // recipient. BACKEND-43 owns signing evidence.
    for (const file of [USE_CASES, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }
  });

  it("carries no ceremony or delivery column", () => {
    for (const file of [MIGRATION, PORTS, CONTRACTS]) {
      const source = code(file);
      for (const forbidden of [
        "sent_at", "sentAt", "delivered_at", "viewed_at", "viewedAt",
        "signed_at", "signedAt", "declined_at", "completed_at", "cancelled_at",
        "expires_at", "expiresAt", "email_sent_at", "delivery_status",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("declares exactly one writable state today", () => {
    // The type carries the whole lifecycle vocabulary; the DATABASE is the
    // gate. A CHECK admitting only `draft` means a bug cannot write `sent`.
    expect(sqlOf(MIGRATION)).toMatch(/REQUEST_STATES = \["draft"\]/);
    expect(code(USE_CASES)).toContain('state: "draft"');
    expect(SIGNING_REQUEST_STATES).toContain("draft");
  });
});

// ── 4. Immutability ──────────────────────────────────────────────────────────

describe("the snapshot is immutable", () => {
  it("offers no update method on either snapshot table", () => {
    const ports = code(PORTS);
    for (const forbidden of [
      "updateRecipient", "updateField", "update(", "patch", "delete(",
    ]) {
      expect(ports, `the port declares ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("issues no UPDATE statement against either snapshot table", () => {
    const repository = code(REPOSITORY);
    expect(repository).not.toContain("updateTable");
    expect(repository).not.toContain("deleteFrom");
  });

  it("grants the runtime role no UPDATE on either snapshot table", () => {
    // Immutability as a privilege, not a convention a repository author has to
    // remember. Note the request row DOES get UPDATE, for BACKEND-33's state
    // transition.
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(
      /grant select, insert, delete on table signing_request_recipients/);
    expect(migration).toMatch(
      /grant select, insert, delete on table signing_request_fields/);
    expect(migration).toMatch(
      /grant select, insert, update, delete on table signing_requests/);
  });

  it("exposes no generic patch route", () => {
    const routes = code(ROUTES);
    expect(routes).not.toContain("app.patch");
    expect(routes).not.toContain("app.put");
    expect(routes).not.toContain("app.delete");
  });
});

// ── 5. The client supplies nothing ───────────────────────────────────────────

describe("the client cannot author the snapshot", () => {
  it("accepts an empty, closed creation body", () => {
    const routes = code(ROUTES);
    expect(routes).toMatch(
      /const CreateRequestBodySchema = Type\.Object\(\{\}, \{[\s\S]{0,200}additionalProperties: false/);
  });

  it("resolves the source artifact from the preparation, never from input", () => {
    const source = code(USE_CASES);
    expect(source).toContain("preparation.sourceArtifactId");
    // No input field named for it anywhere.
    expect(source).not.toMatch(/input\.(sourceArtifactId|artifactId)/);
  });

  it("takes the creator from the session", () => {
    expect(code(USE_CASES)).toContain("createdByUserId: input.actor.userId");
  });

  it("takes recipients and fields from the repositories", () => {
    const source = code(USE_CASES);
    expect(source).toContain("uow.recipients.list");
    expect(source).toContain("uow.preparations.listFields");
    expect(source).not.toMatch(/input\.(recipients|fields)/);
  });
});

// ── 6. Tenancy, authorization and telemetry ──────────────────────────────────

describe("tenancy and authorization", () => {
  it("forces row-level security on all three tables", () => {
    const migration = code(MIGRATION);
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
    // The loop covers all three, so the tables are named once.
    for (const table of [
      "signing_requests", "signing_request_recipients", "signing_request_fields",
    ]) {
      expect(migration, `${table} is missing`).toContain(table);
    }
  });

  it("grants the runtime role no bypass", () => {
    const migration = code(MIGRATION);
    for (const forbidden of ["BYPASSRLS", "SUPERUSER"]) {
      expect(migration, `migration grants ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("takes no workspace argument on any repository method", () => {
    const ports = code(PORTS);
    expect(ports).not.toMatch(/\(\s*workspaceId:/);
    expect(ports).not.toMatch(/,\s*workspaceId:\s*WorkspaceId/);
  });

  it("uses the two centralized capabilities and no role literal", () => {
    const source = code(USE_CASES);
    expect(source).toContain('"signing-request.create"');
    expect(source).toContain('"signing-request.view"');
    expect(source).not.toMatch(/role\s*===/);

    const routes = code(ROUTES);
    expect(routes).not.toMatch(/role\s*===/);
    for (const role of ["owner", "sender", "auditor", "reviewer"]) {
      expect(routes, `routes mention the role ${role}`).not.toContain(`"${role}"`);
    }
  });

  it("declares both capabilities in the central list", () => {
    for (const capability of ["signing-request.create", "signing-request.view"]) {
      expect(WORKSPACE_CAPABILITIES as readonly string[]).toContain(capability);
    }
  });

  it("has no unscoped lookup", () => {
    const repository = code(REPOSITORY);
    // Every query filters on the bound scope.
    const selects = repository.match(/selectFrom\("signing_request/g) ?? [];
    const scoped = repository.match(/where\("workspace_id", "=", scope\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(scoped.length).toBeGreaterThanOrEqual(selects.length);
  });
});

describe("telemetry", () => {
  it("logs counts and ids, never a name, an address, a title or geometry", () => {
    const routes = code(ROUTES);
    const payload = /request\.log\.info\(\{([\s\S]*?)\}, "signing_request\.created"\)/
      .exec(routes);
    expect(payload).not.toBeNull();
    const body = payload?.[1] ?? "";
    for (const forbidden of [
      "name", "email", "documentTitle", "label", "rect", "\\bx\\b", "\\by\\b",
      "recipients", "fields:",
    ]) {
      expect(body, `the log payload contains ${forbidden}`)
        .not.toMatch(new RegExp(forbidden));
    }
    expect(body).toContain("recipientCount");
    expect(body).toContain("fieldCount");
  });
});
