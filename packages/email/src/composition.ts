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
// A composition root that built a Postmark confirmer itself would break both at
// once, and the fix is not an exemption: the knowledge genuinely belongs here.
// The caller asks "does this environment have a provider callback?" and gets one
// or nothing. It never learns the answer's brand.

import { loadPostmarkConfig, EmailConfigError } from "./config.js";
import {
  createPostmarkEventConfirmer, type WebhookOutcome,
} from "./postmark-events.js";
import { createPostmarkEmailProvider } from "./postmark.js";
import type { EmailDeliveryProvider } from "@lagda/application";

/** Confirms a provider callback. Vendor-neutral by signature and by name. */
export type ProviderEventConfirmer = (
  presentedSecret: string | null,
  rawBody: unknown,
) => Promise<WebhookOutcome>;

/**
 * The environment, defaulted.
 *
 * Every other function in this package takes a plain record and this one
 * defaults it, deliberately: the callers are composition roots that must not
 * touch `process.env` themselves, and a required parameter would push the read
 * back into exactly the packages the rule protects. Tests still pass a record.
 */
type Env = Readonly<Record<string, string | undefined>>;

/**
 * Null when this deployment has no callback credential.
 *
 * Null rather than a confirmer that refuses everything: the caller's correct
 * response is to register no route at all, and a confirmer that always says
 * UNAUTHENTICATED would produce an endpoint that exists, answers 401, and
 * advertises that LAGDA has a webhook somewhere.
 *
 * @throws when a credential IS present and the rest of the email configuration
 *   is not. That is a half-configured deployment, and the quiet version of it
 *   is an endpoint that authenticates callers and then fails every lookup.
 */
export function createProviderEventConfirmerFromEnv(
  env: Env = process.env,
): ProviderEventConfirmer | null {
  const webhookSecret = env["POSTMARK_WEBHOOK_SECRET"] ?? "";
  if (webhookSecret === "") return null;

  let config;
  try {
    config = loadPostmarkConfig(env);
  } catch (error) {
    if (error instanceof EmailConfigError) {
      throw new EmailConfigError(
        `A webhook credential is set but email is misconfigured: ${error.message}`);
    }
    throw error;
  }

  return createPostmarkEventConfirmer({ config, webhookSecret });
}

/**
 * Null when this deployment cannot send.
 *
 * Same shape and same reasoning as the confirmer: absent capability is absent,
 * never a stub that fails on use. A provider that rejected every send would
 * burn each delivery's attempt budget to discover what configuration already
 * knew.
 */
export function createEmailProviderFromEnv(
  env: Env = process.env,
): EmailDeliveryProvider | null {
  if ((env["POSTMARK_SERVER_TOKEN"] ?? "") === "") return null;
  return createPostmarkEmailProvider(loadPostmarkConfig(env));
}
