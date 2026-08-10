// The sealing boundary, enforced.
//
// BACKEND-00 claims a future Java or .NET signing service can replace
// `@lagda/sealing` without any caller changing. That claim is only true if
// nothing outside the package knows a PDF library exists and nothing in the
// seam mentions a library type. Both are checkable, so they are checked here
// rather than asserted in a document nobody runs.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Import specifiers only — not prose. A comment naming pdf-lib is not a
 * dependency.
 *
 * The bare form `import "pdf-lib";` is included deliberately. An earlier
 * version of this matched only `from "…"`, and a probe that appended a
 * side-effect import to the application package passed every check — the
 * boundary was unguarded against the one import form that has no `from`.
 */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

const PDF_LIBRARIES = /^(pdf-lib|pdfkit|jspdf|pdfmake|@signpdf\/|@pdf-lib\/)/;

describe("PDF libraries are confined to @lagda/sealing", () => {
  it("no package outside sealing imports a PDF library", () => {
    const offenders: string[] = [];

    for (const pkg of readdirSync(PACKAGES)) {
      if (pkg === "sealing") continue;
      const src = path.join(PACKAGES, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        for (const specifier of importsOf(read(file))) {
          if (PDF_LIBRARIES.test(specifier)) {
            offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("sealing DOES import pdf-lib — the negative control", () => {
    // Without this, the check above would pass just as happily if the sealer
    // were deleted, or if the detector's regex silently matched nothing. A
    // boundary test that cannot fail proves nothing about the boundary.
    const found = sourceFiles(path.join(PACKAGES, "sealing", "src")).some((file) =>
      importsOf(read(file)).some((s) => PDF_LIBRARIES.test(s)),
    );
    expect(found).toBe(true);
  });

  it("only pdf-lib appears in any package manifest, and only in sealing's", () => {
    const declarations: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const manifest = path.join(PACKAGES, pkg, "package.json");
      let raw: string;
      try {
        raw = read(manifest);
      } catch {
        continue;
      }
      const parsed = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const name of Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })) {
        if (PDF_LIBRARIES.test(name)) declarations.push(`${pkg}:${name}`);
      }
    }
    expect(declarations).toEqual(["sealing:pdf-lib"]);
  });
});

/**
 * Source with comments removed.
 *
 * Without this, a check for a forbidden identifier matches the comment that
 * explains why the identifier is forbidden — the detector reports a violation
 * created by documenting the rule.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the seam is library-neutral", () => {
  const seamPath = path.join(PACKAGES, "application/src/common/ports/sealing.ts");
  const seam = read(seamPath);

  it("names no PDF library type", () => {
    // `PDFDocument`, `PDFPage`, `PDFFont` in the port would make the interface
    // unimplementable by a service running outside Node.
    expect(code(seamPath)).not.toMatch(/\bPDF(Document|Page|Font|Image|Ref)\b/);
    expect(importsOf(seam).some((s) => PDF_LIBRARIES.test(s))).toBe(false);
  });

  it("uses Uint8Array rather than Node's Buffer for document bytes", () => {
    // `Buffer` is Node-only. A remote signer implemented in Java could not
    // satisfy a contract that demands one.
    expect(code(seamPath)).toMatch(/DocumentBytes\s*=\s*Uint8Array/);
    expect(code(seamPath)).not.toMatch(/\bBuffer\b/);
  });

  it("imports only from @lagda/contracts", () => {
    const external = importsOf(seam).filter((s) => !s.startsWith("."));
    expect(external).toEqual(["@lagda/contracts"]);
  });

  it("declares exactly one operation on DocumentSealer", () => {
    // The seam is one high-level capability. `mergeFields`/`hashDocument`
    // hanging off the interface would give callers a reason to reach past it,
    // and every one of those becomes a migration cost later.
    const body = /interface DocumentSealer\s*\{([\s\S]*?)\n\}/.exec(seam)?.[1] ?? "";
    expect(body).not.toBe("");
    const methods = body.match(/^\s*\w+\s*\(/gm) ?? [];
    expect(methods).toHaveLength(1);
    expect(body).toMatch(/seal\s*\(/);
  });
});

describe("dependency direction", () => {
  it("application never imports @lagda/sealing", () => {
    // The port is defined in application and IMPLEMENTED in sealing. An import
    // the other way would invert the dependency and make the swap impossible.
    const offenders = sourceFiles(path.join(PACKAGES, "application", "src")).filter((file) =>
      importsOf(read(file)).includes("@lagda/sealing"),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("core never imports @lagda/sealing", () => {
    const offenders = sourceFiles(path.join(PACKAGES, "core", "src")).filter((file) =>
      importsOf(read(file)).includes("@lagda/sealing"),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("sealing imports the port from @lagda/application, not a local copy", () => {
    // One definition. A second `interface DocumentSealer` in sealing would
    // typecheck, drift, and give the two layers different contracts.
    const sealer = read(path.join(PACKAGES, "sealing/src/node-document-sealer.ts"));
    expect(importsOf(sealer)).toContain("@lagda/application");
    expect(sealer).not.toMatch(/interface\s+DocumentSealer\b/);
  });

  it("defines DocumentSealer in exactly one file", () => {
    const declarations: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = path.join(PACKAGES, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        if (/interface\s+DocumentSealer\b/.test(read(file))) {
          declarations.push(path.relative(ROOT, file).replace(/\\/g, "/"));
        }
      }
    }
    expect(declarations).toEqual(["packages/application/src/common/ports/sealing.ts"]);
  });
});

describe("hashing is confined to the sealing adapter", () => {
  it("createHash is called in exactly one file", () => {
    // Several hash implementations across layers is how one of them ends up
    // base64 while the other is hex, and a verification comparison silently
    // never matches.
    //
    // Scoped to `createHash`, not to `node:crypto` as a whole. The broader form
    // failed the moment BACKEND-11 used `randomUUID` for request IDs — which is
    // not hashing and is legitimately elsewhere. A detector wider than the
    // invariant it enforces produces failures that teach the wrong lesson, and
    // the tempting fix is to add an allowlist rather than narrow the check.
    const users: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = path.join(PACKAGES, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        if (file.endsWith(".test.ts")) continue;
        const source = read(file);
        if (importsOf(source).includes("node:crypto") && /\bcreateHash\s*\(/.test(source)) {
          users.push(path.relative(ROOT, file).replace(/\\/g, "/"));
        }
      }
    }
    // An explicit ALLOWLIST of two, each with a stated domain — not a widened
    // rule. A third caller still fails, which is the point.
    //
    //   sealing/internal/digest  — DOCUMENT digests (INV-080). One
    //                              implementation, so hex vs base64 cannot
    //                              disagree across layers.
    //   api/security/crypto      — SESSION and CSRF token digests (BACKEND-13).
    //                              A different domain entirely: these are
    //                              lookup keys for high-entropy credentials,
    //                              never document content.
    //   api/security/rate-limit-plugin — RATE-LIMIT SCOPE digests. A third
    //                              domain: irreversible bucket keys for IP and
    //                              account values, so a counter table holds no
    //                              reversible personal data.
    //   api/security/verification-token — EMAIL VERIFICATION token digests
    //                              (BACKEND-19). A fourth domain, with its own
    //                              prefix so a verification token and a session
    //                              token can never produce the same digest.
    //   api/security/reset-token — PASSWORD RESET token digests (BACKEND-22).
    //                              A fifth domain. The `lagda.password-reset:`
    //                              prefix is what stops a verification code
    //                              from digesting to a reset challenge, which
    //                              would turn proof of a mailbox into authority
    //                              to replace a password.
    //   api/security/recovery-codes — MFA RECOVERY CODE digests (BACKEND-23).
    //                              A sixth domain. Each code is a full second-
    //                              factor bypass, so it is stored the way every
    //                              other bearer credential here is.
    //   api/security/pre-auth-token — PRE-AUTHENTICATION credential digests
    //                              (BACKEND-23). A seventh. This one carries a
    //                              completed password proof between the two
    //                              login factors.
    //   api/security/invitation-token — WORKSPACE INVITATION digests
    //                              (BACKEND-26). An eighth, and the only one
    //                              that grants access to a TENANT rather than
    //                              to an account. The
    //                              `lagda.workspace-invitation:` prefix is what
    //                              stops any of the other seven resolving an
    //                              invitation, or the reverse.
    //   api/security/signing-access-token — SIGNING BOOTSTRAP digests
    //                              (BACKEND-33). A ninth, and the only one held
    //                              by someone with no LAGDA account at all. The
    //                              `lagda.signing-access-bootstrap:` prefix is
    //                              what stops an invitation token opening a
    //                              signing link, which would let a workspace
    //                              invitee act as a counterparty.
    //   api/security/recipient-session-token — RECIPIENT SIGNING SESSION and
    //                              RECIPIENT CSRF digests (BACKEND-34). A tenth
    //                              and an eleventh, in ONE file because they are
    //                              issued together and must never be derived
    //                              from each other. Two constants, not one:
    //                              `lagda.recipient-signing-session:` and
    //                              `lagda.recipient-signing-csrf:`, so the CSRF
    //                              token — which is readable by design in a
    //                              double-submit scheme — cannot digest to a
    //                              value that resolves a session.
    //
    // Each addition is a deliberate entry with a named domain. A caller that
    // appears without one still fails, which is what keeps this from becoming a
    // list that grows whenever it is inconvenient.
    expect(users.sort()).toEqual([
      "packages/api/src/security/crypto.ts",
      "packages/api/src/security/invitation-token.ts",
      "packages/api/src/security/pre-auth-token.ts",
      "packages/api/src/security/rate-limit-plugin.ts",
      "packages/api/src/security/recipient-session-token.ts",
      "packages/api/src/security/recovery-codes.ts",
      "packages/api/src/security/reset-token.ts",
      "packages/api/src/security/signing-access-token.ts",
      "packages/api/src/security/verification-token.ts",
      "packages/sealing/src/internal/digest.ts",
    ]);
  });
});

describe("the sealer is deterministic", () => {
  it("reads no clock and no randomness", () => {
    // Every time-dependent and random value is supplied in the request
    // (`sealedAt`, `verificationId`). A hidden `Date.now()` would make the same
    // request produce different bytes, and the determinism test would only fail
    // when the clock happened to tick between two runs.
    const files = sourceFiles(path.join(PACKAGES, "sealing", "src")).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const source = read(file)
        // Strip comments so prose about clocks is not mistaken for a clock read.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // `new Date()` with NO argument is a clock read. `new Date(sealedAt)`
      // CONVERTS a value the caller supplied, which is the opposite — it is how
      // the sealer avoids reading a clock at all. The broader pattern flagged
      // the fix for a real nondeterminism bug, so the detector is narrowed to
      // the actual concern rather than suppressed.
      if (/\bDate\.now\s*\(|new\s+Date\s*\(\s*\)|Math\.random\s*\(|process\.env\b/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
