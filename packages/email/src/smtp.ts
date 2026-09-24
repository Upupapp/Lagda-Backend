// The SMTP transport.
//
// ── Why nodemailer, unlike Postmark's raw fetch ─────────────────────────────
//
// Postmark's send API was one JSON POST with one header — twenty lines of
// `fetch`, no SDK needed (§301: no new production dependency where one is
// avoidable). Real SMTP is a stateful, multi-round-trip wire protocol
// (EHLO/STARTTLS/AUTH/MAIL FROM/RCPT TO/DATA, with provider-specific auth
// mechanism negotiation and MIME encoding on top) — reimplementing that
// correctly, including the TLS downgrade attacks a naive implementation is
// prone to, is not a twenty-line substitute for a dependency. Nodemailer is
// the de facto standard Node SMTP client for exactly this reason.
//
// ── What this file is not allowed to know ──────────────────────────────────
//
// What a notification means. It receives a finished `EmailMessage` and
// returns an outcome. It does not select templates, resolve secrets, read the
// database, or touch delivery state (S219).

import nodemailer from "nodemailer";
import type {
  EmailDeliveryProvider, EmailMessage, EmailDeliveryResult, EmailAttachment,
} from "@lagda/application";
import type { SmtpConfig } from "./config.js";

/** nodemailer's own attachment shape, narrowed to the CID-inline case this
 *  adapter ever produces — never a filesystem path or a remote href, which
 *  nodemailer's real type also allows but this adapter has no use for. */
interface NodemailerAttachment {
  readonly filename: string;
  readonly content: string;
  readonly encoding: "base64";
  readonly cid: string;
  readonly contentType: string;
}

function toNodemailerAttachments(attachments?: readonly EmailAttachment[]): NodemailerAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  return attachments.map(a => ({
    filename: a.filename,
    content: a.contentBase64,
    encoding: "base64" as const,
    cid: a.contentId,
    contentType: a.contentType,
  }));
}

/**
 * The subset of a nodemailer/Node SMTP error this adapter reads.
 *
 * `code` is nodemailer's own connection-level classification (ECONNECTION,
 * ETIMEDOUT, EAUTH, ...); `responseCode` is the numeric SMTP status the
 * server itself returned (4xx/5xx), when a server actually replied.
 */
interface SmtpErrorLike {
  readonly code?: unknown;
  readonly responseCode?: unknown;
}

/**
 * Classifies a thrown send error into LAGDA's own retry vocabulary.
 *
 * Retry classification is LAGDA's, not nodemailer's or the relay's (S218) —
 * exactly the same posture postmark.ts held for HTTP status codes, applied
 * here to SMTP reply codes and connection-level failure codes instead.
 *
 * ── The three buckets ────────────────────────────────────────────────────
 *
 * RETRYABLE, safely: the connection never reached a point where the message
 * could have been accepted (DNS failure, refused connection, cannot even
 * open a socket) — no risk of a duplicate send because nothing was sent.
 *
 * TERMINAL: the server or the relay affirmatively rejected the attempt in a
 * way retrying will not fix — bad credentials, or a permanent (5xx) SMTP
 * reply naming the address or message itself as the problem.
 *
 * AMBIGUOUS: the failure happened at a point where the message MAY have
 * already reached the server (a timeout or reset mid-conversation, or a
 * transient 4xx reply). Never assumed to be either outcome — same reasoning
 * postmark.ts applied to a dropped connection.
 */
function classifySmtpError(error: unknown): EmailDeliveryResult {
  const e = (error ?? {}) as SmtpErrorLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined;

  // Never got far enough to send a byte of the message — safe to retry.
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "EDNS") {
    return { outcome: "FAILED_RETRYABLE" };
  }

  // The relay rejected the credential outright. Retrying with the same
  // password three times only delays the signal that something is
  // misconfigured.
  if (code === "EAUTH") {
    return { outcome: "FAILED_TERMINAL" };
  }

  // Could have happened before OR after the server accepted the message —
  // the connection dropped or timed out mid-conversation and there is no
  // way to tell which side of DATA it was on.
  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNRESET") {
    return { outcome: "AMBIGUOUS" };
  }

  // The server replied with an explicit SMTP status. 5xx is permanent
  // (bad recipient, policy rejection, blocked sender); 4xx is the server's
  // own "try again later" (greylisting, rate limiting, temporary quota).
  if (responseCode !== undefined) {
    if (responseCode >= 500) return { outcome: "FAILED_TERMINAL" };
    if (responseCode >= 400) return { outcome: "FAILED_RETRYABLE" };
  }

  // The safe default for security mail, same reasoning as postmark.ts: a
  // wrongly-retried message costs a duplicate of a credential that still
  // works, while a wrongly-abandoned one is a password reset that never
  // arrives.
  return { outcome: "FAILED_RETRYABLE" };
}

/**
 * The subset of nodemailer's transporter this file actually calls — narrowed
 * so the classification table can be tested against every response shape
 * without a network or a real SMTP relay, the same reason postmark.ts made
 * `fetchImpl` injectable.
 */
export interface SmtpSender {
  sendMail(options: {
    from: { name: string; address: string };
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    attachments?: NodemailerAttachment[];
  }): Promise<{ messageId?: string }>;
}

/**
 * Builds the transport.
 *
 * One transporter per provider instance, reused across sends — nodemailer
 * pools/reopens connections internally, and constructing a fresh transporter
 * (and TLS handshake) per message would be needless per-send latency.
 */
export function createSmtpEmailProvider(
  config: SmtpConfig,
  senderImpl?: SmtpSender,
): EmailDeliveryProvider {
  const transporter: SmtpSender = senderImpl ?? nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Refuses to fall back to a plaintext session if the server doesn't
    // support STARTTLS, rather than silently downgrading — credentials and
    // message content must never cross the wire unencrypted.
    requireTLS: !config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });

  return {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      try {
        const attachments = toNodemailerAttachments(message.attachments);
        const info = await transporter.sendMail({
          from: {
            name: config.envelope.fromDisplayName,
            address: config.envelope.fromAddress,
          },
          to: message.destination,
          subject: message.subject,
          text: message.textBody,
          ...(message.htmlBody === undefined ? {} : { html: message.htmlBody }),
          ...(config.envelope.replyToAddress === undefined
            ? {}
            : { replyTo: config.envelope.replyToAddress }),
          ...(attachments === undefined ? {} : { attachments }),
        });

        return {
          outcome: "ACCEPTED",
          // INTERNAL OPERATIONAL METADATA. Never evidence, never a receipt,
          // and never presented as proof a person received anything (S11).
          ...(info.messageId === undefined || info.messageId === ""
            ? {}
            : { providerMessageReference: info.messageId }),
        };
      } catch (error) {
        return classifySmtpError(error);
      }
    },
  };
}
