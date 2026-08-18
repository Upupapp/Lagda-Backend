// Envelope configuration, validated once at startup.
//
// ── Why validation happens at boot and not at send ─────────────────────────
//
// A missing `POSTMARK_SERVER_TOKEN` discovered on the first password reset is
// an outage that looks like a user problem. Discovered at boot, it is a
// deployment that refuses to start (S94) — which is loud, immediate, and
// attributable.
//
// ── Why the envelope is not a parameter ────────────────────────────────────
//
// `From`, the display name and `Reply-To` come from configuration and from
// nowhere else (S80-S83). A template that could set its own sender, or a
// request body that could influence one, is a way to send mail that appears to
// come from LAGDA and does not.

export interface EmailEnvelopeConfig {
  /** The verified sending identity. Must match the DKIM-signed domain. */
  readonly fromAddress: string;
  /** What a recipient sees as the sender. Server-controlled (S81). */
  readonly fromDisplayName: string;
  /**
   * Where replies go, if anywhere.
   *
   * Optional because a transactional stream that nobody reads is worse than no
   * reply-to at all: it invites a signer to reply with something urgent into a
   * mailbox with no owner.
   */
  readonly replyToAddress?: string;
  /**
   * Postmark's transactional Message Stream (S87).
   *
   * Explicit rather than defaulted, because the default stream on a Postmark
   * server can be reconfigured, and a security email that inherits a broadcast
   * stream inherits a broadcast reputation.
   */
  readonly messageStream: string;
}

export interface PostmarkConfig {
  readonly serverToken: string;
  readonly envelope: EmailEnvelopeConfig;
  /**
   * How long to wait for a provider response.
   *
   * Bounded low. A worker blocked on a provider holds a delivery claim, and a
   * claim held past its lease is reclaimed and retried — so an unbounded wait
   * produces exactly the duplicate send the lease exists to prevent.
   */
  readonly timeoutMs: number;
  /** Overridable for tests. Never read from a request. */
  readonly apiBaseUrl: string;
}

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

/** Addresses are checked for shape and for the header-injection characters. */
const ADDRESS = /^[^\s@<>",;\r\n]+@[^\s@<>",;\r\n]+\.[^\s@<>",;\r\n]+$/u;
const CONTROL = /[\r\n\p{Cc}]/u;

function requireAddress(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw new EmailConfigError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!ADDRESS.test(trimmed)) {
    throw new EmailConfigError(`${field} is not a valid email address`);
  }
  return trimmed;
}

/**
 * Builds the configuration or refuses to.
 *
 * Takes a plain record rather than reading `process.env` directly, matching the
 * database config: a module that reads the environment behaves differently
 * depending on where it runs, and cannot be tested without mutating global
 * state.
 */
export function loadPostmarkConfig(
  env: Readonly<Record<string, string | undefined>>,
): PostmarkConfig {
  const serverToken = env["POSTMARK_SERVER_TOKEN"];
  if (serverToken === undefined || serverToken.trim() === "") {
    throw new EmailConfigError("POSTMARK_SERVER_TOKEN is required");
  }

  const fromDisplayName = (env["EMAIL_FROM_DISPLAY_NAME"] ?? "LAGDA").trim();
  if (CONTROL.test(fromDisplayName)) {
    // A display name with a newline is a header injection in the one field
    // nobody thinks to check, because it is configuration rather than input.
    throw new EmailConfigError("EMAIL_FROM_DISPLAY_NAME contains control characters");
  }

  const replyTo = env["EMAIL_REPLY_TO_ADDRESS"];
  const timeoutRaw = env["EMAIL_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? 10_000 : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new EmailConfigError("EMAIL_TIMEOUT_MS must be between 1000 and 30000");
  }

  const messageStream = (env["POSTMARK_MESSAGE_STREAM"] ?? "").trim();
  if (messageStream === "") {
    throw new EmailConfigError("POSTMARK_MESSAGE_STREAM is required");
  }

  return {
    serverToken: serverToken.trim(),
    envelope: {
      fromAddress: requireAddress(env["EMAIL_FROM_ADDRESS"], "EMAIL_FROM_ADDRESS"),
      fromDisplayName,
      ...(replyTo === undefined || replyTo.trim() === ""
        ? {}
        : { replyToAddress: requireAddress(replyTo, "EMAIL_REPLY_TO_ADDRESS") }),
      messageStream,
    },
    timeoutMs,
    apiBaseUrl: (env["POSTMARK_API_BASE_URL"] ?? "https://api.postmarkapp.com").trim(),
  };
}
