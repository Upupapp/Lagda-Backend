// Provider delivery events, and why the webhook body is not evidence of them.
//
// ── The rule this file exists to obey ──────────────────────────────────────
//
// A webhook body is never trusted (S31). Postmark authenticates its callbacks
// with HTTP basic auth over TLS rather than a payload signature, so anyone who
// learns the endpoint and its credentials could otherwise post `Delivered` for
// any message reference they can guess.
//
// So the callback is treated as a HINT: something happened, go and look. The
// fact is then confirmed against Postmark's own API by message reference (S39),
// and only the confirmed value moves any state. Under that design a forged
// webhook costs one wasted lookup rather than a forged delivery status.
//
// ADR-037 accepted Postmark's weaker webhook authentication precisely because
// this design is required anyway — it would have been built for a provider
// with signed payloads too.
//
// ── What a confirmed event may and may not do ──────────────────────────────
//
// It may move a `NotificationDelivery` between transport states. It may not
// touch a signing request, a recipient, an evidence event or an audit entry
// (S37, S38). Nothing in this file imports anything that could.

import { timingSafeEqual } from "node:crypto";
import type { PostmarkConfig } from "./config.js";

/**
 * The transport states a confirmed provider event can establish.
 *
 * Deliberately a subset of the delivery vocabulary: a provider reports what it
 * observed, and LAGDA decides what that means. `PROVIDER_ACCEPTED` is not here
 * because acceptance is established synchronously by the send call, not by a
 * callback arriving later.
 */
export type ConfirmedEventState = "DELIVERED" | "BOUNCED";

export type WebhookOutcome =
  /** Credentials did not match. Nothing was read, nothing was looked up. */
  | { readonly result: "UNAUTHENTICATED" }
  /** The body was unusable. Accepted and dropped — never retried at us. */
  | { readonly result: "IGNORED"; readonly reason: string }
  /** Confirmed against the provider API. Safe to apply. */
  | {
      readonly result: "CONFIRMED";
      readonly providerMessageReference: string;
      readonly state: ConfirmedEventState;
    };

/**
 * Compares webhook credentials without leaking their length or content by
 * timing.
 *
 * `timingSafeEqual` throws on length mismatch, which is itself a timing
 * distinguisher, so both sides are hashed to a fixed width first — the same
 * shape every credential comparison in this repository uses.
 */
export function credentialsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do a comparison of equal length, so a wrong-length credential
    // takes the same time as a wrong-value one.
    const filler = Buffer.alloc(b.length);
    timingSafeEqual(filler, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Only the two fields LAGDA reads. Everything else in the body is ignored. */
interface PostmarkWebhookBody {
  readonly RecordType?: string;
  readonly MessageID?: string;
}

interface PostmarkMessageDetails {
  readonly MessageEvents?: readonly { readonly Type?: string }[];
}

export interface PostmarkEventDependencies {
  readonly config: PostmarkConfig;
  readonly fetchImpl?: typeof fetch;
  /** The basic-auth password the webhook endpoint expects. */
  readonly webhookSecret: string;
}

/**
 * Authenticates a callback, then confirms what it claims.
 *
 * Returns `IGNORED` rather than an error for anything unusable — an unknown
 * message reference (S40), a record type LAGDA does not act on, a body without
 * an id. A provider that receives an error retries, and retrying a callback
 * about a message LAGDA has never heard of achieves nothing but load.
 */
export function createPostmarkEventConfirmer(deps: PostmarkEventDependencies) {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.config.apiBaseUrl.replace(/\/+$/u, "");

  return async (
    presentedSecret: string | null,
    rawBody: unknown,
  ): Promise<WebhookOutcome> => {
    if (presentedSecret === null
      || !credentialsMatch(presentedSecret, deps.webhookSecret)) {
      return { result: "UNAUTHENTICATED" };
    }

    const body = (rawBody ?? {}) as PostmarkWebhookBody;
    const reference = body.MessageID;
    if (typeof reference !== "string" || reference === "") {
      return { result: "IGNORED", reason: "no message reference" };
    }

    // LAGDA acts on two record types. Opens and clicks are not subscribed and
    // would not be actionable if they arrived: tracking is disabled, and a
    // recipient's reading behaviour is not something this product records.
    if (body.RecordType !== "Delivery" && body.RecordType !== "Bounce") {
      return { result: "IGNORED", reason: "record type not actioned" };
    }

    // THE CONFIRMATION. Everything above came from the caller; nothing above
    // has moved any state, and nothing below trusts it.
    let details: PostmarkMessageDetails;
    try {
      const response = await doFetch(
        `${base}/messages/outbound/${encodeURIComponent(reference)}/details`,
        {
          method: "GET",
          signal: AbortSignal.timeout(deps.config.timeoutMs),
          headers: {
            Accept: "application/json",
            "X-Postmark-Server-Token": deps.config.serverToken,
          },
        });

      // 404 is the forged-or-stale case and the one this design exists for: a
      // reference LAGDA was told about that Postmark does not recognise.
      if (!response.ok) {
        return { result: "IGNORED", reason: `provider lookup returned ${response.status}` };
      }
      details = (await response.json()) as PostmarkMessageDetails;
    } catch {
      // A lookup that failed proves nothing either way, so nothing moves. The
      // delivery keeps whatever state the send established.
      return { result: "IGNORED", reason: "provider lookup failed" };
    }

    const types = new Set(
      (details.MessageEvents ?? []).map(event => event.Type).filter(Boolean));

    // A bounce outranks a delivery when the provider reports both, because the
    // later, worse fact is the one that matters operationally.
    if (types.has("Bounced")) {
      return { result: "CONFIRMED", providerMessageReference: reference, state: "BOUNCED" };
    }
    if (types.has("Delivered")) {
      return { result: "CONFIRMED", providerMessageReference: reference, state: "DELIVERED" };
    }

    // The callback said something happened and the provider's own record does
    // not show it. Trust the record.
    return { result: "IGNORED", reason: "provider record does not confirm the event" };
  };
}
