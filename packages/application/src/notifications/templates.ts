// The registered template versions.
//
// ── Five templates, because LAGDA sends five messages ──────────────────────
//
// One per transactional message the product actually produces today. There is
// no reminder template, no expiration notice and no completion mail: BACKEND-46
// owns the first two and the product has not asked for the third (S231). A
// template with no producer is dead copy that a future reader will assume is
// live.
//
// ── All five carry a secret ────────────────────────────────────────────────
//
// Which is not a coincidence — it is what transactional mail in an eSignature
// product IS. Every one exists to hand somebody a credential: a verification
// code, a reset link, an OTP, an invitation link, a signing link. So the
// secret-handling path is not an edge case bolted onto the side; it is the
// main path, and the ordinary non-secret case is the one that does not exist
// yet.
//
// That is why `secret` is a render-time argument rather than a model field
// (S78, S80). The frozen input persisted in JSONB holds names and titles; the
// credential is resolved immediately before rendering and never lands in a row.
//
// ── Text first, HTML second ────────────────────────────────────────────────
//
// Every template renders both parts (S69). The text part is authoritative: it
// is what a client that refuses HTML shows, and it is the one a reader can
// verify a link in. Variables are escaped for the HTML part and left alone in
// the text part, where escaping would show `&amp;` to a human.

import type { Static } from "@sinclair/typebox";
import { defineTemplate } from "./template-registry.js";
import {
  AccountEmailVerificationModelV1, PasswordResetModelV1, MfaOtpModelV1,
  WorkspaceInvitationModelV1, SigningInvitationModelV1,
} from "./template-registry.js";
import { escapeHtml } from "./rendering.js";

/**
 * The product name, as it appears in copy.
 *
 * A constant rather than a template variable: it is not per-message data, and
 * making it a variable would put it in every frozen model in the database for
 * no reason.
 */
const PRODUCT = "LAGDA";

/** Wraps a body in the one shared HTML shell, so five templates share one look. */
const htmlDocument = (heading: string, bodyHtml: string): string =>
  [
    `<!doctype html>`,
    `<html lang="en"><body style="font-family:system-ui,-apple-system,`,
    `'Segoe UI',sans-serif;line-height:1.5;color:#1a1a1a">`,
    `<h1 style="font-size:20px">${heading}</h1>`,
    bodyHtml,
    `<p style="font-size:12px;color:#666">`,
    `This is an automated message from ${PRODUCT}. Please do not reply.`,
    `</p>`,
    `</body></html>`,
  ].join("");

/** A call-to-action link. The URL is built from configured base, never echoed. */
const linkHtml = (url: string, label: string): string =>
  `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;

export const accountEmailVerificationV1 = defineTemplate({
  key: "account-email-verification",
  version: 1,
  locale: "en",
  schema: AccountEmailVerificationModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    // Non-null: the registry rejects a secret-bearing render with no secret
    // before reaching here.
    const url = context.buildLink("/verify-email", context.secret as string);
    return {
      subject: `Confirm your ${PRODUCT} email address`,
      textBody: [
        `Hello ${name},`,
        ``,
        `Confirm your email address to finish setting up your ${PRODUCT} account:`,
        url,
        ``,
        `If you did not create this account, you can ignore this message.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Confirm your email address`,
        `<p>Hello ${escapeHtml(name)},</p>` +
          `<p>Confirm your email address to finish setting up your ${PRODUCT} account.</p>` +
          linkHtml(url, "Confirm email address") +
          `<p>If you did not create this account, you can ignore this message.</p>`,
      ),
    };
  },
});

export const passwordResetV1 = defineTemplate({
  key: "password-reset",
  version: 1,
  locale: "en",
  schema: PasswordResetModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    const url = context.buildLink("/reset-password", context.secret as string);
    return {
      subject: `Reset your ${PRODUCT} password`,
      textBody: [
        `Hello ${name},`,
        ``,
        `Use the link below to choose a new password:`,
        url,
        ``,
        // Said explicitly because a reset mail nobody requested is the signal
        // an account is being probed, and the recipient is the only person who
        // can act on it.
        `If you did not request a password reset, your account is unchanged and`,
        `no action is needed.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Reset your password`,
        `<p>Hello ${escapeHtml(name)},</p>` +
          `<p>Use the link below to choose a new password.</p>` +
          linkHtml(url, "Reset password") +
          `<p>If you did not request a password reset, your account is unchanged ` +
          `and no action is needed.</p>`,
      ),
    };
  },
});

export const mfaOtpV1 = defineTemplate({
  key: "mfa-otp",
  version: 1,
  locale: "en",
  schema: MfaOtpModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    // A code, not a link: there is nothing to click, and `buildLink` is
    // deliberately not called. A one-time code in a URL would be a code the
    // recipient's browser history keeps.
    const code = context.secret as string;
    return {
      subject: `Your ${PRODUCT} verification code`,
      textBody: [
        `Hello ${name},`,
        ``,
        `Your verification code is: ${code}`,
        ``,
        `Do not share this code with anyone. ${PRODUCT} staff will never ask for it.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Your verification code`,
        `<p>Hello ${escapeHtml(name)},</p>` +
          `<p style="font-size:28px;letter-spacing:4px"><strong>` +
          `${escapeHtml(code)}</strong></p>` +
          `<p>Do not share this code with anyone. ${PRODUCT} staff will never ` +
          `ask for it.</p>`,
      ),
    };
  },
});

export const workspaceInvitationV1 = defineTemplate({
  key: "workspace-invitation",
  version: 1,
  locale: "en",
  schema: WorkspaceInvitationModelV1,
  secretBearing: true,
  render: (input, context) => {
    const inviter = input.inviterDisplayName;
    const workspace = input.workspaceName;
    const url = context.buildLink("/invitations", context.secret as string);
    return {
      subject: `${inviter} invited you to ${workspace}`,
      textBody: [
        `${inviter} has invited you to join the ${PRODUCT} workspace "${workspace}".`,
        ``,
        `Accept the invitation:`,
        url,
      ].join("\n"),
      htmlBody: htmlDocument(
        `You have been invited to ${escapeHtml(workspace)}`,
        `<p>${escapeHtml(inviter)} has invited you to join the ${PRODUCT} ` +
          `workspace "${escapeHtml(workspace)}".</p>` +
          linkHtml(url, "Accept invitation"),
      ),
    };
  },
});

export const signingInvitationV1 = defineTemplate({
  key: "signing-invitation",
  version: 1,
  locale: "en",
  schema: SigningInvitationModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    const title = input.documentTitle;
    const sender = input.senderDisplayName;
    const workspace = input.workspaceName;
    const url = context.buildLink("/sign", context.secret as string);
    return {
      // The document title is in the subject because a signer with several
      // pending requests cannot otherwise tell them apart. It is
      // business-sensitive (S160) and therefore never logged — but the
      // recipient is precisely the party entitled to see it.
      subject: `${sender} sent you "${title}" to sign`,
      textBody: [
        `Hello ${name},`,
        ``,
        `${sender} (${workspace}) has sent you a document to sign: "${title}".`,
        ``,
        `Open the document:`,
        url,
        ``,
        `This link is personal to you. Do not forward this message.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `A document is waiting for your signature`,
        `<p>Hello ${escapeHtml(name)},</p>` +
          `<p>${escapeHtml(sender)} (${escapeHtml(workspace)}) has sent you a ` +
          `document to sign: "${escapeHtml(title)}".</p>` +
          linkHtml(url, "Open document") +
          `<p>This link is personal to you. Do not forward this message.</p>`,
      ),
    };
  },
});

/**
 * Every template version LAGDA can render.
 *
 * A version is removed from this list only when no pending intent references
 * it (S74). Removing one that is still referenced turns a queued message into
 * a `TemplateNotFoundError` at send time — which fails safe, but fails.
 */
export const ALL_TEMPLATES = [
  accountEmailVerificationV1,
  passwordResetV1,
  mfaOtpV1,
  workspaceInvitationV1,
  signingInvitationV1,
] as const;

export type AccountEmailVerificationModel = Static<typeof AccountEmailVerificationModelV1>;
export type PasswordResetModel = Static<typeof PasswordResetModelV1>;
export type MfaOtpModel = Static<typeof MfaOtpModelV1>;
export type WorkspaceInvitationModel = Static<typeof WorkspaceInvitationModelV1>;
export type SigningInvitationModel = Static<typeof SigningInvitationModelV1>;
