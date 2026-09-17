// Building the transport from an environment, without telling anyone which
// vendor it is.
//
// ── Why this exists rather than a few lines in a composition root ──────────
//
// Two architecture rules meet here and both are right. `@lagda/api` may not
// name a vendor (INV-665), and it may not read `process.env` outside its config
// loader — a package that reads the environment behaves differently depending
// on where it runs.
//
// A composition root that built the transport itself would break both at
// once, and the fix is not an exemption: the knowledge genuinely belongs here.
// The caller asks "does this environment have a provider callback?" and gets
// one or nothing. It never learns the answer's brand.
//
// ── Provider callbacks: gone, not stubbed ───────────────────────────────────
//
// Postmark confirmed delivery/bounce events via a signed webhook plus a
// look-up-by-reference call against its own API (see the removed
// postmark-events.ts) — a mechanism that exists because Postmark is an HTTP
// API with its own event model. Plain SMTP has no equivalent: there is no
// callback, no message-reference lookup, nothing to confirm against. This
// function keeps its name and shape (so `@lagda/api`'s composition root needs
// no changes at all — see start-server.ts's `buildProviderWebhook`, which
// already treats "no credential" as "register no route") and simply always
// returns null. `DELIVERED`/`BOUNCED` are accordingly unreachable under SMTP,
// which the notification substrate's own docs already anticipate as a valid,
// honest degradation (see NOTIFICATION_DELIVERY_STATES) rather than a gap.

import type { EmailDeliveryProvider } from "@lagda/application";
import { loadSmtpConfig } from "./config.js";
import { createSmtpEmailProvider } from "./smtp.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Always null under SMTP. Kept as a stable export so a future provider that
 * DOES have a callback mechanism can fill it back in without any caller
 * needing to change — see the module comment above.
 */
export function createProviderEventConfirmerFromEnv(
  _env: Env = process.env,
): null {
  return null;
}

/**
 * Null when this deployment cannot send.
 *
 * Absent capability is absent, never a stub that fails on use. A provider
 * that rejected every send would burn each delivery's attempt budget to
 * discover what configuration already knew.
 */
export function createEmailProviderFromEnv(
  env: Env = process.env,
): EmailDeliveryProvider | null {
  if ((env["SMTP_PASSWORD"] ?? "") === "") return null;
  return createSmtpEmailProvider(loadSmtpConfig(env));
}
