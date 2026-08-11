// Send architecture guards.
//
// Four claims, in order of how expensive being wrong would be:
//
//   1. Send reads the SNAPSHOT and nothing mutable. A send that resolved a
//      recipient through the current contact would deliver to an address the
//      request never captured — and would break no constraint doing it.
//   2. No provider is called, from anywhere, ever.
//   3. The raw credential is never persisted in the grant, never logged, never
//      returned, never put in a URL that is stored.
//   4. The signing link comes from configured base, never a request header.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES } from "@lagda/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

const read = (file: string): string => readFileSync(file, "utf8");

function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sqlOf = (file: string): string => code(file).replace(/^\s*--.*$/gm, "");

const USE_CASE = path.join(PACKAGES, "application", "src", "signing-requests", "send.ts");
const CORE = path.join(PACKAGES, "core", "src", "signing", "send.ts");
const PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "signing-access.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "signing-access.ts");
const ROUTES = path.join(PACKAGES, "api", "src", "signing-requests", "send-routes.ts");
const TOKEN = path.join(PACKAGES, "api", "src", "security", "signing-access-token.ts");
const DELIVERY = path.join(PACKAGES, "api", "src", "security", "signing-delivery.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "020_signing_request_send.ts");

const SEND_FILES = [USE_CASE, CORE, PORTS, REPOSITORY, ROUTES, TOKEN, DELIVERY];

// ── 1. The snapshot is the only source ───────────────────────────────────────

describe("send reads the snapshot and nothing mutable", () => {
  it("reaches no mutable authoring repository", () => {
    // The most important guard in the file. Every other control here fails
    // loudly — a constraint violates, a schema rejects. A send that read
    // `uow.contacts` for a display name would break nothing and deliver to the
    // wrong address.
    const source = code(USE_CASE);

    // ── Module paths, not type names ──────────────────────────────────────
    //
    // The first version of this guard forbade the substring `RecipientRecord`
    // and failed immediately — on `SigningRequestRecipientRecord`, which is
    // the request's OWN snapshot type and exactly what send is supposed to
    // use. A detector that cannot tell the two apart would teach someone to
    // rename the right thing.
    //
    // An import path is unambiguous: `ports/recipients.js` is the mutable
    // preparation recipient and `ports/signing-requests.js` is the snapshot.
    for (const forbidden of [
      "uow.contacts", "uow.recipients", "uow.preparations",
      "ports/contacts.js", "ports/recipients.js", "ports/preparation.js",
      "ContactId",
    ]) {
      expect(source, `send reaches ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reads recipients and fields from the REQUEST repository", () => {
    const source = code(USE_CASE);
    expect(source).toContain("uow.signingRequests.listRecipients");
    expect(source).toContain("uow.signingRequests.listFields");
  });

  it("takes the source artifact from the request, never re-resolving it", () => {
    const source = code(USE_CASE);
    expect(source).toContain("request.sourceArtifactId");
    // It checks EXISTENCE only, and never reads bytes.
    expect(source).toContain("listForDocument");
    for (const forbidden of ["download", "getObject", "readBytes", "storageReference"]) {
      expect(source, `send reaches ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("snapshots the delivery values into the intent", () => {
    // A retry hours later must render the same email, and the workspace name
    // is mutable.
    const source = code(USE_CASE);
    for (const field of [
      "recipientEmail:", "recipientName:", "documentTitle:",
      "senderDisplayName:", "workspaceName:",
    ]) {
      expect(source, `the intent has no ${field}`).toContain(field);
    }
  });
});

// ── 2. No provider, no ceremony ──────────────────────────────────────────────

describe("send contacts no provider and performs no ceremony", () => {
  it("imports no mail provider of any kind", () => {
    for (const file of SEND_FILES) {
      const source = code(file);
      for (const forbidden of [
        "nodemailer", "sendgrid", "@sendgrid", "postmark", "resend",
        "aws-sdk", "@aws-sdk", "mailgun", "smtp", "createTransport",
        "sendEmail", "sendMail",
      ]) {
        expect(source.toLowerCase(), `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it("touches no PDF library and no sealer", () => {
    for (const file of SEND_FILES) {
      const source = code(file);
      for (const forbidden of [
        "pdf-lib", "@lagda/sealing", "@lagda/storage", "DocumentSealer",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no signing evidence and no ceremony state", () => {
    // ── Narrowed by BACKEND-43 ──────────────────────────────────────────────
    //
    // The USE CASE now appends evidence: sending is an authorized actor
    // committing the request for recipient access, which is exactly the kind of
    // fact this evidence store exists to hold. What it still must not do is
    // claim a recipient DID anything — no view, no signature, no delivery — and
    // the forbidden-column sweep below is what holds that line.
    //
    // The ROUTE and the MIGRATION keep the original rule. An HTTP layer
    // appending to a legal record puts event semantics one refactor away from a
    // controller, and a migration has no business writing events at all.
    for (const file of [ROUTES, MIGRATION]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }

    // The use case appends only through factories — never a literal, so type,
    // version, source and actor cannot drift apart.
    const useCase = code(USE_CASE);
    expect(useCase).toMatch(/uow\.evidence\.append\(requestSent\(/);
    expect(useCase).not.toMatch(/evidence\.append\(\s*\{/);

    for (const file of [USE_CASE, ROUTES, MIGRATION]) {
      const source = code(file);
      for (const forbidden of [
        "viewed_at", "viewedAt", "signed_at", "signedAt", "declined_at",
        "authenticated_at", "authenticatedAt", "completed_at",
        "delivered_at", "deliveryStatus", "bounced_at",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("declares exactly two request states", () => {
    // Widened by ONE. `completed`, `declined`, `cancelled` and `expired` are
    // still claims nothing can make true.
    expect(sqlOf(MIGRATION)).toMatch(/REQUEST_STATES = \["draft", "sent"\]/);
  });

  it("declares exactly two activation states, neither a ceremony state", () => {
    expect(sqlOf(MIGRATION)).toMatch(/ACTIVATION_STATES = \["waiting", "active"\]/);
  });
});

// ── 3. The credential ────────────────────────────────────────────────────────

describe("the bootstrap credential", () => {
  it("is opaque random bytes, not a JWT", () => {
    const token = code(TOKEN);
    expect(token).toContain("randomBytes");
    for (const forbidden of ["jsonwebtoken", "jwt", "jose", "sign(", "HS256", "RS256"]) {
      expect(token.toLowerCase(), `the factory uses ${forbidden}`)
        .not.toContain(forbidden.toLowerCase());
    }
  });

  it("has its own digest domain, shared with nothing", () => {
    const token = code(TOKEN);
    expect(token).toMatch(/DIGEST_DOMAIN = "lagda\.signing-access-bootstrap"/);
    // Not reusing another purpose's constant.
    for (const other of [
      "lagda.workspace-invitation", "lagda.session", "lagda.csrf", "lagda.idem",
    ]) {
      expect(token, `the factory reuses ${other}`).not.toContain(other);
    }
  });

  it("persists a digest column, never a raw one", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("credential_digest");
    expect(migration).toMatch(/credential_digest ~ '\^\[a-f0-9\]\{64\}\$'/);
    for (const forbidden of [
      "raw_credential", "raw_token", "credential_raw", "plaintext", "access_token",
    ]) {
      expect(migration, `the schema has a ${forbidden} column`)
        .not.toContain(forbidden);
    }
  });

  it("writes only the digest in the repository", () => {
    const repository = code(REPOSITORY);
    expect(repository).toContain("credential_digest: grant.credentialDigest");
    expect(repository).not.toContain(".raw");
  });

  it("always sets an expiry", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(/expires_at\s+timestamptz\s+not null/);
    expect(migration).toMatch(/check \(expires_at > created_at\)/);
    expect(code(USE_CASE)).toContain("expiresAt: now + deps.policy.bootstrapLifetimeMs");
  });

  it("allows one active grant per recipient", () => {
    expect(sqlOf(MIGRATION)).toMatch(
      /create unique index signing_access_grants_one_active_idx[\s\S]{0,200}where revoked_at is null/);
  });

  it("binds a grant with a THREE-column key", () => {
    // A grant cannot reference a recipient of a different request, even in one
    // workspace.
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(
      /foreign key \(workspace_id, signing_request_id, request_recipient_id\)[\s\S]{0,200}references signing_request_recipients/);
  });

  it("seals the raw credential rather than dropping or exposing it", () => {
    const source = code(USE_CASE);
    expect(source).toContain("deps.sealer.seal(credential.raw)");
    expect(source).toContain("sealedCredential: sealed");
    // And it is the TOKEN that is sealed, not a URL.
    expect(source).not.toMatch(/seal\(\s*deps\.links\.build/);
  });

  it("never returns a credential, a digest or a URL to the sender", () => {
    const source = code(USE_CASE) + code(ROUTES);
    for (const forbidden of [
      "signingUrl", "signingLink", "rawCredential:", "credentialDigest:",
      "sealedCredential:",
    ]) {
      // The use case ASSIGNS these into persistence; what must not appear is a
      // projection. Check the response shape specifically.
      expect(code(ROUTES), `the response carries ${forbidden}`)
        .not.toContain(forbidden);
    }
    expect(source).toContain("activatedRecipientCount");
  });
});

// ── 4. The link ──────────────────────────────────────────────────────────────

describe("the signing link", () => {
  it("comes from configured base and cannot see a request", () => {
    const delivery = code(DELIVERY);
    expect(delivery).toContain("createSigningLinkBuilder(appBaseUrl: string)");
    for (const forbidden of [
      "request.headers", "x-forwarded-host", "request.hostname", "req.host",
      "FastifyRequest",
    ]) {
      expect(delivery.toLowerCase(), `the builder reads ${forbidden}`)
        .not.toContain(forbidden.toLowerCase());
    }
  });

  it("is never persisted", () => {
    // Only the raw TOKEN is sealed. A stored URL is a stored host.
    const migration = sqlOf(MIGRATION);
    for (const forbidden of ["signing_url", "link", "url"]) {
      expect(migration, `the schema stores a ${forbidden}`)
        .not.toMatch(new RegExp(`\\b${forbidden}\\s+(varchar|text)`));
    }
  });
});

// ── 5. Atomicity, authorization, tenancy, telemetry ──────────────────────────

describe("the transition", () => {
  it("is conditional, in one statement", () => {
    const repository = code(
      path.join(PACKAGES, "db", "src", "repositories", "signing-requests.ts"));
    expect(repository).toContain('.where("state", "=", "draft")');
    expect(repository).toContain('set({ state: "sent"');
  });

  it("happens LAST, after every credential and intent is written", () => {
    const source = code(USE_CASE);
    const provisioning = source.indexOf("provisionSigningRecipientAccess(uow");
    const transition = source.indexOf("markSentIfDraft");
    expect(provisioning).toBeGreaterThan(0);
    expect(transition).toBeGreaterThan(provisioning);
  });

  it("keeps sent_at in step with state at the database", () => {
    expect(sqlOf(MIGRATION)).toMatch(
      /signing_requests_sent_at_matches_state check \([\s\S]{0,200}state = 'sent' and sent_at is not null/);
  });
});

describe("authorization and tenancy", () => {
  it("uses the centralized send capability and no role literal", () => {
    expect(code(USE_CASE)).toContain('"signing-request.send"');
    expect(code(USE_CASE)).not.toMatch(/role\s*===/);
    const routes = code(ROUTES);
    expect(routes).not.toMatch(/role\s*===/);
    for (const role of ["owner", "sender", "auditor", "reviewer"]) {
      expect(routes, `routes mention ${role}`).not.toContain(`"${role}"`);
    }
  });

  it("declares the capability centrally", () => {
    expect(WORKSPACE_CAPABILITIES as readonly string[])
      .toContain("signing-request.send");
  });

  it("reads membership inside the transaction", () => {
    expect(code(USE_CASE)).toContain("uow.memberships.findByUser");
  });

  it("forces RLS on all three new tables", () => {
    const migration = code(MIGRATION);
    expect(migration).toContain("force row level security");
    for (const table of [
      "signing_request_recipient_activation", "signing_access_grants",
      "signing_delivery_intents",
    ]) {
      expect(migration, `${table} is missing`).toContain(table);
    }
    for (const forbidden of ["BYPASSRLS", "SUPERUSER"]) {
      expect(migration, `migration grants ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("scopes every repository query", () => {
    const repository = code(REPOSITORY);
    const selects = repository.match(/selectFrom\("signing_/g) ?? [];
    const scoped = repository.match(/where\("workspace_id", "=", scope\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(scoped.length).toBeGreaterThanOrEqual(selects.length);
  });

  it("takes no workspace argument on any port method", () => {
    const ports = code(PORTS);
    expect(ports).not.toMatch(/\(\s*workspaceId:/);
  });
});

describe("telemetry", () => {
  it("logs counts and ids, never a recipient, a credential or a link", () => {
    const routes = code(ROUTES);
    const payload = /request\.log\.info\(\{([\s\S]*?)\}, "signing_request\.sent"\)/
      .exec(routes);
    expect(payload).not.toBeNull();
    const body = payload?.[1] ?? "";
    for (const forbidden of [
      "email", "name", "credential", "token", "url", "digest", "sealed",
      "recipients", "documentTitle",
    ]) {
      expect(body.toLowerCase(), `the log payload contains ${forbidden}`)
        .not.toContain(forbidden.toLowerCase());
    }
    expect(body).toContain("activatedRecipientCount");
  });

  it("rate-limits before any credential is generated", () => {
    const routes = code(ROUTES);
    const limit = routes.indexOf("signing-request.send.user");
    const send = routes.indexOf("sendSigningRequest(");
    expect(limit).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(limit);
  });
});
