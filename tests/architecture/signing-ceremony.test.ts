// Signing ceremony architecture guards.
//
// Six claims, in order of how expensive being wrong would be:
//
//   1. The ceremony reads the IMMUTABLE snapshot and the exact source
//      artifact — never a contact, a preparation, or a current artifact.
//   2. A recipient sees only their own fields, and the type system is what
//      makes the alternative unexpressible.
//   3. The recipient realm never becomes the workspace realm.
//   4. Nothing is signed, sealed, completed or advanced.
//   5. Storage keys, PDF bytes, PII, field layouts and consent text stay out
//      of telemetry.
//   6. The scope policies are RESTRICTIVE, because a permissive one would
//      widen instead of narrow.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES, PREPARATION_FIELD_TYPES } from "@lagda/core";
import { FIELD_INPUT_POLICY, CEREMONY_SIGNABLE_REQUEST_STATES } from "@lagda/core";

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
  PACKAGES, "application", "src", "signing-ceremony", "signing-ceremony.ts");
const PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "signing-ceremony.ts");
const REPOSITORY = path.join(
  PACKAGES, "db", "src", "repositories", "signing-ceremony.ts");
const ROUTES = path.join(
  PACKAGES, "api", "src", "signing-ceremony", "signing-ceremony-routes.ts");
const CORE = path.join(PACKAGES, "core", "src", "signing", "ceremony.ts");
const POLICY = path.join(PACKAGES, "core", "src", "signing", "field-input-policy.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "022_signing_ceremony.ts");

const CEREMONY_FILES = [USE_CASE, PORTS, REPOSITORY, ROUTES, CORE, POLICY];

// ── 1. Immutable snapshot only ───────────────────────────────────────────────

describe("the ceremony reads only immutable request state", () => {
  it("never names a mutable authoring table or repository", () => {
    // The tables whose whole purpose is to be edited while authoring. A
    // ceremony that reads any of them stops being a snapshot of what was sent.
    const forbidden = [
      "contacts", "preparation_recipients", "preparation_fields",
      "document_preparations",
      "uow.contacts", "uow.preparations", "uow.documents", "uow.recipients",
      "ScopedContactRepository", "ScopedPreparationRepository",
      "ScopedDocumentRepository",
    ];
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const name of forbidden) {
        expect(source, `${path.basename(file)} names ${name}`).not.toContain(name);
      }
    }
  });

  it("resolves the artifact by joining FROM the request", () => {
    // The join key is `source_artifact_id`, so the query cannot return the
    // document's current artifact. A `where artifact_id = <argument>` would.
    const repository = code(REPOSITORY);
    expect(repository).toContain("r.source_artifact_id");
    expect(repository).toContain("getSourceArtifact()");
  });

  it("gives getSourceArtifact no artifact parameter", () => {
    // A method that TAKES an artifact id is a method that can be handed the
    // wrong one. The absence of the parameter is the control.
    const ports = code(PORTS);
    expect(ports).toContain("getSourceArtifact(): Promise<CeremonyArtifactRecord | null>");
    expect(ports).not.toContain("getSourceArtifact(artifactId");
  });

  it("never looks up a document's current artifact", () => {
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const name of ["currentArtifact", "latestArtifact", "findCurrentArtifact"]) {
        expect(source, `${path.basename(file)} names ${name}`).not.toContain(name);
      }
    }
  });
});

// ── 2. Recipient-scoped fields ───────────────────────────────────────────────

describe("a recipient receives only their own fields", () => {
  it("gives the read methods no identifying parameters", () => {
    const ports = code(PORTS);
    for (const method of [
      "getRequest(): Promise<", "getRecipient(): Promise<",
      "listAssignedFields(): Promise<", "getProgress(): Promise<",
      "listConsents(): Promise<",
    ]) {
      expect(ports, `${method} takes an argument`).toContain(method);
    }
    // The shapes that would let a caller choose.
    for (const bad of [
      "listFields(recipientId", "getRecipient(recipientId",
      "getRequest(signingRequestId", "listAllRecipients", "listRecipients(",
    ]) {
      expect(ports).not.toContain(bad);
    }
  });

  it("filters fields on the bound recipient in the repository", () => {
    const repository = code(REPOSITORY);
    expect(repository).toContain('.where("request_recipient_id", "=", recipientId)');
  });

  it("never resolves a recipient by email", () => {
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      // Narrowed during the run: `normalized_email` is a legitimate column
      // MAPPING in the repository - the snapshot row carries it and the record
      // type declares it. What must not exist is a lookup BY it.
      for (const bad of [
        "findByEmail", "byNormalizedEmail", "whereEmail",
        '.where("normalized_email"', '.where("email"',
      ]) {
        expect(source, `${path.basename(file)} matches on ${bad}`).not.toContain(bad);
      }
    }
  });

  it("has no route parameter a client could use to name a request", () => {
    // Not `:requestId`, not `:recipientId`, not a query. The session is the
    // only source of identity, so there is nothing to compare or to trust.
    const routes = code(ROUTES);
    expect(routes).not.toMatch(/["'`][^"'`]*:requestId/);
    expect(routes).not.toMatch(/["'`][^"'`]*:recipientId/);
    expect(routes).not.toContain("request.query");
  });
});

// ── 3. Realm separation ──────────────────────────────────────────────────────

describe("the recipient realm never becomes the workspace realm", () => {
  it("names no workspace authorization symbol", () => {
    const forbidden = [
      "WorkspaceAccessContext", "WorkspaceMembership", "WorkspaceRole",
      "requireCapability", "assertCapability", "WorkspaceMemberId",
      "requireSession", "AuthenticatedActor",
    ];
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const symbol of forbidden) {
        expect(source, `${path.basename(file)} names ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it("names no workspace capability", () => {
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const capability of WORKSPACE_CAPABILITIES) {
        expect(source, `${path.basename(file)} names ${capability}`)
          .not.toContain(capability);
      }
    }
  });

  it("never looks for a LAGDA account behind the recipient", () => {
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const bad of ["findUser", "uow.users", "UserId", "userRepository"]) {
        // `createdByUserId` is a snapshot COLUMN, not a lookup - the repository
        // maps it and nothing reads it. Allowed only there.
        if (file === REPOSITORY && bad === "UserId") continue;
        expect(source, `${path.basename(file)} names ${bad}`).not.toContain(bad);
      }
    }
  });

  it("uses the recipient cookie names and no others", () => {
    const routes = code(ROUTES);
    expect(routes).toContain("RECIPIENT_SESSION_COOKIE_NAME");
    expect(routes).toContain("RECIPIENT_CSRF_COOKIE_NAME");
    // Narrowed during the run: `RECIPIENT_SESSION_COOKIE_NAME` CONTAINS the
    // substring `SESSION_COOKIE_NAME`, so the obvious guard fails on the
    // correct import. Assert on the workspace realm's cookie VALUES instead,
    // which share no substring with the recipient ones.
    for (const other of ["lagda_session", "lagda_csrf", "lagda_pre_auth"]) {
      expect(routes, `routes name the workspace cookie ${other}`)
        .not.toContain(`"${other}"`);
    }
    expect(routes).not.toContain("PRE_AUTH_COOKIE_NAME");
  });

  it("validates CSRF through the recipient validator only", () => {
    const routes = code(ROUTES);
    expect(routes).toContain("validateRecipientCsrf");
    // The workspace realm's validator must not appear.
    expect(routes).not.toContain("validateCsrf(");
  });

  it("returns the recipient realm's own 401 code", () => {
    const routes = code(ROUTES);
    expect(routes).toContain("RECIPIENT_AUTHENTICATION_REQUIRED");
    expect(routes).not.toContain('code: "AUTHENTICATION_REQUIRED"');
  });
});

// ── 4. No signing side effects ───────────────────────────────────────────────

describe("the ceremony changes nothing about the signing act", () => {
  it("invokes no sealer and no PDF library", () => {
    const forbidden = [
      "DocumentSealer", "documentSealer", "sealDocument", "pdf-lib",
      "PDFDocument", "flatten", "stampField", "mergeFields",
    ];
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const name of forbidden) {
        expect(source, `${path.basename(file)} names ${name}`).not.toContain(name);
      }
    }
  });

  it("persists no signature or field value", () => {
    const forbidden = [
      "signature_values", "field_values", "signing_field_values",
      "signatureData", "drawnDataUrl", "typedSignature", "adoptSignature",
    ];
    for (const file of [...CEREMONY_FILES, MIGRATION]) {
      const source = code(file);
      for (const name of forbidden) {
        expect(source, `${path.basename(file)} names ${name}`).not.toContain(name);
      }
    }
  });

  it("sets no recipient completion state and advances no routing", () => {
    const forbidden = [
      "setRecipientStatus", "markSigned", "markCompleted", "completeRecipient",
      "activateNext", "advanceRouting", "planActivation",
    ];
    for (const file of CEREMONY_FILES) {
      const source = code(file);
      for (const name of forbidden) {
        expect(source, `${path.basename(file)} names ${name}`).not.toContain(name);
      }
    }
  });

  it("writes only to the two ceremony tables", () => {
    // The repository is the only writer, and it has exactly two inserts.
    const repository = code(REPOSITORY);
    const inserts = repository.match(/\.insertInto\("([a-z_]+)"\)/g) ?? [];
    expect(inserts.sort()).toEqual([
      '.insertInto("signing_recipient_consents")',
      '.insertInto("signing_recipient_progress")',
    ]);
    // No UPDATE and no DELETE anywhere in the ceremony's data path.
    expect(repository).not.toContain(".updateTable(");
    expect(repository).not.toContain(".deleteFrom(");
  });

  it("grants no UPDATE or DELETE on either ceremony table", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain(
      "grant select, insert on table signing_recipient_progress");
    expect(migration).toContain(
      "grant select, insert on table signing_recipient_consents");
    expect(migration).not.toMatch(/grant[^;]*update[^;]*signing_recipient/);
    expect(migration).not.toMatch(/grant[^;]*delete[^;]*signing_recipient/);
  });

  it("stores a consent VERSION and never legal text", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("consent_version");
    for (const bad of [
      "consent_text", "disclosure_text", "consent_body", "legal_text",
    ]) {
      expect(migration).not.toContain(bad);
    }
  });
});

// ── 5. Telemetry ─────────────────────────────────────────────────────────────

describe("telemetry carries no content, layout, PII or credentials", () => {
  it("logs no recipient name, email, title, geometry or consent text", () => {
    const routes = code(ROUTES);
    const logged = routes.match(/request\.log\.\w+\(\{[\s\S]*?\}/g) ?? [];
    expect(logged.length).toBeGreaterThan(0);
    for (const payload of logged) {
      for (const bad of [
        "recipient.name", "recipient.email", "documentTitle", "maskedEmail",
        "fields", "label", "storageReference", "digest", "consentText",
        "x:", "y:", "pageNumber",
      ]) {
        expect(payload, `a log payload carries ${bad}`).not.toContain(bad);
      }
    }
  });

  it("never puts a storage key in a header or a body", () => {
    const routes = code(ROUTES);
    expect(routes).not.toContain("storageReference");
    expect(routes).not.toContain("X-Storage");
    expect(routes).not.toContain("bucket");
  });

  it("keeps the storage key out of every response shape", () => {
    // The use case returns a stream and three metadata values. If
    // `storageReference` ever joined `RecipientDocumentStream`, a route could
    // serialize it by accident.
    const useCase = code(USE_CASE);
    // Both markers are CODE. `code()` strips comments, so a comment marker
    // makes indexOf return -1 and the slice silently take the whole file -
    // the trap BACKEND-34's suite hit and recorded.
    const streamShape = useCase.slice(
      useCase.indexOf("export interface RecipientDocumentStream"),
      useCase.indexOf("export interface CeremonyConsentPolicy"));
    expect(streamShape).not.toContain("storageReference");
    const view = useCase.slice(
      useCase.indexOf("export interface SigningCeremonyView"),
      useCase.indexOf("export interface RecipientDocumentStream"));
    expect(view).not.toContain("storageReference");
    expect(view).not.toContain("sessionId");
    expect(view).not.toContain("grantId");
  });

  it("bounds the metric labels", () => {
    const routes = code(ROUTES);
    const labels = routes.match(/increment\("[a-z_]+", \{[\s\S]*?\}\)/g) ?? [];
    expect(labels.length).toBeGreaterThan(0);
    for (const call of labels) {
      for (const bad of ["signingRequestId", "recipientId", "workspaceId", "ip"]) {
        expect(call, `a metric label carries ${bad}`).not.toContain(bad);
      }
    }
  });

  it("marks the document response private and non-cacheable", () => {
    const routes = code(ROUTES);
    expect(routes).toContain('"Cache-Control", "private, no-store"');
    expect(routes).toContain('"Content-Disposition", "inline"');
  });
});

// ── 6. The restrictive policies ──────────────────────────────────────────────

describe("the recipient scope policies restrict rather than widen", () => {
  it("declares every ceremony scope policy as restrictive", () => {
    const migration = sqlOf(MIGRATION);
    // PostgreSQL ORs permissive policies. A permissive policy beside
    // `tenant_isolation` would grant MORE, not less - the exact mistake this
    // asserts against.
    // Every declaration must be followed by `as restrictive`. Counting is the
    // check: one `create policy` without one would break the equality.
    const declarations =
      (migration.match(/create policy recipient_ceremony_scope/g) ?? []).length;
    const restrictive =
      (migration.match(/create policy recipient_ceremony_scope[^;]*?as restrictive/g) ?? []).length;
    expect(declarations).toBeGreaterThan(0);
    expect(restrictive).toBe(declarations);
  });

  it("fails closed when no recipient session setting is present", () => {
    const migration = sqlOf(MIGRATION);
    // The predicate is built from a TS constant, so the SOURCE reads
    // `${RECIPIENT_SESSION_DIGEST_FN} is null`. Assert on both halves: the
    // constant holds the function, and the predicate opens with `is null`.
    expect(migration).toContain(
      'const RECIPIENT_SESSION_DIGEST_FN = "lagda_current_recipient_session_digest()"');
    expect(migration).toContain("${RECIPIENT_SESSION_DIGEST_FN} is null");
  });

  it("adds no BYPASSRLS and no SUPERUSER", () => {
    const migration = code(MIGRATION);
    for (const forbidden of ["BYPASSRLS", "SUPERUSER", "bypassrls", "superuser"]) {
      expect(migration).not.toContain(forbidden);
    }
  });

  it("forces row level security on both new tables", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("force row level security");
  });
});

// ── 7. Policy completeness ───────────────────────────────────────────────────

describe("the field input policy covers the vocabulary", () => {
  it("has an entry for every field type the snapshot can hold", () => {
    for (const type of PREPARATION_FIELD_TYPES) {
      expect(FIELD_INPUT_POLICY[type], `no policy for ${type}`).toBeDefined();
    }
    expect(Object.keys(FIELD_INPUT_POLICY).sort())
      .toEqual([...PREPARATION_FIELD_TYPES].sort());
  });

  it("marks date-signed, full-name and email as server-derived", () => {
    // The three a client must never be trusted to supply. BACKEND-36 rejects
    // rather than ignores, and this is where that list is fixed.
    expect(FIELD_INPUT_POLICY["date-signed"].authority).toBe("SERVER_DERIVED");
    expect(FIELD_INPUT_POLICY["full-name"].authority).toBe("SERVER_DERIVED");
    expect(FIELD_INPUT_POLICY.email.authority).toBe("SERVER_DERIVED");
  });

  it("bounds every text-shaped value", () => {
    for (const [type, policy] of Object.entries(FIELD_INPUT_POLICY)) {
      if (policy.valueKind === "text") {
        expect(policy.maxLength, `${type} is unbounded`).toBeGreaterThan(0);
      }
    }
  });

  it("permits entry in one request state only", () => {
    // Widening this is a decision, not a refactor. The four terminal states
    // are excluded by the set being closed rather than by an exclusion list.
    expect(CEREMONY_SIGNABLE_REQUEST_STATES).toEqual(["sent"]);
  });
});
