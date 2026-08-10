// Signature submission architecture guards.
//
// Five claims, in order of how expensive being wrong would be:
//
//   1. An accepted value cannot be changed — no update path exists at any
//      layer, and the runtime role holds no privilege that could.
//   2. Server-owned values come from the backend; the contract has no member
//      a client could use to supply one.
//   3. Nothing about the workflow moves, and no PDF is touched.
//   4. Signature content, field values and PII stay out of telemetry.
//   5. The realm is the recipient's, not a workspace member's.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES, FIELD_INPUT_POLICY } from "@lagda/core";
import { IDEMPOTENT_OPERATIONS } from "@lagda/application";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const sqlOf = (file: string): string => code(file).replace(/^\s*--.*$/gm, "");

const USE_CASE = path.join(
  PACKAGES, "application", "src", "signing-submission", "signing-submission.ts");
const PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "signing-submission.ts");
const REPOSITORY = path.join(
  PACKAGES, "db", "src", "repositories", "signing-submission.ts");
const ROUTES = path.join(
  PACKAGES, "api", "src", "signing-submission", "signing-submission-routes.ts");
const CORE = path.join(PACKAGES, "core", "src", "signing", "submission.ts");
const CONTRACT = path.join(
  PACKAGES, "contracts", "src", "signing-submission", "index.ts");
const VALIDATOR = path.join(PACKAGES, "api", "src", "security", "signature-image.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "023_signature_submission.ts");

const FILES = [USE_CASE, PORTS, REPOSITORY, ROUTES, CORE, CONTRACT, VALIDATOR];

// ── 1. Immutability ──────────────────────────────────────────────────────────

describe("accepted values cannot be changed", () => {
  it("declares no update or delete method on the repository", () => {
    const ports = code(PORTS);
    for (const bad of [
      "updateFieldValue", "deleteFieldValue", "updateSubmission",
      "deleteSubmission", "amend", "replaceValue",
    ]) {
      expect(ports, `ports declare ${bad}`).not.toContain(bad);
    }
    // Two methods, and both are named here so adding a third is a decision.
    expect(ports).toContain("findAccepted()");
    expect(ports).toContain("create(submission: NewRecipientSubmission)");
  });

  it("issues no UPDATE or DELETE statement in the repository", () => {
    const repository = code(REPOSITORY);
    expect(repository).not.toContain(".updateTable(");
    expect(repository).not.toContain(".deleteFrom(");
    expect(repository).not.toContain(".onConflict(");
  });

  it("grants no UPDATE or DELETE on any submission table", () => {
    const migration = sqlOf(MIGRATION);
    // The grant is issued in a loop over the three tables, so the literal
    // table name never appears beside `grant` in source. Assert the templated
    // form and the loop's membership separately.
    expect(migration).toContain("grant select, insert on table ${sql.raw(table)}");
    for (const table of [
      "recipient_submissions", "signing_representations", "signing_field_values",
    ]) {
      expect(migration, `${table} is not in the grant loop`).toContain(`"${table}",`);
    }
    expect(migration).not.toMatch(/grant[^;`]*update/);
    expect(migration).not.toMatch(/grant[^;`]*delete/);
  });

  it("enforces one accepted submission per recipient in the database", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("recipient_submissions_one_per_recipient");
    expect(migration).toMatch(
      /unique \(workspace_id, signing_request_id, request_recipient_id\)/);
  });

  it("enforces one value per field in the database", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("signing_field_values_one_per_field");
    expect(migration).toMatch(
      /unique \(workspace_id, signing_request_id, request_field_id\)/);
  });

  it("binds every value to a field ASSIGNMENT, not merely a field", () => {
    // The four-column key is what makes another recipient's field have no
    // referent rather than merely failing a check.
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("signing_request_fields_assignment_key");
    expect(migration).toContain("signing_field_values_assignment_fk");
    expect(migration).toMatch(
      /references signing_request_fields\s*\(workspace_id, signing_request_id, request_field_id,\s*request_recipient_id\)/);
  });
});

// ── 2. Server-owned values ───────────────────────────────────────────────────

describe("server-owned values are not client-supplied", () => {
  it("gives the contract no member for a server-derived type", () => {
    const contract = code(CONTRACT);
    for (const bad of [
      '"date-signed"', "dateSigned", "signedAt", '"full-name"', "fullName",
    ]) {
      expect(contract, `the body schema mentions ${bad}`).not.toContain(bad);
    }
  });

  it("refuses the fields §193 lists", () => {
    // The BODY only. `acceptedAt` legitimately appears in the RESPONSE, which
    // is the server telling the client when it accepted — the opposite
    // direction from the one §193 is about.
    const whole = code(CONTRACT);
    const contract = whole.slice(
      whole.indexOf("export const SubmitSigningBodySchema"),
      whole.indexOf("export const SubmitSigningResponseSchema"));
    for (const forbidden of [
      "recipientId", "workspaceId", "signingRequestId", "acceptedAt",
      "authenticationMethod", "consentAccepted", "userAgent", "artifactId",
      "requestState", "pageNumber",
    ]) {
      expect(contract, `the body schema accepts ${forbidden}`)
        .not.toContain(`${forbidden}:`);
    }
    expect(contract).toContain("additionalProperties: false");
  });

  it("derives the three server-owned types in core, from backend state", () => {
    const core = code(CORE);
    expect(core).toContain('case "date-signed":');
    expect(core).toContain("input.acceptedAt");
    expect(core).toContain("input.recipient.name");
    expect(core).toContain("input.recipient.email");
    // And rejects a client value for one rather than ignoring it.
    expect(core).toContain("field-server-owned");
  });

  it("agrees with the BACKEND-35 policy about which types are server-owned", () => {
    // Two commands, one list. If either changes alone this fails.
    const serverOwned = Object.entries(FIELD_INPUT_POLICY)
      .filter(([, policy]) => policy.authority === "SERVER_DERIVED")
      .map(([type]) => type)
      .sort();
    expect(serverOwned).toEqual(["date-signed", "email", "full-name"]);
  });
});

// ── 3. Boundaries ────────────────────────────────────────────────────────────

describe("submission touches no PDF and no workflow state", () => {
  it("invokes no sealer and no PDF library", () => {
    for (const file of FILES) {
      const source = code(file);
      for (const bad of [
        "DocumentSealer", "documentSealer", "sealDocument", "pdf-lib",
        "PDFDocument", "mergeFields", "flatten",
      ]) {
        expect(source, `${path.basename(file)} names ${bad}`).not.toContain(bad);
      }
    }
  });

  it("advances no routing and completes nothing", () => {
    for (const file of FILES) {
      const source = code(file);
      for (const bad of [
        "activateNext", "advanceRouting", "planActivation", "markSigned",
        "setRecipientStatus", "markCompleted", "insertActivations",
        "provisionSigningRecipientAccess", "insertDeliveryIntent",
      ]) {
        expect(source, `${path.basename(file)} names ${bad}`).not.toContain(bad);
      }
    }
  });

  it("writes only the three submission tables", () => {
    const repository = code(REPOSITORY);
    const inserts = (repository.match(/\.insertInto\("([a-z_]+)"\)/g) ?? []).sort();
    expect(inserts).toEqual([
      '.insertInto("recipient_submissions")',
      '.insertInto("signing_field_values")',
      '.insertInto("signing_representations")',
    ]);
  });

  it("adds no state column to any existing table", () => {
    const migration = sqlOf(MIGRATION);
    // The only ALTER is the assignment key. A state column smuggled in here
    // would be BACKEND-37's work done early and untested.
    const alters = migration.match(/alter table (\w+)/g) ?? [];
    expect(new Set(alters)).toEqual(new Set(["alter table signing_request_fields"]));
    expect(migration).not.toContain("add column");
  });
});

// ── 4. Telemetry ─────────────────────────────────────────────────────────────

describe("telemetry carries no signing content", () => {
  it("logs no field value, signature payload or recipient PII", () => {
    const routes = code(ROUTES);
    const payloads = routes.match(/request\.log\.\w+\(\{[\s\S]*?\}/g) ?? [];
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      for (const bad of [
        "fieldValues", "signature", "initials", "base64", "text",
        "recipient.email", "recipient.name", "typedText", "digest", "body",
      ]) {
        expect(payload, `a log payload carries ${bad}`).not.toContain(bad);
      }
    }
  });

  it("bounds the metric labels", () => {
    const routes = code(ROUTES);
    const calls = routes.match(/increment\("[a-z_]+", \{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const bad of [
        "signingRequestId", "recipientId", "submissionId", "fieldId",
        "digest", "ip", "email",
      ]) {
        expect(call, `a metric label carries ${bad}`).not.toContain(bad);
      }
    }
  });

  it("returns no signature data, storage key or evidence internals", () => {
    const contract = code(CONTRACT);
    const response = contract.slice(contract.indexOf("SubmitSigningResponseSchema"));
    for (const bad of [
      "base64", "rasterBytes", "storageReference", "digest", "userAgent",
      "ipAddress", "sessionId",
    ]) {
      expect(response, `the response carries ${bad}`).not.toContain(bad);
    }
  });

  it("keeps the rejection reason a closed set", () => {
    const routes = code(ROUTES);
    const reason = routes.slice(routes.indexOf("function reasonOf"));
    // No interpolation, no message, no field id — only literals.
    expect(reason).not.toContain("${");
    expect(reason).not.toContain(".message");
    expect(reason).not.toContain("fieldId");
  });
});

// ── 5. Realm and shape ───────────────────────────────────────────────────────

describe("the recipient realm and the value model", () => {
  it("names no workspace authorization symbol or capability", () => {
    for (const file of FILES) {
      const source = code(file);
      for (const symbol of [
        "WorkspaceAccessContext", "WorkspaceMembership", "WorkspaceRole",
        "requireCapability", "AuthenticatedActor", "requireSession",
      ]) {
        expect(source, `${path.basename(file)} names ${symbol}`).not.toContain(symbol);
      }
      for (const capability of WORKSPACE_CAPABILITIES) {
        expect(source, `${path.basename(file)} names ${capability}`)
          .not.toContain(capability);
      }
    }
  });

  it("requires recipient CSRF and an idempotency key", () => {
    const routes = code(ROUTES);
    expect(routes).toContain("validateRecipientCsrf");
    expect(routes).toContain("IDEMPOTENCY_KEY_REQUIRED");
    expect(routes).toContain("RECIPIENT_CSRF_REQUIRED");
    expect(routes).not.toContain("validateCsrf(");
  });

  it("uses the canonical idempotent operation name", () => {
    // `signature.submit` was declared by BACKEND-14 from the handoff. Inventing
    // a second name would split one namespace across two.
    expect(IDEMPOTENT_OPERATIONS).toContain("signature.submit");
    expect(code(USE_CASE)).toContain('operation: "signature.submit"');
  });

  it("scopes idempotency to the recipient, not the workspace", () => {
    const useCase = code(USE_CASE);
    expect(useCase).toContain('type: "recipient"');
    expect(useCase).not.toContain('type: "workspace"');
  });

  it("accepts no untyped value anywhere in the submission path", () => {
    for (const file of FILES) {
      const source = code(file);
      expect(source, `${path.basename(file)} uses \`any\``)
        .not.toMatch(/\bas any\b|:\s*any\b/);
    }
  });

  it("accepts only PNG for a drawn signature, and refuses SVG", () => {
    const validator = code(VALIDATOR);
    expect(validator).toContain("PNG_MAGIC");
    expect(validator).toContain('mediaType: "image/png"');
    for (const format of ["image/svg", "image/jpeg", "image/webp", "application/pdf"]) {
      expect(validator, `the validator accepts ${format}`).not.toContain(format);
    }
  });

  it("bounds the raster in the database as well as the validator", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("octet_length(raster_bytes)");
    expect(migration).toContain("signing_representations_raster_bounds");
  });

  it("versions every representation type", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("TYPED_SIGNATURE_V1");
    expect(migration).toContain("RASTER_SIGNATURE_V1");
    // No upload member: the product has no upload path.
    expect(migration).not.toContain("UPLOADED_SIGNATURE");
  });

  it("stores no legal text and no raw data URL", () => {
    const migration = sqlOf(MIGRATION);
    for (const bad of ["data_url", "dataUrl", "signature_text_blob"]) {
      expect(migration).not.toContain(bad);
    }
  });
});
