// Deployment preflight: what this environment still needs before it can run.
//
// Reads configuration ONLY. It opens no database connection, contacts no
// provider and sends nothing — so it is safe to run against production
// environment variables, which is precisely when it is useful.
//
//   node infra/preflight.mjs            check process.env
//   node infra/preflight.mjs --env .env  check a file without exporting it
//
// Exits non-zero if anything REQUIRED is missing, so it can gate a deploy.

import { readFileSync } from "node:fs";

/**
 * Every variable, why it exists, and what breaks without it.
 *
 * `required` means the process will not start or will not function. `optional`
 * means a documented default applies. `manual` marks the ones that cannot be
 * satisfied by anybody with a keyboard and this repository — they need an
 * account, a DNS record or a vendor approval.
 */
const VARIABLES = [
  { name: "DATABASE_URL", level: "required",
    why: "The application database. No default exists and none should." },
  { name: "SIGNING_DELIVERY_KEY", level: "required", manual: false,
    why: "Opens sealed signing credentials at render time. Without it every "
       + "secret-bearing message resolves UNUSABLE and is suppressed — a "
       + "worker that looks healthy while silently sending nothing.",
    generate: "openssl rand -base64 32" },
  { name: "SIGNING_DELIVERY_KEY_VERSION", level: "optional", why: "Defaults to v1." },
  { name: "APP_BASE_URL", level: "required",
    why: "Where first-party links point. Never taken from a request header." },

  { name: "POSTMARK_SERVER_TOKEN", level: "required", manual: true,
    why: "The provider credential. Needs a Postmark server." },
  { name: "POSTMARK_MESSAGE_STREAM", level: "required", manual: true,
    why: "The transactional stream. Explicit rather than defaulted, so a "
       + "security email cannot inherit a broadcast reputation." },
  { name: "EMAIL_FROM_ADDRESS", level: "required", manual: true,
    why: "Must be on a verified sending domain with DKIM aligned." },
  { name: "EMAIL_FROM_DISPLAY_NAME", level: "optional", why: "Defaults to LAGDA." },
  { name: "EMAIL_REPLY_TO_ADDRESS", level: "optional",
    why: "Omit unless somebody reads it. An unowned reply-to is worse than none." },
  { name: "EMAIL_TIMEOUT_MS", level: "optional", why: "Defaults to 10000. Range 1000-30000." },
  { name: "POSTMARK_WEBHOOK_SECRET", level: "optional", manual: true,
    why: "Chosen by LAGDA, set in the provider's webhook config. Absent means "
       + "the callback route DOES NOT EXIST, which is safe — DELIVERED and "
       + "BOUNCED simply stay unreachable.",
    generate: "openssl rand -hex 32" },

  { name: "DELIVERY_LEASE_MS", level: "optional", why: "Defaults to 120000. Range 60000-900000." },
  { name: "DELIVERY_MAX_ATTEMPTS", level: "optional", why: "Defaults to 3. Range 1-10." },
  { name: "DISPATCH_CRON", level: "optional", why: "Defaults to every minute." },
  { name: "DISPATCH_BATCH_SIZE", level: "optional", why: "Defaults to 200." },
  { name: "WORKER_SCHEDULES_ENABLED", level: "optional",
    why: "Must be \"true\" on exactly one deployment, or nothing is ever swept." },

  { name: "DATABASE_TEST_URL", level: "testing", manual: true,
    why: "Roughly 688 integration tests SKIP without it — every RLS, claim-race, "
       + "lease-reclaim and migration check. They have never been executed." },
];

function loadEnv(argv) {
  const index = argv.indexOf("--env");
  if (index === -1) return process.env;
  const path = argv[index + 1];
  if (path === undefined) throw new Error("--env needs a file path.");
  const parsed = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    parsed[trimmed.slice(0, at).trim()] =
      trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return parsed;
}

const env = loadEnv(process.argv);
const present = name => (env[name] ?? "") !== "";

const missing = { required: [], manual: [], testing: [], optional: [] };
for (const variable of VARIABLES) {
  if (present(variable.name)) continue;
  const bucket = variable.level === "required" && variable.manual === true
    ? "manual" : variable.level;
  missing[bucket].push(variable);
}

// Never print a VALUE, only a name. This tool is meant to be run against
// production configuration and pasted into a chat window.
const show = (title, list) => {
  if (list.length === 0) return;
  process.stdout.write(`\n${title}\n`);
  for (const variable of list) {
    process.stdout.write(`  ${variable.name}\n      ${variable.why}\n`);
    if (variable.generate !== undefined) {
      process.stdout.write(`      generate: ${variable.generate}\n`);
    }
  }
};

process.stdout.write("LAGDA backend preflight\n");
show("MISSING — blocks startup, and you can set these yourself:", missing.required);
show("MISSING — needs an account, a domain or a vendor approval:", missing.manual);
show("MISSING — blocks the integration suite only:", missing.testing);
show("Absent, using documented defaults:", missing.optional);

const blocking = missing.required.length + missing.manual.length;
if (blocking === 0) {
  process.stdout.write("\nEverything required is present.\n");
} else {
  process.stdout.write(`\n${String(blocking)} required variable(s) missing.\n`);
}
process.exit(blocking === 0 ? 0 : 1);
