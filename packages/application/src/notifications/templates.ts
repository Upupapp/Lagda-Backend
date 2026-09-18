// The registered template versions.
//
// ── One template per message the product actually produces ────────────────
//
// There is no reminder template and no expiration notice: BACKEND-46 owns the
// policy that would decide when those occur. A template with no producer is
// dead copy that a future reader will assume is live.
//
// `signing-completed` was in that category until BACKEND-38 Phase 2 gave it a
// producer. The header here used to say the product had not asked for a
// completion mail (S231); it has, and the template is registered alongside the
// transaction that now produces its intent.
//
// ── Four carry a secret; one does not ─────────────────────────────────────
//
// The four that do are what transactional mail in an eSignature product mostly
// IS: each exists to hand somebody a credential they could not otherwise
// have — a verification code, a reset link, an invitation link, a signing
// link. So the secret-handling path is the main path, not an edge case.
//
// `signing-completed` is the exception, and the reason is worth stating,
// because it is what makes the exception safe: its reader is the SENDER, who
// already holds an account and already has authorised access to the document.
// There is nothing to hand them. A bearer token in this message would be a
// credential minted for somebody who does not need one, with a lifetime
// nothing tracks — strictly worse than a link to the ordinary signed-in app.
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
  AccountEmailVerificationModelV1, PasswordResetModelV1, WorkspaceInvitationModelV1,
  SigningInvitationModelV1, SigningCompletedModelV1,
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

/** Wraps a body in the one shared HTML shell, so every template shares one look. */
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
 * The sender's route to the finished document.
 *
 * `/app/documents` and not a per-document deep link. The signed document IS
 * viewable — the documents list renders real artifact content — but there is
 * no `/app/documents/:documentId` route in the web platform's router, and
 * inventing one would produce a 404 in a message whose whole purpose is to say
 * "it is ready". The list is where the reader finds it, so the list is what
 * this points at.
 */
const SENDER_DOCUMENTS_PATH = "/app/documents";

export const signingCompletedV1 = defineTemplate({
  key: "signing-completed",
  version: 1,
  locale: "en",
  schema: SigningCompletedModelV1,
  // The only template that renders without one. `deliverNotification` skips
  // secret resolution entirely for an intent with no ref, so nothing is
  // resolved, nothing is discarded, and the registry does not demand one.
  secretBearing: false,
  render: (input, context) => {
    const name = input.recipientName;
    const title = input.documentTitle;
    const workspace = input.workspaceName;
    const signers = input.signerCount;
    const people = signers === 1 ? "1 signer" : `${String(signers)} signers`;
    // Token-free: the reader signs in as themselves.
    const url = context.buildPath(SENDER_DOCUMENTS_PATH);
    return {
      // The document title, as in `signing-invitation`. Business-sensitive
      // (S160) and therefore never logged — but the sender is the party who
      // owns it.
      subject: `"${title}" is fully signed`,
      textBody: [
        `Hello ${name},`,
        ``,
        `All signatures are in. "${title}" has been completed by ${people} and`,
        `the sealed document is now final.`,
        ``,
        // No claim beyond what exists. The sealed artifact is stored and the
        // documents list renders it; nothing here promises an attachment, a
        // direct download or a certificate this message does not carry.
        `Open ${workspace} to view it:`,
        url,
        ``,
        `You are receiving this because you sent this document for signature.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Your document is fully signed`,
        `<p>Hello ${escapeHtml(name)},</p>` +
          `<p>All signatures are in. "${escapeHtml(title)}" has been completed ` +
          `by ${escapeHtml(people)} and the sealed document is now final.</p>` +
          linkHtml(url, `View in ${workspace}`) +
          `<p>You are receiving this because you sent this document for ` +
          `signature.</p>`,
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
  workspaceInvitationV1,
  signingInvitationV1,
  signingCompletedV1,
] as const;

export type AccountEmailVerificationModel = Static<typeof AccountEmailVerificationModelV1>;
export type PasswordResetModel = Static<typeof PasswordResetModelV1>;
export type WorkspaceInvitationModel = Static<typeof WorkspaceInvitationModelV1>;
export type SigningInvitationModel = Static<typeof SigningInvitationModelV1>;
export type SigningCompletedModel = Static<typeof SigningCompletedModelV1>;
