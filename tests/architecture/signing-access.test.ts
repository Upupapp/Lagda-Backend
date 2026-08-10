// Recipient signing-access architecture guards.
//
// Five claims, in order of how expensive being wrong would be:
//
//   1. The public credential path introduces NO blanket RLS bypass.
//   2. The two authentication realms are separate — different cookies,
//      different digest domains, different contexts.
//   3. A recipient never reaches workspace state, and the way that is
//      guaranteed is that the unit of work does not have it.
//   4. Nothing a recipient DOES is recorded — no viewed, no consent, no
//      signature, no OTP, no ceremony.
//   5. Authentication reads the immutable snapshot, never a contact.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_CAPABILITIES } from "@lagda/core";
import { RECIPIENT_AUTHENTICATION_METHODS } from "@lagda/application";

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
  PACKAGES, "application", "src", "signing-access", "signing-access.ts");
const PORTS = path.join(
  PACKAGES, "application", "src", "common", "ports", "signing-sessions.ts");
const REPOSITORY = path.join(PACKAGES, "db", "src", "repositories", "signing-sessions.ts");
const TRANSACTIONS = path.join(PACKAGES, "db", "src", "transactions", "index.ts");
const ROUTES = path.join(
  PACKAGES, "api", "src", "signing-access", "signing-access-routes.ts");
const TOKEN = path.join(PACKAGES, "api", "src", "security", "recipient-session-token.ts");
const COOKIES = path.join(PACKAGES, "api", "src", "security", "cookies.ts");
const MIGRATION = path.join(
  PACKAGES, "db", "src", "migrations", "021_recipient_signing_access.ts");

const ACCESS_FILES = [USE_CASE, PORTS, REPOSITORY, ROUTES, TOKEN];

// ── 1. No RLS bypass ─────────────────────────────────────────────────────────

describe("the public credential path adds no RLS bypass", () => {
  it("grants no BYPASSRLS and no SUPERUSER", () => {
    const migration = code(MIGRATION);
    for (const forbidden of ["BYPASSRLS", "SUPERUSER", "bypassrls", "superuser"]) {
      expect(migration, `migration grants ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("resolves through FOR SELECT policies on a unique digest column", () => {
    // The whole security argument. Equality on a UNIQUE column matches at most
    // one row, so the policy cannot enumerate, cannot scan a workspace, and
    // cannot answer any question except "the grant whose credential I hold".
    const migration = sqlOf(MIGRATION);
    expect(migration).toMatch(
      /create policy signing_access_credential_read on signing_access_grants\s+for select\s+using \(credential_digest = lagda_current_signing_access_digest\(\)\)/);
    // Every companion policy is FOR SELECT too.
    const policies = migration.match(/create policy signing_access_\w+/g) ?? [];
    const selects = migration.match(/for select/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(4);
    expect(selects.length).toBeGreaterThanOrEqual(policies.length);
  });

  it("fails closed when the setting is missing", () => {
    // `current_setting(name, true)` returns NULL rather than raising, and
    // NULL matches nothing — so a transaction that forgot to set the digest
    // sees zero grants rather than all of them.
    expect(sqlOf(MIGRATION)).toMatch(
      /nullif\(current_setting\([\s\S]{0,60}, true\), ''\)/);
  });

  it("uses its own settings, shared with no other realm", () => {
    const transactions = code(TRANSACTIONS);
    expect(transactions).toContain('"lagda.signing_access_digest"');
    expect(transactions).toContain('"lagda.recipient_session_digest"');
    // Distinct from the invitation realm's.
    expect(transactions).toContain('"lagda.invitation_digest"');
  });

  it("exposes one lookup method and no listing", () => {
    const ports = code(PORTS);
    for (const forbidden of ["list(", "findAll", "findByRequest", "count(", "search"]) {
      expect(ports, `the lookup port declares ${forbidden}`).not.toContain(forbidden);
    }
    expect(ports).toContain("findByCredentialDigest");
  });

  it("hands the recipient a NARROW unit of work", () => {
    // The guarantee is not "a recipient must not call `uow.documents`" — it is
    // that `uow.documents` does not exist on what they hold.
    const ports = code(PORTS);
    const narrow = /interface RecipientWorkspaceUnitOfWork \{([\s\S]*?)\n\}/.exec(ports);
    expect(narrow).not.toBeNull();
    const body = narrow?.[1] ?? "";
    for (const forbidden of [
      "documents", "contacts", "memberships", "preparations", "recipients:",
      "artifacts", "evidence", "workspaces",
    ]) {
      expect(body, `the recipient unit of work exposes ${forbidden}`)
        .not.toContain(forbidden);
    }
    expect(body).toContain("recipientSessions");
  });
});

// ── 2. Two realms ────────────────────────────────────────────────────────────

describe("the two authentication realms are separate", () => {
  it("uses distinct cookie names", () => {
    const cookies = code(COOKIES);
    expect(cookies).toContain('SESSION_COOKIE_NAME = "lagda_session"');
    expect(cookies).toContain('RECIPIENT_SESSION_COOKIE_NAME = "lagda_signing_session"');
    expect(cookies).toContain('RECIPIENT_CSRF_COOKIE_NAME = "lagda_signing_csrf"');
    // Four distinct names across three realms.
    const names = new Set([
      "lagda_session", "lagda_csrf", "lagda_pre_auth",
      "lagda_signing_session", "lagda_signing_csrf",
    ]);
    expect(names.size).toBe(5);
  });

  it("uses distinct digest domains for the session and its CSRF token", () => {
    const token = code(TOKEN);
    expect(token).toContain('SESSION_DOMAIN = "lagda.recipient-signing-session"');
    expect(token).toContain('CSRF_DOMAIN = "lagda.recipient-signing-csrf"');
    // Not reusing another realm's constant.
    for (const other of [
      "lagda.session", "lagda.csrf", "lagda.workspace-invitation",
      "lagda.signing-access-bootstrap",
    ]) {
      expect(token, `the factory reuses ${other}`).not.toContain(other);
    }
  });

  it("draws the two credentials independently", () => {
    // A CSRF token derived from the session token — even through a hash — makes
    // a double-submit check whose two halves share a secret.
    const token = code(TOKEN);
    const draws = token.match(/randomBytes\(TOKEN_BYTES\)/g) ?? [];
    expect(draws).toHaveLength(2);
  });

  it("gives the recipient context no role, membership or capability", () => {
    const source = code(USE_CASE);
    const context = /interface RecipientSigningContext \{([\s\S]*?)\n\}/.exec(source);
    expect(context).not.toBeNull();
    const body = context?.[1] ?? "";
    for (const forbidden of [
      "role", "membership", "userId", "capability", "capabilities",
    ]) {
      expect(body, `the context carries ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never reaches the workspace authorization policy", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file);
      for (const forbidden of [
        "assertCapability", "WorkspaceAccessContext", "hasCapability",
        "WorkspaceCapability", "WorkspaceRole",
      ]) {
        expect(source, `${path.basename(file)} uses ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("adds no workspace capability of its own", () => {
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(capability.startsWith("signing-access."), capability).toBe(false);
      expect(capability.startsWith("recipient."), capability).toBe(false);
    }
  });

  it("names no role anywhere", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file);
      expect(source, `${path.basename(file)} compares a role`)
        .not.toMatch(/role\s*===/);
    }
  });
});

// ── 3. Snapshot only ─────────────────────────────────────────────────────────

describe("authentication reads the immutable snapshot", () => {
  it("reaches no contact and no preparation", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file);
      for (const forbidden of [
        "uow.contacts", "ContactId", "ports/contacts.js",
        "preparation_recipients", "preparation_fields", "ports/preparation.js",
      ]) {
        expect(source, `${path.basename(file)} reaches ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("never resolves a recipient by email", () => {
    // Access is credential- and id-based. An email lookup would authorize by
    // an attribute two recipients can share.
    for (const file of ACCESS_FILES) {
      const source = code(file);
      for (const forbidden of [
        "findByEmail", "whereEmail", "byEmail", "normalizedEmail =",
      ]) {
        expect(source, `${path.basename(file)} looks up by email`)
          .not.toContain(forbidden);
      }
    }
  });

  it("never looks for a matching LAGDA account", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file);
      for (const forbidden of ["uow.users", "findUser", "UserId", "accountEmails"]) {
        expect(source, `${path.basename(file)} reaches ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });
});

// ── 4. Nothing a recipient does ──────────────────────────────────────────────

describe("authenticating does nothing else", () => {
  it("declares no ceremony state anywhere", () => {
    for (const file of [...ACCESS_FILES, MIGRATION]) {
      const source = code(file);
      for (const forbidden of [
        "viewed_at", "viewedAt", "consented_at", "consentedAt",
        "signed_at", "signedAt", "declined_at", "declinedAt",
        "completed_at", "signature", "fieldValue", "field_value",
      ]) {
        expect(source, `${path.basename(file)} declares ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("implements no OTP", () => {
    // ── Implementation markers, not the string "otp" ──────────────────────
    //
    // The first version of this guard forbade `otp` outright and failed on
    // `RECIPIENT_AUTHENTICATION_METHODS = ["link-only", "email-otp"]` — the
    // declared-but-unreachable method name, which is exactly what lets a
    // session SAY how it was authenticated when a second method arrives.
    //
    // What must be absent is the machinery: a challenge, a verifier, an
    // attempt counter, a code. Those are what would make OTP real, and the
    // string in a union is not.
    for (const file of [...ACCESS_FILES, MIGRATION]) {
      const source = code(file).toLowerCase();
      for (const forbidden of [
        "verification_code", "challenge_id", "otpchallenge", "failed_attempts",
        "max_attempts", "verifier", "issueotp", "verifyotp", "resendotp",
      ]) {
        expect(source, `${path.basename(file)} implements ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
    // And the use case writes exactly one method literal.
    expect(code(USE_CASE)).not.toContain("email-otp");
  });

  it("touches no PDF, no storage and no sealer", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file);
      for (const forbidden of [
        "pdf-lib", "@lagda/sealing", "@lagda/storage", "DocumentSealer",
        "storageReference",
      ]) {
        expect(source, `${path.basename(file)} references ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("writes no evidence event", () => {
    for (const file of [USE_CASE, ROUTES]) {
      expect(code(file), `${path.basename(file)} writes evidence`)
        .not.toMatch(/uow\.evidence|evidence\.append/);
    }
  });

  it("does not consume or revoke the bootstrap grant", () => {
    // Reusable until expiry — the product's flow loses its state on reload and
    // has no resend, so a one-time credential would lock a signer out.
    const source = code(USE_CASE);
    for (const forbidden of ["revokeGrant", "consumeGrant", "markConsumed"]) {
      expect(source, `bootstrap calls ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ── 5. Scanner safety, credentials and telemetry ─────────────────────────────

describe("scanner safety", () => {
  it("exchanges only on POST, never on GET", () => {
    const routes = code(ROUTES);
    expect(routes).toMatch(/app\.post\("\/signing-access\/bootstrap"/);
    // The only GET is the context read, which mutates nothing.
    const gets = routes.match(/app\.get\("([^"]+)"/g) ?? [];
    expect(gets).toEqual(['app.get("/signing/context"']);
    expect(routes).not.toMatch(/app\.get\([\s\S]{0,80}bootstrap/);
  });

  it("takes the credential from the body, never from a path parameter", () => {
    // A token in a path is a token in an access log, a referrer and a history
    // entry.
    const routes = code(ROUTES);
    expect(routes).not.toMatch(/:token/);
    expect(routes).toContain("request.body as Static<typeof BootstrapBodySchema>");
  });

  it("sets a no-referrer policy", () => {
    expect(code(ROUTES)).toContain('"Referrer-Policy", "no-referrer"');
  });
});

describe("credentials and telemetry", () => {
  it("stores digests, never raw values", () => {
    const migration = sqlOf(MIGRATION);
    expect(migration).toContain("token_digest");
    expect(migration).toContain("csrf_token_digest");
    for (const forbidden of ["raw_token", "token_value", "plaintext", "secret "]) {
      expect(migration, `the schema stores ${forbidden}`).not.toContain(forbidden);
    }
    expect(migration).toMatch(/token_digest ~ '\^\[a-f0-9\]\{64\}\$'/);
  });

  it("refuses a session whose two credentials are the same", () => {
    expect(sqlOf(MIGRATION)).toMatch(
      /recipient_sessions_distinct_credentials\s+check \(token_digest <> csrf_token_digest\)/);
  });

  it("is not a JWT", () => {
    for (const file of ACCESS_FILES) {
      const source = code(file).toLowerCase();
      for (const forbidden of ["jsonwebtoken", "jwt", "jose", "hs256", "rs256"]) {
        expect(source, `${path.basename(file)} uses ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("logs no credential, address or title", () => {
    const routes = code(ROUTES);
    for (const match of routes.matchAll(/request\.log\.info\(\{([\s\S]*?)\}, "/g)) {
      const body = match[1] ?? "";
      for (const forbidden of [
        "token", "credential", "digest", "email", "maskedEmail",
        "documentTitle", "recipientName", "cookie", "url",
      ]) {
        expect(body.toLowerCase(), `a log payload contains ${forbidden}`)
          .not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it("returns no credential in any response", () => {
    // ── The projection and the schemas, not the whole file ────────────────
    //
    // Slicing from `const present =` to the end swept in the route handlers,
    // and failed on `recipientId` in the `session_created` SECURITY EVENT —
    // which belongs there. §88 names SigningRequestRecipientId as an
    // authoritative authentication fact, and a pseudonymous id in one line per
    // authentication is what makes the event useful for forensics.
    //
    // What must not leave the backend is a CREDENTIAL, and the two response
    // shapes are where that would show.
    const routes = code(ROUTES);
    const projection = routes.slice(
      routes.indexOf("const present ="), routes.indexOf("export function register"));
    // A CODE marker, not a comment: `code()` strips comments, so a slice
    // boundary written as one silently becomes index -1 and takes the whole
    // file. That is what made the first attempt fail.
    const schemas = routes.slice(
      0, routes.indexOf("export interface SigningAccessRouteOptions"));

    // The ONE place a credential appears in a schema is the bootstrap REQUEST
    // body — the credential arriving, which is the endpoint's purpose. Asserted
    // positively so its absence would also fail.
    expect(schemas).toContain("token: Type.String({ minLength: 43, maxLength: 43 })");
    for (const responseShape of ["BootstrapResponseSchema", "ContextResponseSchema"]) {
      const shape = /Schema = Type\.Object\(\{([\s\S]*?)\}, \{/
        .exec(schemas.slice(schemas.indexOf(responseShape)));
      expect(shape?.[1] ?? "", `${responseShape} carries a token`)
        .not.toContain("token");
    }

    for (const region of [projection, schemas]) {
      for (const forbidden of [
        "rawSessionToken", "rawCsrfToken", "tokenDigest", "credentialDigest",
        "csrfDigest",
      ]) {
        expect(region, `a response carries ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("declares exactly the methods the product supports", () => {
    expect(RECIPIENT_AUTHENTICATION_METHODS).toEqual(["link-only", "email-otp"]);
    // And only one is reachable: the use case writes a literal.
    expect(code(USE_CASE)).toContain('authenticationMethod: "link-only"');
    expect(code(USE_CASE)).not.toContain('"email-otp"');
  });
});
