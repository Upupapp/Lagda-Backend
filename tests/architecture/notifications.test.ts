// Notification boundaries, enforced.
//
// BACKEND-44 makes several claims that only an executable check keeps true once
// somebody is under deadline pressure to make an email actually appear:
//
//   no email-provider SDK is a dependency          (S279, S301)
//   no route can send an arbitrary message         (S278, S288)
//   no raw secret reaches persistence or a payload (S253, S254)
//   no delivery state is claimed without a provider (S267, S312)
//   no body, address or high-cardinality id is logged or measured (S280-S282)
//
// BACKEND-45 adds three more, all of which were true by inspection when the
// transport was written and none of which stays true on its own:
//
//   the transport cannot reach the domain it reports on (S37, S38, S295)
//   the provider credential is never interpolated anywhere (S96, S217, S218)
//   the transport logs nothing at all                    (S214-S216)
//
// Each of these is one careless commit away from being false, and none of them
// is visible in a diff that looks like a feature.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = path.join(ROOT, "packages");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const read = (file: string): string => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * The transport files explain at length what they must not touch, naming
 * `SigningRequest` and `EvidenceEvent` in order to say they are unreachable. A
 * check that read those sentences as violations would punish the documentation
 * that makes the rule legible.
 */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

/** Every import specifier in a source, including dynamic and `require` forms. */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

const allSources = sourceFiles(PACKAGES);
const productionSources = allSources.filter(file => !file.endsWith(".test.ts"));
const notificationSources = productionSources.filter(file =>
  file.includes(`${path.sep}notifications${path.sep}`)
  || file.endsWith("notifications.ts"));

describe("the provider stays inside its adapter", () => {
  /**
   * Vendor SDKs and raw transports.
   *
   * BACKEND-44 forbade all of these everywhere. BACKEND-45 selected Amazon SES
   * (ADR-036), so the rule narrows rather than disappears: the SDK may exist in
   * exactly ONE infrastructure adapter and nowhere else (S5, S6).
   *
   * Narrowing rather than deleting is the point. "No SDK anywhere" stops being
   * true the moment a provider is chosen, and a test that is simply removed at
   * that moment takes the real guarantee with it — that core, application,
   * contracts and routes never learn a vendor's name.
   */
  const FORBIDDEN_PACKAGES = [
    "@sendgrid/mail", "@sendgrid/client", "postmark", "nodemailer",
    "@aws-sdk/client-ses", "aws-sdk/clients/ses", "mailgun.js", "mailgun-js",
    "resend", "@resend/node", "smtp", "emailjs",
  ];

  /**
   * The one path permitted to import the selected provider's SDK.
   *
   * A path rather than a package name, so moving the adapter is a deliberate
   * edit here rather than a silent widening.
   */
  const ADAPTER_PATH = path.join("db", "src", "email");

  /**
   * The SDK ADR-037 selected. Everything else stays forbidden outright.
   *
   * ADR-036 chose Amazon SES and was superseded the same day when the
   * deployment stack turned out to contain no AWS. The AWS packages are
   * therefore back in the forbidden set, not merely unused — a rejected vendor
   * appearing anywhere would mean a second transport path.
   */
  const SELECTED_PROVIDER_PACKAGES = ["postmark"];

  const isAdapter = (file: string): boolean => file.includes(ADAPTER_PATH);

  it("declares no provider SDK in any package manifest", () => {
    const manifests = readdirSync(PACKAGES)
      .map(pkg => path.join(PACKAGES, pkg, "package.json"))
      .filter(file => {
        try { return statSync(file).isFile(); } catch { return false; }
      });

    for (const manifest of [...manifests, path.join(ROOT, "package.json")]) {
      const parsed = JSON.parse(read(manifest)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = Object.keys({
        ...parsed.dependencies, ...parsed.devDependencies,
      });
      for (const forbidden of FORBIDDEN_PACKAGES) {
        // The selected provider's SDK is permitted as a dependency of the
        // package holding the adapter; every rejected vendor stays banned.
        if (SELECTED_PROVIDER_PACKAGES.includes(forbidden)
          && manifest.includes(`${path.sep}db${path.sep}`)) continue;
        expect(declared).not.toContain(forbidden);
      }
    }
  });

  it("imports the selected SDK only inside the adapter, and no other vendor at all", () => {
    for (const file of allSources) {
      const source = read(file);
      for (const forbidden of FORBIDDEN_PACKAGES) {
        const permittedHere =
          SELECTED_PROVIDER_PACKAGES.includes(forbidden) && isAdapter(file);
        if (permittedHere) continue;
        expect(source, `${file} imports ${forbidden}`)
          .not.toContain(`from "${forbidden}"`);
        expect(source).not.toContain(`require("${forbidden}")`);
      }
    }
  });

  it("keeps every rejected vendor banned outright", () => {
    // ADR-036 chose one provider. The alternatives were evaluated and rejected,
    // and a rejected vendor appearing anywhere means a second transport path.
    const rejected = FORBIDDEN_PACKAGES.filter(
      pkg => !SELECTED_PROVIDER_PACKAGES.includes(pkg));

    for (const file of allSources) {
      const source = read(file);
      for (const vendor of rejected) {
        expect(source, `${file} references rejected vendor ${vendor}`)
          .not.toContain(`from "${vendor}"`);
      }
    }
  });

  it("never lets core, application, contracts or routes name a vendor", () => {
    // The guarantee that survives provider selection. Replacing SES must mean
    // writing one file, not refactoring the notification domain.
    const insulated = productionSources.filter(file =>
      file.includes(path.join("core", "src"))
      || file.includes(path.join("application", "src"))
      || file.includes(path.join("contracts", "src"))
      || file.includes(path.join("api", "src")));

    for (const file of insulated) {
      const source = read(file).toLowerCase();
      // Substrings, so each must be distinctive. A bare "ses" would match
      // "responses" and "uses" and make this test a nuisance rather than a
      // guard; "@aws-sdk" and "sesv2" identify the SDK unambiguously.
      for (const vendor of ["sendgrid", "postmark", "mailgun", "nodemailer",
        "@aws-sdk", "sesv2"]) {
        expect(source, `${file} names ${vendor}`).not.toContain(vendor);
      }
    }
  });

  it("opens no SMTP socket", () => {
    // A hand-rolled SMTP client would evade the dependency check entirely.
    for (const file of productionSources) {
      const source = read(file);
      expect(source).not.toMatch(/createConnection\s*\(\s*\{?\s*port:\s*(25|465|587)/u);
    }
  });
});

describe("no arbitrary send API", () => {
  it("registers no notification route", () => {
    // S105, S278. There is no user-facing notification surface at all: not a
    // send endpoint, and not a notification centre the product does not have.
    const apiSources = productionSources.filter(file =>
      file.includes(`${path.sep}api${path.sep}`));

    for (const file of apiSources) {
      const source = read(file);
      expect(source).not.toMatch(/["'`]\/notifications/u);
      expect(source).not.toMatch(/["'`][^"'`]*\/notifications\/send/u);
    }
  });

  it("exposes creation only through the application use case", () => {
    // Every producer must go through `createNotificationIntent`, which applies
    // the policy. A direct repository call from a route would bypass it.
    const routeSources = productionSources.filter(file =>
      file.includes(`${path.sep}api${path.sep}`));

    for (const file of routeSources) {
      expect(read(file)).not.toContain("createIfAbsent");
    }
  });
});

describe("secrets stay out of ordinary structures", () => {
  it("keeps raw credential names out of the persisted template models", () => {
    // S78, S80. The schemas are the contract for what lands in JSONB.
    const registry = read(path.join(
      PACKAGES, "application", "src", "notifications", "template-registry.ts"));
    const modelSection = registry.slice(registry.indexOf("Shared model fragments"));

    for (const forbidden of ["resetToken", "otp", "signingToken", "rawSecret",
      "verificationToken", "invitationToken", "password"]) {
      expect(modelSection).not.toContain(forbidden);
    }
  });

  it("keeps the queue payload to identifiers", () => {
    // S123-S126. The schema is the whole guarantee.
    const jobs = read(path.join(
      PACKAGES, "application", "src", "common", "ports", "jobs.ts"));
    const schema = jobs.slice(
      jobs.indexOf("NotificationDeliveryPayloadSchema = Type.Object("),
      jobs.indexOf("export type NotificationDeliveryPayload"));

    expect(schema).toContain("notificationDeliveryId");
    for (const forbidden of ["destination", "email", "subject", "body",
      "secret", "token", "sealed"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("never writes a rendered body to a column", () => {
    // S77, S154. The migration is where this would happen.
    const migration = read(path.join(
      PACKAGES, "db", "src", "migrations", "030_notifications.ts"));
    const tableSection = migration.slice(migration.indexOf("create table notification_intents"));

    for (const forbidden of ["subject ", "text_body", "html_body", "rendered_body"]) {
      expect(tableSection).not.toContain(forbidden);
    }
  });
});

describe("no delivery is claimed without a provider", () => {
  it("writes only PENDING as an initial state", () => {
    const repository = read(path.join(
      PACKAGES, "db", "src", "repositories", "notifications.ts"));

    // The single `state:` value written on insert.
    const inserted = [...repository.matchAll(/state:\s*"([A-Z_]+)"/gu)]
      .map(match => match[1]);
    expect(inserted).toEqual(["PENDING"]);
  });

  it("never names a provider state on the intent-creation path", () => {
    // ── Narrowed by BACKEND-45, and this is the part worth reading ──────────
    //
    // BACKEND-44 wrote this as "nowhere in the substrate", which was right
    // while nothing could produce a provider state. Transport now legitimately
    // does, so the blanket ban would have to be answered with an ever-growing
    // allowlist -- and an allowlist that grows whenever it fires stops being a
    // check and becomes a record of who edited what.
    //
    // So the rule is restated as the thing that must actually stay true: the
    // path that CREATES a notification cannot fabricate a provider's
    // observation. Deciding what to send, choosing a template and rendering a
    // body all happen before any provider exists, and none of them may name a
    // state only a provider can establish.
    //
    // Transport is checked by its own rules elsewhere: the confirmer's
    // vocabulary is asserted to be exactly DELIVERED and BOUNCED, and the
    // transition table forbids every regression.
    const CREATION_PATH = [
      ["application", "src", "notifications", "create-intent.ts"],
      ["application", "src", "notifications", "policy.ts"],
      ["application", "src", "notifications", "templates.ts"],
      ["application", "src", "notifications", "rendering.ts"],
      ["application", "src", "notifications", "template-registry.ts"],
    ];

    for (const segments of CREATION_PATH) {
      const file = path.join(PACKAGES, ...segments);
      const source = code(file);
      for (const state of ["PROVIDER_ACCEPTED", "DELIVERED", "BOUNCED"]) {
        expect({ file: segments.join("/"), state, named: source.includes(`"${state}"`) })
          .toEqual({ file: segments.join("/"), state, named: false });
      }
    }
  });

  it("still inserts only PENDING, whatever transport later does", () => {
    // The other half of S267 and S312, and the one that cannot be relaxed. A
    // delivery is born PENDING; every richer state is earned by something
    // happening.
    const repository = read(path.join(
      PACKAGES, "db", "src", "repositories", "notifications.ts"));
    expect(repository).not.toMatch(/state:\s*"(PROVIDER_ACCEPTED|DELIVERED|BOUNCED)"/u);
  });
});

describe("privacy in logs and metrics", () => {
  it("logs no destination, subject or body", () => {
    // S280, S281. Nothing in the substrate may reach a logger with content.
    for (const file of notificationSources) {
      const source = read(file);
      expect(source).not.toMatch(/log(ger)?\.(info|warn|error|debug)\([^)]*destination/u);
      expect(source).not.toMatch(/log(ger)?\.(info|warn|error|debug)\([^)]*textBody/u);
      expect(source).not.toMatch(/log(ger)?\.(info|warn|error|debug)\([^)]*subject/u);
      expect(source).not.toContain("console.log");
    }
  });

  it("uses no high-cardinality value as a metric label", () => {
    // S282. Intent ids, delivery ids, workspace ids, emails and source ids are
    // all unbounded; one of them as a label is a cardinality explosion that
    // takes the metrics backend down rather than the application.
    for (const file of notificationSources) {
      const source = read(file);
      expect(source).not.toMatch(/labels?\s*:\s*\{[^}]*notificationIntentId/u);
      expect(source).not.toMatch(/labels?\s*:\s*\{[^}]*notificationDeliveryId/u);
      expect(source).not.toMatch(/labels?\s*:\s*\{[^}]*destination/u);
      expect(source).not.toMatch(/labels?\s*:\s*\{[^}]*sourceId/u);
    }
  });
});

describe("layering", () => {
  it("keeps the notification domain out of core's infrastructure reach", () => {
    // `core` may hold the delivery state machine because it is pure. It may not
    // learn what a repository or a template registry is.
    const coreNotifications = productionSources.filter(file =>
      file.includes(path.join("core", "src", "notifications")));

    expect(coreNotifications.length).toBeGreaterThan(0);
    for (const file of coreNotifications) {
      const source = read(file);
      expect(source).not.toContain("@lagda/db");
      expect(source).not.toContain("@lagda/application");
      expect(source).not.toContain("NotificationRepository");
    }
  });

  it("keeps the application substrate free of a concrete adapter", () => {
    const applicationNotifications = productionSources.filter(file =>
      file.includes(path.join("application", "src", "notifications")));

    for (const file of applicationNotifications) {
      const source = read(file);
      expect(source).not.toContain("@lagda/db");
      expect(source).not.toContain("kysely");
    }
  });
});

// ── BACKEND-45 ──────────────────────────────────────────────────────────────

const emailSources = productionSources.filter(file =>
  file.includes(path.join("email", "src")));

/** The transport files: the vendor adapter, and the use case that drives it. */
const transportSources = [
  ...emailSources,
  path.join(PACKAGES, "application", "src", "notifications", "deliver.ts"),
];

describe("the transport cannot reach the domain it reports on", () => {
  it("has an adapter package to check", () => {
    // A filter that silently matched nothing would make every assertion below
    // pass by vacuum -- the failure mode an architecture test is least able to
    // notice about itself.
    expect(emailSources.length).toBeGreaterThan(0);
  });

  it("imports nothing from a signing, evidence or audit module", () => {
    // S37, S38. A delivery outcome is not a fact about a signer. The rule is
    // held by the import graph rather than by care: a file that cannot name a
    // SigningRequest cannot update one under deadline pressure.
    const offenders: string[] = [];
    for (const file of transportSources) {
      for (const specifier of importsOf(code(file))) {
        if (/signing|evidence|audit|ceremony|submission|recipients/u.test(specifier)) {
          offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no signing, recipient or evidence record", () => {
    // The import check alone would miss a repository reached through an
    // injected dependency, so the identifiers themselves are banned too.
    const forbidden = [
      "SigningRequest", "EvidenceEvent", "RecipientProgress",
      "RecipientSubmission", "signingRequestId", "recipientId",
    ];
    for (const file of transportSources) {
      const source = code(file);
      for (const name of forbidden) {
        expect({ file: path.relative(ROOT, file), name, found: source.includes(name) })
          .toEqual({ file: path.relative(ROOT, file), name, found: false });
      }
    }
  });

  it("confirms a webhook event into two transport states and no others", () => {
    // S37. A confirmed provider event may establish DELIVERED or BOUNCED.
    // PROVIDER_ACCEPTED is established synchronously by the send call, and a
    // callback claiming it later would be a provider narrating LAGDA's past.
    const confirmer = code(path.join(PACKAGES, "email", "src", "postmark-events.ts"));
    const states = new Set(
      [...confirmer.matchAll(/"(PENDING|PROCESSING|PROVIDER_ACCEPTED|DELIVERED|BOUNCED|FAILED_RETRYABLE|FAILED_TERMINAL|SUPPRESSED|CANCELLED)"/gu)]
        .map(match => match[1]));
    expect([...states].sort()).toEqual(["BOUNCED", "DELIVERED"]);
  });
});

describe("the provider credential never leaves its header", () => {
  it("is never interpolated into a string", () => {
    // S96, S217, S218. The token is a header value and nothing else. An
    // interpolation is how it reaches a URL, a log line or an error message --
    // all three of which are retained somewhere LAGDA does not control.
    for (const file of emailSources) {
      expect(code(file)).not.toMatch(/\$\{[^}]*(serverToken|webhookSecret)/u);
    }
  });

  it("logs nothing at all", () => {
    // S214-S216, S220. The transport handles a destination address, a subject,
    // a rendered body and a credential. It has no logger dependency, which is
    // the only version of this rule that cannot be got wrong in a hurry.
    for (const file of transportSources) {
      const source = code(file);
      expect(source).not.toContain("console.");
      expect(source).not.toMatch(/log(ger)?\.(info|warn|error|debug|trace)\(/u);
    }
  });

  it("returns no provider text to its caller", () => {
    // S219. Provider errors routinely echo the destination address, the
    // subject and the request payload. None of that can be redacted later if
    // it never crosses the boundary -- so the result carries an outcome and a
    // reference, and the response body is read for nothing else.
    const adapter = code(path.join(PACKAGES, "email", "src", "postmark.ts"));
    // `MessageID` is read and returned; `Message` -- Postmark's human-readable
    // error text -- is not read at all, and is not even declared.
    expect(adapter).not.toMatch(/\bMessage\b(?!ID|Stream)/u);
    expect(adapter).not.toContain("statusText");
  });
});
