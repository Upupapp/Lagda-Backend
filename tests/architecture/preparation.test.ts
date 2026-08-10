// Preparation architecture guards.
//
// The claim: preparation defines signing intent and geometry, and never touches
// the accepted original. The PDF and sealer guards matter most — BACKEND-33
// will be working next door to this code with pdf-lib already imported.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES, capabilitiesFor, renderTypeFor } from "@lagda/core";
import {
  WORKSPACE_CAPABILITY_NAMES, WORKSPACE_ROLES, PREPARATION_FIELD_TYPES,
} from "@lagda/contracts";
import { SEALABLE_FIELD_TYPES } from "@lagda/application";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const USE_CASES = path.join(PACKAGES, "application", "src", "preparation", "preparation.ts");
const PORTS = path.join(PACKAGES, "application", "src", "common", "ports", "preparation.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "preparation.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "017_document_preparation.ts");
const ROUTES = path.join(PACKAGES, "api", "src", "preparation", "preparation-routes.ts");
const CORE = path.join(PACKAGES, "core", "src", "preparation", "index.ts");
const CONTRACTS = path.join(PACKAGES, "contracts", "src", "preparation", "index.ts");

const PREPARATION_FILES = [USE_CASES, PORTS, REPOSITORY, ROUTES, CORE, CONTRACTS];

// ── 1. The PDF, storage and sealing boundary ─────────────────────────────────

describe("preparation never touches bytes", () => {
  it("imports no PDF library anywhere", () => {
    // The inspection boundary (BACKEND-18) and the sealer (BACKEND-09) are the
    // only places a PDF is opened. Preparation reasons about normalized
    // rectangles and a page count.
    for (const file of PREPARATION_FILES) {
      const source = code(file);
      for (const forbidden of ["pdf-lib", "pdfjs", "pdf-parse", "hummus", "PDFDocument"]) {
        expect(source, `${path.basename(file)} imports ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("NEVER invokes the sealer", () => {
    // §17. Only completion may seal, and preparation is not completion.
    for (const file of PREPARATION_FILES) {
      const source = code(file);
      expect(source, `${path.basename(file)} reaches the sealer`)
        .not.toMatch(/DocumentSealer|\bseal\s*\(|@lagda\/sealing/);
    }
  });

  it("imports no storage provider", () => {
    for (const file of PREPARATION_FILES) {
      const source = code(file);
      for (const forbidden of [
        "@aws-sdk", "S3Client", "putObject", "getObject", "presign", "@lagda/storage",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no artifact", () => {
    // A metadata-only model: no derived prepared PDF. If one is ever needed it
    // gets a new ArtifactId through the approved boundary (§16).
    for (const file of [USE_CASES, REPOSITORY, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes an artifact`)
        .not.toMatch(/artifacts\.insert|document_artifacts/);
    }
  });

  it("handles no storage key or digest", () => {
    for (const file of [USE_CASES, ROUTES, REPOSITORY]) {
      const source = code(file);
      expect(source).not.toContain("storageReference");
      expect(source).not.toContain("digest");
    }
  });
});

// ── 2. Preparation is not a signing request ──────────────────────────────────

describe("preparation is not a signing request", () => {
  it("stores no signing state and no submitted value", () => {
    const migration = code(MIGRATION);
    for (const column of [
      "sent_at", "expires_at", "completed_at", "declined_at", "signed_at",
      "recipient_id", "signing_status", "signature_value", "submitted_value",
    ]) {
      expect(migration, `preparation stores ${column}`).not.toContain(column);
    }
    // A bare `value` COLUMN, matched at a column position rather than as a
    // substring: the SQL `values` keyword appears throughout, and a guard that
    // could not tell the two apart would fail on correct code.
    expect(migration, "preparation stores a value column")
      .not.toMatch(/^\s+value\s+(varchar|text|jsonb|integer|boolean)/m);
  });

  it("uses no signing vocabulary anywhere in the domain", () => {
    for (const file of PREPARATION_FILES) {
      const source = code(file);
      for (const status of [
        '"sent"', '"completed"', '"declined"', '"awaiting-signature"', '"voided"',
      ]) {
        expect(source, `${path.basename(file)} uses ${status}`).not.toContain(status);
      }
    }
  });

  it("has exactly two states, neither of them a signing status", () => {
    const contracts = code(CONTRACTS);
    expect(contracts).toMatch(/PREPARATION_STATES = \["editable", "locked"\]/);
  });

  it("writes no signing evidence", () => {
    for (const file of [USE_CASES, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }
  });

  it("references no contact and no template", () => {
    // ── Narrowed by BACKEND-31, deliberately ────────────────────────────────
    //
    // This forbade `RecipientId` too, because in BACKEND-30 no recipient
    // existed and an editor slot label was the most a field could carry. A
    // field now names a real recipient, so that clause would fail on correct
    // code.
    //
    // What it still forbids is the boundary that MATTERS and has not moved:
    // preparation never reads the address book. A contact becomes a recipient
    // once, in `addRecipient`, and the layout works from the recipient - so a
    // later "look the signer up in contacts" fails here before review.
    for (const file of PREPARATION_FILES) {
      const source = code(file);
      for (const forbidden of ["ContactId", "uow.contacts", "TemplateId"]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });
});

// ── 3. The coordinate model ──────────────────────────────────────────────────

describe("one canonical coordinate model", () => {
  it("declares no second origin or unit convention", () => {
    // BACKEND-09 fixed it: normalized 0–1, top-left, 1-based pages. A second
    // model is how a signature lands in the wrong half of a page while every
    // byte-level assertion still passes.
    const contracts = code(CONTRACTS);
    expect(contracts).not.toMatch(/bottom-?left/i);
    expect(contracts).not.toMatch(/\bpixels?\b/i);
    expect(contracts).not.toMatch(/\bpoints\b/i);
  });

  it("uses 1-based page numbers, never a 0-based index", () => {
    for (const file of [CONTRACTS, CORE, PORTS, ROUTES]) {
      const source = code(file);
      expect(source, `${path.basename(file)} uses pageIndex`).not.toContain("pageIndex");
      expect(source, `${path.basename(file)} uses page_index`).not.toContain("page_index");
    }
    expect(code(MIGRATION)).toContain("page_number");
    expect(code(MIGRATION)).not.toContain("page_index");
  });

  it("bounds pages at 1 in the schema and the database", () => {
    expect(code(CONTRACTS)).toMatch(/pageNumber: Type\.Integer\(\{ minimum: 1 \}\)/);
    expect(code(MIGRATION)).toContain("page_number >= 1");
  });

  it("enforces geometry at the database as well as the domain", () => {
    const migration = code(MIGRATION);
    expect(migration).toContain("width > 0 and height > 0");
    // Only expressible as a CHECK because the coordinates are normalized.
    expect(migration).toContain("x + width <= 1");
    expect(migration).toContain("y + height <= 1");
  });

  it("centralizes rounding in one place", () => {
    // §164 — the frontend and backend must not round differently.
    expect(code(CORE)).toContain("COORDINATE_PRECISION");
    for (const file of [USE_CASES, ROUTES, REPOSITORY]) {
      expect(code(file), `${path.basename(file)} rounds independently`)
        .not.toMatch(/toFixed\(|Math\.round\(/);
    }
  });
});

// ── 4. Field types ───────────────────────────────────────────────────────────

describe("field types are the product's, and all renderable", () => {
  it("every preparation type maps onto a type the sealer knows", () => {
    // The guarantee that a placed field can actually appear on a signed PDF.
    for (const type of PREPARATION_FIELD_TYPES) {
      expect(SEALABLE_FIELD_TYPES as readonly string[])
        .toContain(renderTypeFor(type));
    }
  });

  it("excludes the editor types with no renderer", () => {
    for (const absent of [
      "radio-group", "multiline-text", "acknowledgment", "sender-text", "dropdown",
    ]) {
      expect(PREPARATION_FIELD_TYPES as readonly string[]).not.toContain(absent);
    }
  });

  it("constrains the type at the database too", () => {
    const migration = code(MIGRATION);
    for (const type of PREPARATION_FIELD_TYPES) {
      expect(migration, `migration omits ${type}`).toContain(`"${type}"`);
    }
    expect(migration).toContain("field_type in (");
  });

  it("uses no generic configuration bag", () => {
    // §83 — explicit typed columns, not an arbitrary JSON blob a client fills.
    const migration = code(MIGRATION);
    for (const forbidden of ["jsonb", "json", "config", "metadata", "properties"]) {
      expect(migration, `migration stores a ${forbidden} column`)
        .not.toMatch(new RegExp(`\\b${forbidden}\\b`, "i"));
    }
  });
});

// ── 5. Tenancy ───────────────────────────────────────────────────────────────

describe("preparation is workspace-owned", () => {
  it("has FORCE RLS and tenant isolation on both tables", () => {
    const migration = read(MIGRATION);
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("create policy tenant_isolation");
    expect(migration).toContain("using (workspace_id = lagda_current_workspace())");
    expect(migration).toContain("with check (workspace_id = lagda_current_workspace())");
  });

  it("uses COMPOUND foreign keys to the document, artifact and preparation", () => {
    // Whitespace collapsed so the assertion is a plain substring rather than a
    // regex. The migration wraps these clauses across lines, and a pattern with
    // escaped parentheses and `[\s\S]` spans is harder to read than the thing
    // it is checking.
    const migration = read(MIGRATION).replace(/\s+/g, " ");
    const references: readonly (readonly [string, string])[] = [
      ["(workspace_id, document_id)", "documents (workspace_id, document_id)"],
      ["(workspace_id, source_artifact_id)",
        "document_artifacts (workspace_id, artifact_id)"],
      ["(workspace_id, preparation_id)",
        "document_preparations (workspace_id, preparation_id)"],
    ];
    for (const [columns, target] of references) {
      expect(migration, `missing compound FK ${columns} -> ${target}`)
        .toContain(`foreign key ${columns} references ${target}`);
    }
  });

  it("enforces one preparation per document", () => {
    expect(read(MIGRATION)).toContain("unique (workspace_id, document_id)");
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

  it("cascades ONLY from preparation to its fields", () => {
    const migration = read(MIGRATION);
    const cascades = migration.match(/on delete cascade/g) ?? [];
    // Exactly one, and it is the fields. Everything else in this schema is
    // RESTRICT because it protects a record something else references.
    expect(cascades).toHaveLength(1);
    expect(migration).not.toContain("on delete set null");
  });
});

// ── 6. Capabilities ──────────────────────────────────────────────────────────

describe("preparation capabilities", () => {
  it("names capabilities, never a role", () => {
    const source = code(USE_CASES);
    expect(source).toContain('"document.prepare"');
    expect(source).toContain('"document.view"');
    expect(source).toContain("assertCapability");
  });

  it("gates writes on document.prepare and reads on document.view", () => {
    const source = code(USE_CASES);
    // Reading a layout is part of reading the document.
    expect(source).toMatch(/getDocumentPreparation[\s\S]{0,600}"document\.view"/);
    expect(source).toMatch(/saveDocumentPreparation[\s\S]{0,900}"document\.prepare"/);
  });

  it("is held by the four roles with the product's prepare_documents", () => {
    const preparers = WORKSPACE_ROLES.filter(
      role => capabilitiesFor(role).includes("document.prepare"));
    expect([...preparers].sort()).toEqual([
      "administrator", "owner", "sender", "template_administrator",
    ]);
  });

  it("never grants prepare without view", () => {
    for (const role of WORKSPACE_ROLES) {
      const held = capabilitiesFor(role);
      if (held.includes("document.prepare")) {
        expect(held, `${role} may prepare but not view`).toContain("document.view");
      }
    }
  });

  it("appears identically in core and contracts", () => {
    expect([...WORKSPACE_CAPABILITY_NAMES].sort())
      .toEqual([...WORKSPACE_CAPABILITIES].sort());
  });

  it("declares no capability for an operation that does not exist", () => {
    for (const absent of [
      "preparation.lock", "preparation.freeze", "document.send", "document.sign",
    ]) {
      expect(WORKSPACE_CAPABILITIES as readonly string[]).not.toContain(absent);
    }
  });
});

// ── 7. Telemetry ─────────────────────────────────────────────────────────────

describe("layouts and labels stay out of telemetry", () => {
  it("the log payload carries counts, never geometry or labels", () => {
    const routes = code(ROUTES);
    const payload = /request\.log\.info\(\{([\s\S]*?)\}, "document\.preparation\.saved"\)/
      .exec(routes);
    expect(payload).not.toBeNull();
    const body = payload?.[1] ?? "";
    for (const forbidden of ["label", "rect", "\\bx\\b", "\\by\\b", "recipientId", "fields:"]) {
      expect(body, `the log payload contains ${forbidden}`)
        .not.toMatch(new RegExp(forbidden));
    }
    expect(body).toContain("fieldCount");
  });

  it("the metric labels are a closed set with no identifier or count", () => {
    const routes = code(ROUTES);
    const metric =
      /increment\("document_preparation_operations_total",\s*\{([\s\S]*?)\}\)/.exec(routes);
    expect(metric).not.toBeNull();
    const labels = metric?.[1] ?? "";
    for (const forbidden of [
      "documentId", "preparationId", "workspaceId", "fieldId", "fieldCount",
    ]) {
      expect(labels, `metric label ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("marks every response no-store", () => {
    const routes = code(ROUTES);
    const handlers = (routes.match(/app\.(get|put|post|patch)\(/g) ?? []).length;
    const noStore = (routes.match(/noStore\(reply\);/g) ?? []).length;
    expect(noStore).toBe(handlers);
  });
});

// ── 8. Hygiene ───────────────────────────────────────────────────────────────

describe("preparation code hygiene", () => {
  it("routes import no database or query builder", () => {
    const routes = code(ROUTES);
    for (const forbidden of ["@lagda/db", "kysely", "selectFrom", "insertInto"]) {
      expect(routes, `routes import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("contains no `any`", () => {
    for (const file of PREPARATION_FILES) {
      expect(code(file), `${path.basename(file)} uses any`)
        .not.toMatch(/\bas any\b|:\s*any\b/);
    }
  });

  it("has no generic setStatus", () => {
    for (const file of [PORTS, REPOSITORY, USE_CASES]) {
      expect(code(file)).not.toMatch(/setStatus|setState\(/);
    }
  });

  it("carries no unresolved TODO", () => {
    for (const file of PREPARATION_FILES) {
      expect(read(file), `${path.basename(file)} has a TODO`)
        .not.toMatch(/TODO|FIXME|XXX/);
    }
  });
});

it("guards every file in the preparation domain", () => {
  const dirs = [
    path.join(PACKAGES, "application", "src", "preparation"),
    path.join(PACKAGES, "api", "src", "preparation"),
    path.join(PACKAGES, "core", "src", "preparation"),
    path.join(PACKAGES, "contracts", "src", "preparation"),
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
  const guarded = new Set(PREPARATION_FILES.map(f => path.resolve(f)));
  expect(found.filter(f => !guarded.has(path.resolve(f))).map(f => path.relative(ROOT, f)))
    .toEqual([]);
});
