// The provider callback vocabulary — kept as a pure type, with no
// implementation behind it under SMTP.
//
// `registerProviderWebhookRoutes` (packages/api) is generic, reusable
// plumbing: it takes any confirmer matching this shape and knows nothing
// about which vendor built it. That stays true even though nothing
// implements the shape right now (`createProviderEventConfirmerFromEnv`
// always returns null — see composition.ts) — a future provider with a real
// delivery/bounce webhook can fill this back in without the route layer
// changing at all.

/**
 * The transport states a confirmed provider event can establish.
 *
 * `PROVIDER_ACCEPTED` is not here because acceptance is established
 * synchronously by the send call, not by a callback arriving later.
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
