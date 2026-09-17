// Envelope + transport configuration, validated once at startup.
//
// ── Why validation happens at boot and not at send ─────────────────────────
//
// A missing `SMTP_PASSWORD` discovered on the first password reset is an
// outage that looks like a user problem. Discovered at boot, it is a
// deployment that refuses to start (S94) — which is loud, immediate, and
// attributable.
//
// ── Why the envelope is not a parameter ────────────────────────────────────
//
// `From`, the display name and `Reply-To` come from configuration and from
// nowhere else (S80-S83). A template that could set its own sender, or a
// request body that could influence one, is a way to send mail that appears to
// come from LAGDA and does not.
//
// ── Migrated from Postmark to SMTP ──────────────────────────────────────────
//
// LAGDA's transactional mail moved from Postmark's HTTP API to a plain SMTP
// relay (the current deployment target is GMass's SMTP endpoint). Nothing
// vendor-specific lives here or in ./smtp.ts by name — SMTP is itself the
// generic transport, and the actual host/credentials are supplied entirely
// through configuration. `POSTMARK_MESSAGE_STREAM` had no SMTP equivalent
// (a "message stream" is a Postmark-only concept for separating transactional
// from broadcast traffic) and is gone rather than mapped onto something new.

export interface EmailEnvelopeConfig {
  /** The verified sending identity. Must match the account/domain configured
   *  on the SMTP relay's own side (Postmark called this a "sender signature";
   *  the concept is provider-agnostic — the relay must recognize the address
   *  as authorized to send). */
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
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** True = implicit TLS from the first byte (conventionally port 465).
   *  False = plaintext connection upgraded via STARTTLS (conventionally port
   *  587) — `requireTLS` on the transport then refuses to fall back to an
   *  unencrypted session if the server doesn't offer STARTTLS, so credentials
   *  and message content are never sent in the clear either way. */
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  readonly envelope: EmailEnvelopeConfig;
  /**
   * How long to wait for a provider response.
   *
   * Bounded low. A worker blocked on a provider holds a delivery claim, and a
   * claim held past its lease is reclaimed and retried — so an unbounded wait
   * produces exactly the duplicate send the lease exists to prevent.
   */
  readonly timeoutMs: number;
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
export function loadSmtpConfig(
  env: Readonly<Record<string, string | undefined>>,
): SmtpConfig {
  const password = env["SMTP_PASSWORD"];
  if (password === undefined || password.trim() === "") {
    throw new EmailConfigError("SMTP_PASSWORD is required");
  }

  const host = (env["SMTP_HOST"] ?? "").trim();
  if (host === "") {
    throw new EmailConfigError("SMTP_HOST is required");
  }

  const portRaw = env["SMTP_PORT"];
  const port = portRaw === undefined ? 587 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EmailConfigError("SMTP_PORT must be a valid port number");
  }

  // Port 465 is the conventional implicit-TLS port; everything else
  // (587, the GMass-documented port, chief among them) negotiates TLS via
  // STARTTLS instead. An explicit override is still honored for a relay that
  // doesn't follow the convention.
  const secureOverride = env["SMTP_SECURE"];
  const secure = secureOverride === undefined
    ? port === 465
    : secureOverride.trim().toLowerCase() === "true";

  const username = (env["SMTP_USERNAME"] ?? "").trim();
  if (username === "") {
    throw new EmailConfigError("SMTP_USERNAME is required");
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

  return {
    host,
    port,
    secure,
    username,
    password: password.trim(),
    envelope: {
      fromAddress: requireAddress(env["EMAIL_FROM_ADDRESS"], "EMAIL_FROM_ADDRESS"),
      fromDisplayName,
      ...(replyTo === undefined || replyTo.trim() === ""
        ? {}
        : { replyToAddress: requireAddress(replyTo, "EMAIL_REPLY_TO_ADDRESS") }),
    },
    timeoutMs,
  };
}
