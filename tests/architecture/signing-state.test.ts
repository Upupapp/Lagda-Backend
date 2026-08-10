// Architecture guards for the signing workflow state machine (BACKEND-37).
//
// These read SOURCE, because what they assert is the ABSENCE of things — and
// absence is not testable by calling a function. A generic state setter, a
// second signability rule, a PDF import: each would work perfectly and each
// would be the defect.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const PACKAGES = join(ROOT, "packages");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL = sourceFiles(PACKAGES);
const PRODUCTION = ALL.filter(f => !f.endsWith(".test.ts"));
const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * Every guard below that asserts an ABSENCE has to strip them first, and
 * finding that out cost three failing assertions on the first run. Two of the
 * files being guarded EXPLAIN in prose that they do not invoke `DocumentSealer`
 * and do not declare `updateState` — so a naive substring search flags the
 * documentation of the rule as a violation of it, and would keep doing so until
 * someone deleted the explanation to make the test pass.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
}

/** Just the module specifiers a file imports. */
function imports(file: string): readonly string[] {
  return [...read(file).matchAll(/from\s+"([^"]+)"/g)].map(m => m[1] ?? "");
}

const WORKFLOW = join(
  PACKAGES, "application", "src", "signing-workflow", "signing-workflow.ts");
const POLICY = join(PACKAGES, "core", "src", "signing", "workflow-state.ts");

// ── No generic state mutation, anywhere ──────────────────────────────────────

describe("state transitions are semantic operations", () => {
  it("declares no generic state setter on any signing repository", () => {
    // §16, §157, §158. The danger is not that a generic setter is wrong today
    // — it is that once `updateState` exists, `PATCH /signing-requests/:id
    // { state }` is one careless handler away.
    // On CODE, not on the file. The ports module EXPLAINS in prose that
    // `updateState` and `setStatus` do not exist, so a naive search reads the
    // documentation of the rule as a violation of it — and the only way to make
    // that pass would be to delete the explanation.
    const offenders = PRODUCTION.filter(file => {
      if (!/signing|workflow/i.test(file)) return false;
      return /\b(setState|setStatus|updateState|updateStatus)\s*[(:]/.test(code(file));
    });
    expect(offenders.map(f => f.replace(ROOT, ""))).toEqual([]);
  });

  it("exposes no route that accepts a request or recipient state", () => {
    // §226, §265. A body field named `state` on a signing route is the mass
    // assignment this asserts cannot exist.
    const routes = PRODUCTION.filter(
      file => file.includes(join("api", "src")) && file.includes("routes"));
    expect(routes.length).toBeGreaterThan(0);
    for (const file of routes) {
      const src = read(file);
      expect(src, `${file} accepts a client state`).not.toMatch(
        /body\s*\.\s*state|body\s*\.\s*signedAt|body\s*\.\s*recipientState/);
    }
  });

  it("takes no signing timestamp from a client body", () => {
    // §19, §134. `signedAt` is the submission's `acceptedAt` and nothing else.
    //
    // Scoped to the API and the use cases, NOT to repositories: a repository
    // method legitimately takes `input.signedAt`, because the use case above it
    // is handing down the value it read off the submission. Flagging that was
    // this detector's first false positive.
    const boundary = PRODUCTION.filter(
      file => /signing|workflow|submission/i.test(file)
        && (file.includes(join("api", "src")) || file.includes("signing-workflow")
          || file.includes("signing-submission"))
        && !file.includes(join("db", "src")));
    expect(boundary.length).toBeGreaterThan(0);
    for (const file of boundary) {
      expect(code(file), `${file} reads a client signedAt`).not.toMatch(
        /body\s*\.\s*signedAt|request\s*\.\s*body\s*\.\s*signedAt/);
    }
  });
});

// ── One signability rule ─────────────────────────────────────────────────────

describe("there is one source of signability truth", () => {
  it("declares SIGNABLE_REQUEST_STATES exactly once", () => {
    // §128. Three modules each deciding whether a recipient may act is a
    // security bug waiting to happen — the loosest one wins, because a caller
    // only has to find it. BACKEND-37 deleted the ceremony's own copy.
    const declaring = PRODUCTION.filter(
      file => /(SIGNABLE_REQUEST_STATES|CEREMONY_SIGNABLE_REQUEST_STATES)\s*[:=]/
        .test(read(file)));
    expect(declaring.map(f => f.replace(ROOT, ""))).toEqual([POLICY.replace(ROOT, "")]);
  });

  it("routes the ceremony's access decision through the canonical policy", () => {
    // §130. `assessCeremonyAccess` is a projection, not a second implementation.
    const ceremony = read(join(PACKAGES, "core", "src", "signing", "ceremony.ts"));
    expect(ceremony).toContain("assessSigningEligibility");
  });

  it("routes the submission's revalidation through it too", () => {
    // §131.
    const submission = read(join(
      PACKAGES, "application", "src", "signing-submission", "signing-submission.ts"));
    expect(submission).toContain("assessCeremonyAccess");
  });
});

// ── The policy is pure ───────────────────────────────────────────────────────

describe("the canonical policy stays pure", () => {
  it("imports no clock, no repository and no infrastructure", () => {
    const src = code(POLICY);
    for (const forbidden of [
      "Date.now", "new Date", "Clock", "Repository", "kysely", "node:crypto",
    ]) {
      expect(src, `workflow-state.ts references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("imports only contracts and its own domain", () => {
    const imports = [...read(POLICY).matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^(@lagda\/contracts|\.\.?\/)/);
    }
  });
});

// ── BACKEND-37 does no document work ─────────────────────────────────────────

describe("BACKEND-37 produces no bytes", () => {
  it("imports no PDF library, no storage client and no sealer", () => {
    // §269, §270, §301. The whole point of `completion-ready` is that this
    // command stops BEFORE any of it.
    // IMPORTS, not substrings. The module's own "deliberately absent" block
    // names `DocumentSealer` in order to say it is not invoked, and a substring
    // search reads that explanation as the violation — which would be fixed by
    // deleting the explanation. What actually matters is what it depends on.
    for (const specifier of imports(WORKFLOW)) {
      expect(specifier, `signing-workflow.ts imports ${specifier}`)
        .not.toMatch(/pdf|sealing|storage|@lagda\/sealing|@lagda\/storage/i);
    }
    const src = code(WORKFLOW);
    for (const forbidden of [
      "pdf-lib", "pdfkit", "DocumentSealer", "putObject", "getObject",
    ]) {
      expect(src, `signing-workflow.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("holds no path to the completed state", () => {
    // §12, §69, §123. Asserted on source as well as by the transition table,
    // because a future edit would add the string before it added the edge.
    expect(code(WORKFLOW)).not.toMatch(/"completed"|'completed'/);
  });

  it("reuses the BACKEND-33 provisioner rather than reimplementing it", () => {
    // §49, §221, §271. Credential generation, sealing, the digest domain and
    // the TTL are one implementation, so the sequential path and the send path
    // cannot drift.
    const src = code(WORKFLOW);
    expect(src).toContain("provisionSigningRecipientAccess");
    // And it does NOT mint anything itself.
    expect(src).not.toMatch(/tokens\s*\.\s*issue\s*\(/);
    expect(src).not.toMatch(/sealer\s*\.\s*seal\s*\(/);
    expect(src).not.toMatch(/insertGrant|insertDeliveryIntent/);
  });
});

// ── Telemetry ────────────────────────────────────────────────────────────────

describe("workflow telemetry carries nothing identifying", () => {
  it("returns counts rather than recipient lists", () => {
    // §196, §197. `activatedCount` is a bounded number; a list of recipient ids
    // would be unbounded cardinality AND a disclosure.
    const src = read(WORKFLOW);
    expect(src).toContain("activatedCount");
    expect(src).not.toMatch(/readonly activated:\s*readonly string\[\]/);
  });

  it("records only a bounded failure code, never an exception message", () => {
    // §199. The one place unbounded external text could enter a durable row.
    const src = code(WORKFLOW);
    expect(src).toMatch(/code:\s*"[a-z-]+"/);
    expect(src).not.toMatch(/code:\s*(error|err)\b/);
  });

  it("never logs an email, a name, a credential or a field value", () => {
    const src = code(WORKFLOW);
    for (const forbidden of [
      "recipientEmail", "recipientName", "credentialDigest", "rawToken",
      "textValue", "rasterBytes",
    ]) {
      expect(src, `signing-workflow.ts mentions ${forbidden}`)
        .not.toContain(forbidden);
    }
  });
});

// ── No unfinished work claimed as finished ───────────────────────────────────

describe("nothing is left as a promise", () => {
  it("carries no TODO about the state machine", () => {
    // §279. Deferred work is named in the `...Deferred` block with the command
    // that owns it, which is a decision; a TODO is an intention.
    for (const file of [WORKFLOW, POLICY]) {
      expect(read(file)).not.toMatch(/\bTODO\b|\bFIXME\b/);
    }
  });

  it("uses no `any` in the state or routing types", () => {
    // §278.
    for (const file of [WORKFLOW, POLICY]) {
      const src = read(file);
      expect(src, file).not.toMatch(/\bas any\b|:\s*any\b|@ts-(ignore|nocheck)/);
    }
  });
});
