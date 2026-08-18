// The provider callback surface (BACKEND-45 §35).
//
//   POST /webhooks/email    basic auth, no session, no workspace
//
// ── The only route in LAGDA authenticated by a shared secret ───────────────
//
// Not a session, not a signing credential, not an invitation token. The
// selected provider (ADR-037) authenticates its callbacks with HTTP basic auth
// over TLS because it signs nothing — so the credential here is weaker than
// anything else in this codebase, and the design compensates rather than
// pretending otherwise.
//
// A callback is a HINT. It is authenticated, then the claim it makes is
// CONFIRMED against the provider's own API by message reference, and only the
// confirmed value moves state (S31). A forged callback costs one wasted
// provider lookup instead of a forged delivery status.
//
// ── The path names no vendor, and that is not cosmetic ─────────────────────
//
// `/webhooks/email/<vendor>` would put a provider name in the one place that
// cannot be changed quietly: a URL already configured in a third party's
// dashboard and already receiving traffic. Switching providers would then mean
// coordinating a URL change with a credential change during a cutover, instead
// of pointing the new provider at the same endpoint. The route knows which
// provider it is talking to only through the injected confirmer, which is where
// INV-665 says vendor knowledge belongs.
//
// ── Why almost everything answers 204 ──────────────────────────────────────
//
// A provider that receives an error retries. Retrying a callback about a
// message LAGDA has never heard of, or one whose record does not corroborate
// it, achieves nothing but load — so unknown references, unsubscribed record
// types, bodies without an id and failed lookups are all accepted and dropped
// (S40, S125). The only non-2xx is 401, and only for a caller who presented no
// usable credential.
//
// ── What this route cannot reach ───────────────────────────────────────────
//
// A SigningRequest, a recipient, a submission, a completion, an evidence event.
// Not by care — by construction: `applyProviderEvent` enters a transaction
// whose unit of work carries two notification repositories and nothing else
// (S37, S38).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  applyProviderEvent, type ApplyProviderEventDependencies,
} from "@lagda/application";
import type { WebhookOutcome } from "@lagda/email";

/**
 * The body, bounded by the server's own limit and otherwise unexamined (S205).
 *
 * `additionalProperties: true` is deliberate and is the one place in this
 * codebase where it is. A provider callback carries dozens of fields and gains
 * more between versions; rejecting unknown properties would turn a vendor's
 * routine change into an outage. LAGDA reads exactly two fields and the
 * confirmer ignores the rest — so the looseness costs nothing, because nothing
 * downstream trusts the body anyway.
 */
const WebhookBodySchema = Type.Object({}, { additionalProperties: true });

/** Confirms a callback against the provider. Supplied by the composition root. */
export type ProviderEventConfirmer = (
  presentedSecret: string | null,
  rawBody: unknown,
) => Promise<WebhookOutcome>;

export interface ProviderWebhookRouteOptions {
  readonly confirm: ProviderEventConfirmer;
  readonly eventDependencies: ApplyProviderEventDependencies;
}

/**
 * Extracts the basic-auth password, or null.
 *
 * Null for anything that is not a well-formed `Basic` header — no header, a
 * different scheme, undecodable base64, no colon. Every one of them reaches the
 * same refusal, and the CONFIRMER does the comparison, in fixed time. Nothing
 * here compares a credential, so nothing here can leak one by timing.
 */
export function presentedSecret(request: {
  readonly headers: { readonly authorization?: string | undefined };
}): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;

  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || encoded === undefined) return null;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? null : decoded.slice(separator + 1);
}

export function registerProviderWebhookRoutes(
  app: FastifyInstance,
  options: ProviderWebhookRouteOptions,
): void {
  const apply = applyProviderEvent(options.eventDependencies);

  app.post("/webhooks/email", {
    schema: {
      // Absent from the published contract on purpose. This is a
      // provider-to-LAGDA interface, not part of the customer API, and putting
      // it in the OpenAPI document would advertise an endpoint whose only
      // protection is a shared secret.
      hide: true,
      body: WebhookBodySchema,
    },
  }, async (request: FastifyRequest, reply) => {
    const outcome = await options.confirm(presentedSecret(request), request.body);

    if (outcome.result === "UNAUTHENTICATED") {
      // The one refusal. No body, no detail: a caller learns the credential was
      // wrong and nothing about what a right one looks like.
      return reply.code(401).send();
    }

    if (outcome.result === "IGNORED") {
      // Accepted and dropped. The reason is deliberately not returned — it
      // would tell a credential-holding caller which references LAGDA
      // recognises, which is the oracle the reference-based binding exists to
      // avoid.
      return reply.code(204).send();
    }

    await apply({
      providerMessageReference: outcome.providerMessageReference,
      state: outcome.state,
    });

    // 204 whether the delivery moved or not. A duplicate callback and a
    // first-time one are the same event from the provider's point of view, and
    // distinguishing them in the response would leak delivery state to whoever
    // holds the webhook credential.
    return reply.code(204).send();
  });
}
