// The Postmark transport.
//
// ── Why there is no SDK ────────────────────────────────────────────────────
//
// Postmark's send API is one JSON POST with one header. Node 24 has `fetch`.
// An SDK would add a dependency, a release cadence and a surface area to audit,
// in exchange for wrapping a call this file makes in twenty lines — and §301
// asks for no new production dependency where one is avoidable.
//
// It also keeps the timeout, the abort behaviour and the failure
// classification under LAGDA's control rather than a vendor's defaults, and
// those three are exactly what decides whether a security email is retried,
// abandoned, or duplicated.
//
// ── What this file is not allowed to know ──────────────────────────────────
//
// What a notification means. It receives a finished `EmailMessage` and returns
// an outcome. It does not select templates, resolve secrets, read the database,
// or touch delivery state (S219).

import type {
  EmailDeliveryProvider, EmailMessage, EmailDeliveryResult,
} from "@lagda/application";
import type { PostmarkConfig } from "./config.js";

/**
 * Postmark error codes that mean the message will never be accepted.
 *
 * A retry against any of these burns the attempt budget to produce the same
 * rejection, and delays the dead-letter signal that tells an operator the
 * address is wrong or the account is misconfigured.
 *
 * Everything not listed is treated as retryable, which is the safe default for
 * security mail: a wrongly-retried message costs a duplicate of a credential
 * that still works, while a wrongly-abandoned one is a password reset that
 * never arrives.
 */
const TERMINAL_ERROR_CODES = new Set([
  300, // Invalid email request — malformed payload
  400, // Sender signature not confirmed
  401, // Sender signature not found
  406, // Inactive recipient — hard-bounced or marked spam previously
  409, // JSON required
]);

interface PostmarkResponse {
  readonly ErrorCode?: number;
  readonly MessageID?: string;
  readonly Message?: string;
}

/**
 * Builds the transport.
 *
 * `fetchImpl` is injectable so the classification table can be tested against
 * every response shape without a network or a Postmark account — the part of
 * this file most likely to be wrong is the mapping, not the request.
 */
export function createPostmarkEmailProvider(
  config: PostmarkConfig,
  fetchImpl: typeof fetch = fetch,
): EmailDeliveryProvider {
  const endpoint = `${config.apiBaseUrl.replace(/\/+$/u, "")}/email`;

  return {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      // Bounded, and aborted rather than left hanging. A worker blocked on a
      // provider holds a delivery claim; a claim held past its lease is
      // reclaimed and retried, which is the duplicate send the lease exists to
      // prevent.
      const abort = AbortSignal.timeout(config.timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          signal: abort,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            // The credential. Never logged, and never placed in a URL where a
            // proxy or an access log would keep it.
            "X-Postmark-Server-Token": config.serverToken,
          },
          body: JSON.stringify({
            From: `${config.envelope.fromDisplayName} <${config.envelope.fromAddress}>`,
            To: message.destination,
            Subject: message.subject,
            TextBody: message.textBody,
            ...(message.htmlBody === undefined ? {} : { HtmlBody: message.htmlBody }),
            ...(config.envelope.replyToAddress === undefined
              ? {}
              : { ReplyTo: config.envelope.replyToAddress }),
            MessageStream: config.envelope.messageStream,
            // Non-negotiable, and sent explicitly rather than trusted to the
            // stream's configuration. Link tracking rewrites the signing URL,
            // so the credential-bearing link a signer clicks would belong to
            // Postmark rather than to LAGDA (INV-652, S27). Open tracking
            // embeds a pixel in a legal notice (S26).
            TrackOpens: false,
            TrackLinks: "None",
          }),
        });
      } catch {
        // The ambiguous case, and the reason it is its own class.
        //
        // A timeout or a dropped connection may have happened before the
        // request left, or after Postmark accepted it. LAGDA cannot tell, and
        // guessing either way is wrong in a different direction: called a
        // failure it invites a duplicate, called a success it loses a security
        // email silently. The caller retries under a bounded budget with the
        // same credential.
        return { outcome: "AMBIGUOUS" };
      }

      let body: PostmarkResponse = {};
      try {
        body = (await response.json()) as PostmarkResponse;
      } catch {
        // A 200 whose body will not parse is not an acceptance we can record —
        // there is no MessageID to reconcile against later.
        return response.ok ? { outcome: "AMBIGUOUS" } : { outcome: "FAILED_RETRYABLE" };
      }

      if (response.ok && (body.ErrorCode ?? 0) === 0) {
        return {
          outcome: "ACCEPTED",
          // INTERNAL OPERATIONAL METADATA. Never evidence, never a receipt, and
          // never presented as proof a person received anything (S11).
          ...(body.MessageID === undefined
            ? {}
            : { providerMessageReference: body.MessageID }),
        };
      }

      // Authentication and authorization failures are configuration problems.
      // Retrying a bad server token three times only delays the signal.
      if (response.status === 401 || response.status === 403) {
        return { outcome: "FAILED_TERMINAL" };
      }

      // Explicitly retryable: rate limiting and provider-side faults.
      if (response.status === 429 || response.status >= 500) {
        return { outcome: "FAILED_RETRYABLE" };
      }

      if (body.ErrorCode !== undefined && TERMINAL_ERROR_CODES.has(body.ErrorCode)) {
        return { outcome: "FAILED_TERMINAL" };
      }

      return { outcome: "FAILED_RETRYABLE" };
    },
  };
}
