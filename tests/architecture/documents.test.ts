// Document architecture guards.
//
// BACKEND-29's central claim is that a Document is an identity and an Artifact
// is bytes, and that the document domain never crosses into the second. These
// read the source and the schema and fail.
//
// The PDF-library guard matters most for what comes next: BACKEND-30 will be
// tempted to parse a PDF to place fields, and the boundary has to fail rather
// than be remembered.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES, capabilitiesFor } from "@lagda/core";
import { WORKSPACE_CAPABILITY_NAMES, WORKSPACE_ROLES } from "@lagda/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

/** Source with comments stripped — the trap `authorization.test.ts` recorded. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const USE_CASES = path.join(PACKAGES, "application", "src", "documents", "documents.ts");
const PORTS = path.join(PACKAGES, "application", "src", "common", "ports", "documents.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "documents.ts");
const MIGRATION = path.join(PACKAGES, "db", "src", "migrations", "016_documents.ts");
const ROUTES = path.join(PACKAGES, "api", "src", "documents", "document-routes.ts");
const CORE = path.join(PACKAGES, "core", "src", "documents", "index.ts");
const CONTRACTS = path.join(PACKAGES, "contracts", "src", "documents", "index.ts");

const DOCUMENT_FILES = [USE_CASES, PORTS, REPOSITORY, ROUTES, CORE, CONTRACTS];

// ── 1. The PDF and storage boundary ──────────────────────────────────────────

describe("the document domain never touches bytes", () => {
  it("imports no PDF library anywhere", () => {
    // The inspection boundary (BACKEND-18) and the sealer (BACKEND-09) are the
    // only places a PDF is opened. BACKEND-30 will want to parse one to place
    // fields; this is the guard that makes that a deliberate decision.
    for (const file of DOCUMENT_FILES) {
      const source = code(file);
      for (const forbidden of ["pdf-lib", "pdfjs", "pdf-parse", "hummus", "PDFDocument"]) {
        expect(source, `${path.basename(file)} imports ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("imports no storage provider or storage client", () => {
    for (const file of DOCUMENT_FILES) {
      const source = code(file);
      for (const forbidden of [
        "@aws-sdk", "S3Client", "putObject", "getObject", "presign",
        "@lagda/storage",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("never invokes the sealer", () => {
    for (const file of DOCUMENT_FILES) {
      expect(code(file), `${path.basename(file)} reaches the sealer`)
        .not.toMatch(/DocumentSealer|\bseal\s*\(/);
    }
  });

  it("never handles a storage key or a digest in the document layer", () => {
    // The use case reads artifact METADATA and projects a safe subset. If
    // `storageReference` or `digest` appears here, the projection has been
    // widened and a storage key is one serialization away from a response.
    const source = code(USE_CASES);
    expect(source).not.toContain("storageReference");
    expect(source).not.toContain("digest");
    expect(code(ROUTES)).not.toContain("storageReference");
    expect(code(ROUTES)).not.toContain("digest");
  });

  it("the document repository never reads the artifact table", () => {
    // Two tables, two repositories. A document repository that joined to
    // artifacts would make the safe-projection boundary a matter of which
    // query someone wrote.
    expect(code(REPOSITORY)).not.toContain("document_artifacts");
  });
});

// ── 2. Identity separation ───────────────────────────────────────────────────

describe("DocumentId is not ArtifactId", () => {
  it("the documents table has no artifact, storage or digest column", () => {
    const migration = code(MIGRATION);
    for (const column of [
      "artifact_id", "original_artifact_id", "storage_reference", "storage_key",
      "digest", "sha256", "size_bytes", "media_type",
    ]) {
      expect(migration, `documents must not have a ${column} column`)
        .not.toContain(`${column} `);
    }
  });

  it("the contract publishes no artifact identifier", () => {
    const contract = code(CONTRACTS);
    for (const field of ["artifactId", "storageKey", "bucket", "sha256", "digest"]) {
      expect(contract, `the Document contract exposes ${field}`)
        .not.toContain(field);
    }
  });

  it("the create and rename request schemas accept exactly one property", () => {
    // Scoped to the REQUEST SCHEMA declarations, not the whole file. The
    // response projection legitimately contains `createdByUserId`, and a guard
    // that could not tell a request from a response would either fail on
    // correct code or have to be weakened until it caught nothing.
    const routes = code(ROUTES);
    const schemas = [...routes.matchAll(
      /const (?:Create|Rename)\w*RequestSchema = Type\.Object\(([\s\S]*?)\}, \{([\s\S]*?)\}\);/g,
    )];
    expect(schemas).toHaveLength(2);

    for (const [whole] of schemas.map(m => [m[0]])) {
      for (const forbidden of [
        "artifactId", "uploadId", "storageKey", "bucket", "sha256", "digest",
        "malwareScanStatus", "sizeBytes", "mediaType", "pageCount",
        "createdByUserId", "workspaceId", "documentId", "createdAt", "status",
      ]) {
        expect(whole, `a request schema accepts ${forbidden}`)
          .not.toContain(forbidden);
      }
      // Exactly one property, and unknown ones are rejected rather than stripped.
      expect(whole).toContain("title:");
      expect(whole).toContain("additionalProperties: false");
    }
  });
});

// ── 3. No document lifecycle ─────────────────────────────────────────────────

describe("document state is not signing state", () => {
  it("the documents table has no status or archived_at", () => {
    const migration = code(MIGRATION);
    expect(migration).not.toContain("status");
    expect(migration).not.toContain("archived_at");
    expect(migration).not.toContain("deleted_at");
  });

  it("no signing vocabulary appears in the document domain", () => {
    // The seventeen TransactionStatus values belong to BACKEND-32. Copying any
    // of them onto a document is what §33 forbids.
    for (const file of DOCUMENT_FILES) {
      const source = code(file);
      for (const status of [
        '"sent"', '"completed"', '"declined"', '"awaiting-signature"',
        '"partially-completed"', '"voided"', '"expired"',
      ]) {
        expect(source, `${path.basename(file)} uses the signing status ${status}`)
          .not.toContain(status);
      }
    }
  });

  it("the port declares no state transition", () => {
    const ports = code(PORTS);
    for (const absent of ["archive", "restore", "setStatus", "delete"]) {
      expect(ports, `the port declares ${absent}`).not.toContain(absent);
    }
    // What it declares instead: one mutation, plus a write-once provenance field.
    expect(ports).toContain("rename");
    expect(ports).toContain("recordOriginalFilename");
  });
});

// ── 4. Deletion ──────────────────────────────────────────────────────────────

describe("documents cannot be deleted", () => {
  it("the runtime role gets no DELETE grant", () => {
    const migration = read(MIGRATION);
    const grant = /grant\s+([a-z,\s]+?)\s+on\s+table\s+documents/i.exec(migration);
    expect(grant, "migration 016 must grant explicitly").not.toBeNull();
    expect(grant?.[1]).toBe("select, insert, update");
  });

  it("no document file issues a delete statement", () => {
    for (const file of [REPOSITORY, USE_CASES, PORTS]) {
      expect(code(file), `${path.basename(file)} deletes`)
        .not.toMatch(/deleteFrom|DELETE\s+FROM/i);
    }
  });

  it("the API exposes no DELETE route", () => {
    expect(code(ROUTES)).not.toMatch(/app\.delete\s*\(/);
  });

  it("the artifact reference is RESTRICT, never CASCADE", () => {
    // A cascade from a document to its artifacts would let a delete destroy
    // immutable evidence of bytes that exist.
    const migration = read(MIGRATION);
    expect(migration).toContain("on delete restrict");
    expect(migration).not.toContain("on delete cascade");
    expect(migration).not.toContain("on delete set null");
  });
});

// ── 5. Tenancy ───────────────────────────────────────────────────────────────

describe("documents are workspace-owned", () => {
  it("has workspace_id, FORCE RLS and tenant isolation with both clauses", () => {
    const migration = read(MIGRATION);
    expect(migration).toContain("workspace_id");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("create policy tenant_isolation on documents");
    expect(migration).toContain("using (workspace_id = lagda_current_workspace())");
    expect(migration).toContain("with check (workspace_id = lagda_current_workspace())");
  });

  it("constrains the artifact link with a COMPOUND foreign key", () => {
    // The single most valuable line in migration 016: a single-column reference
    // would let a Workspace A artifact name a Workspace B document.
    const migration = read(MIGRATION);
    expect(migration).toMatch(
      /foreign key \(workspace_id, document_id\)[\s\S]{0,120}references documents \(workspace_id, document_id\)/,
    );
  });

  it("enforces one ORIGINAL artifact per document", () => {
    const migration = read(MIGRATION);
    expect(migration).toMatch(/create unique index document_artifacts_one_original_idx/);
    expect(migration).toContain("where artifact_type = 'original'");
  });

  it("adds no RLS bypass and no new transaction scope", () => {
    const migration = read(MIGRATION);
    expect(migration).not.toContain("BYPASSRLS");
    expect(migration).not.toContain("security definer");
    for (const file of [REPOSITORY, USE_CASES]) {
      expect(code(file)).not.toContain("runGlobal");
      expect(code(file)).not.toContain("runForInvitationCredential");
    }
  });

  it("no repository method takes a workspace argument", () => {
    expect(code(PORTS)).not.toMatch(/\(\s*workspaceId\s*:/);
  });

  it("has no unique constraint on the title", () => {
    // §167. Two "Lease Agreement" documents in one workspace is ordinary.
    expect(code(MIGRATION)).not.toMatch(/unique[\s\S]{0,120}title/i);
  });
});

// ── 6. Capabilities ──────────────────────────────────────────────────────────

describe("document capabilities", () => {
  it("are named in the use cases, never a role", () => {
    const source = code(USE_CASES);
    expect(source).toContain('"document.view"');
    expect(source).toContain('"document.create"');
    expect(source).toContain('"document.update"');
    expect(source).toContain("assertCapability");
  });

  it("appear identically in core and contracts", () => {
    expect([...WORKSPACE_CAPABILITY_NAMES].sort())
      .toEqual([...WORKSPACE_CAPABILITIES].sort());
  });

  it("give view to six roles and write to four", () => {
    // The product's own split: `view_documents` vs `prepare_documents`.
    const viewers = WORKSPACE_ROLES.filter(
      role => capabilitiesFor(role).includes("document.view"));
    expect([...viewers].sort()).toEqual([
      "administrator", "auditor", "owner", "reviewer", "sender",
      "template_administrator",
    ]);

    const writers = WORKSPACE_ROLES.filter(
      role => capabilitiesFor(role).includes("document.create"));
    expect([...writers].sort()).toEqual([
      "administrator", "owner", "sender", "template_administrator",
    ]);
  });

  it("never grant write without view", () => {
    // The one combination that would be incoherent: a role able to create a
    // document it cannot then read.
    for (const role of WORKSPACE_ROLES) {
      const held = capabilitiesFor(role);
      if (held.includes("document.create") || held.includes("document.update")) {
        expect(held, `${role} may write but not view`).toContain("document.view");
      }
    }
  });

  it("declares no capability for an operation that does not exist", () => {
    for (const absent of [
      "document.delete", "document.archive", "document.download",
      "document.send", "document.sign", "document.prepare",
    ]) {
      expect(WORKSPACE_CAPABILITIES as readonly string[]).not.toContain(absent);
    }
  });
});

// ── 7. Telemetry ─────────────────────────────────────────────────────────────

describe("document titles stay out of telemetry", () => {
  it("no log payload carries a title or filename", () => {
    // A legal document's name identifies the client, the matter and the
    // counterparty. `titleLength` is logged instead.
    const routes = code(ROUTES);
    const payloads = [...routes.matchAll(/record\(request,[\s\S]*?\}\);/g)]
      .map(match => match[0]);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toMatch(/\btitle\b(?!Length)/);
      expect(payload).not.toMatch(/\bfilename\b/i);
    }
  });

  it("the metric labels are a closed set with no identifier", () => {
    const routes = code(ROUTES);
    const metric = /increment\("document_operations_total",\s*\{([\s\S]*?)\}\)/.exec(routes);
    expect(metric).not.toBeNull();
    const labels = metric?.[1] ?? "";
    for (const forbidden of ["documentId", "workspaceId", "artifactId", "title"]) {
      expect(labels, `metric label ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("every response is no-store", () => {
    const routes = code(ROUTES);
    const handlers = (routes.match(/app\.(get|post|put|patch)\(/g) ?? []).length;
    const noStore = (routes.match(/noStore\(reply\);/g) ?? []).length;
    expect(noStore).toBe(handlers);
  });
});

// ── 8. Route hygiene ─────────────────────────────────────────────────────────

describe("document routes stay a transport layer", () => {
  it("import no database or query builder", () => {
    const routes = code(ROUTES);
    for (const forbidden of ["@lagda/db", "kysely", "selectFrom", "insertInto"]) {
      expect(routes, `routes import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("contain no `any`", () => {
    const files = [USE_CASES, PORTS, REPOSITORY, ROUTES, CORE, CONTRACTS];
    for (const file of files) {
      expect(code(file), `${path.basename(file)} uses any`)
        .not.toMatch(/\bas any\b|:\s*any\b/);
    }
  });

  it("carry no unresolved TODO on an implemented path", () => {
    for (const file of DOCUMENT_FILES) {
      expect(read(file), `${path.basename(file)} has a TODO`)
        .not.toMatch(/TODO|FIXME|XXX/);
    }
  });
});

// ── 9. Boundaries with neighbouring domains ──────────────────────────────────

describe("the document domain does not reach into other domains", () => {
  it("references no contact, recipient, template or signing request", () => {
    for (const file of DOCUMENT_FILES) {
      const source = code(file);
      for (const forbidden of [
        "contacts", "ContactId", "recipient", "Recipient",
        "signingRequest", "SigningRequest", "template", "Template",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no signing evidence", () => {
    // Creating or renaming a document is not an event in a signing
    // transaction. BACKEND-43 may add a general workspace audit trail.
    for (const file of [USE_CASES, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }
  });
});

// ── 10. Every document source file is covered above ──────────────────────────

it("guards every file in the document domain", () => {
  // So a new file in one of these directories cannot escape the checks by
  // simply not being listed.
  const dirs = [
    path.join(PACKAGES, "application", "src", "documents"),
    path.join(PACKAGES, "api", "src", "documents"),
    path.join(PACKAGES, "core", "src", "documents"),
    path.join(PACKAGES, "contracts", "src", "documents"),
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        found.push(full);
      }
    }
  }
  const guarded = new Set(DOCUMENT_FILES.map(f => path.resolve(f)));
  const unguarded = found.filter(f => !guarded.has(path.resolve(f)));
  expect(unguarded.map(f => path.relative(ROOT, f))).toEqual([]);
});
