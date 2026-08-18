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
const allSources = sourceFiles(PACKAGES);
const productionSources = allSources.filter(file => !file.endsWith(".test.ts"));
const notificationSources = productionSources.filter(file =>
  file.includes(`${path.sep}notifications${path.sep}`)
  || file.endsWith("notifications.ts"));

describe("no email provider is introduced", () => {
  /**
   * The vendors BACKEND-45 will choose between, and the transports it might use.
   *
   * BACKEND-44 must select none of them (S301). The point of the provider-
   * neutral substrate is that this choice stays open and stays reversible.
   */
  const FORBIDDEN_PACKAGES = [
    "@sendgrid/mail", "@sendgrid/client", "postmark", "nodemailer",
    "@aws-sdk/client-ses", "aws-sdk/clients/ses", "mailgun.js", "mailgun-js",
    "resend", "@resend/node", "smtp", "emailjs",
  ];

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
        expect(declared).not.toContain(forbidden);
      }
    }
  });

  it("imports no provider SDK anywhere in source", () => {
    for (const file of allSources) {
      const source = read(file);
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(source).not.toContain(`from "${forbidden}"`);
        expect(source).not.toContain(`require("${forbidden}")`);
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

  it("never names a provider state as a value anywhere in the substrate", () => {
    // Declaring the vocabulary is fine; producing it is not. The only files
    // permitted to mention these are the state machine, the port and the
    // migration -- all of which DECLARE rather than write.
    const writers = notificationSources.filter(file =>
      !file.endsWith("delivery-state.ts")
      && !file.endsWith("notifications.ts")
      && !file.endsWith("030_notifications.ts"));

    for (const file of writers) {
      const source = read(file);
      for (const state of ["PROVIDER_ACCEPTED", "DELIVERED", "BOUNCED"]) {
        expect(source).not.toContain(`"${state}"`);
      }
    }
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
