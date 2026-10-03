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
// ── Four carry a secret; two do not ───────────────────────────────────────
//
// The four that do are what transactional mail in an eSignature product mostly
// IS: each exists to hand somebody a credential they could not otherwise
// have — a verification code, a reset link, an invitation link, a signing
// link. So the secret-handling path is the main path, not an edge case.
//
// `signing-completed` and `document-upload-requested` are the exceptions, and
// the reason is worth stating, because it is what makes them safe: both
// readers already hold an account and already have authorised access — the
// sender to their own finished request, the assignee to the workspace they
// are a member of. There is nothing to hand either of them. A bearer token in
// these messages would be a credential minted for somebody who does not need
// one, with a lifetime nothing tracks — strictly worse than a link to the
// ordinary signed-in app.
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
  DocumentUploadRequestedModelV1, FinalCopyAvailableModelV1,
  WorkspaceJoinLinkModelV1, WorkspaceJoinRequestedModelV1, WorkspaceJoinDecidedModelV1,
  VerificationAccessCodeModelV1,
  ContactRequestReceivedModelV1, ContactRequestEmailedModelV1, ContactRequestAnsweredModelV1,
  DocumentShareReceivedModelV1, DocumentShareAnsweredModelV1,
  DocumentAccessRequestedModelV1, DocumentAccessDecidedModelV1,
  WorkspaceInvitationReceivedModelV1, WorkspaceInvitationDeclinedModelV1,
  ContactConnectionRequestedModelV1, ContactConnectionAcceptedModelV1,
  PlanUpgradeRequestedModelV1, PlanUpgradeDecidedModelV1,
  PublicInquiryReceivedModelV1, DocumentWaitingForSignatureModelV1,
} from "./template-registry.js";
import { escapeHtml } from "./rendering.js";
import { LAGDA_LOGO_PNG_BASE64 } from "./assets/lagda-logo.js";
import { qrCodePngBase64 } from "./qr-code.js";
import type { EmailAttachment } from "../common/ports/notifications.js";

/**
 * The product name, as it appears in copy.
 *
 * A constant rather than a template variable: it is not per-message data, and
 * making it a variable would put it in every frozen model in the database for
 * no reason.
 */
const PRODUCT = "LAGDA";

// ── Brand shell ──────────────────────────────────────────────────────────────
//
// Table-based layout, not flexbox/grid: Outlook desktop renders HTML mail
// with Word's engine, which only reliably supports `<table>` for layout — a
// flexbox shell would silently collapse there. Every color/size below is an
// inline style for the same reason; mail clients strip or ignore `<style>`
// blocks inconsistently, so nothing here depends on one.

const NAVY   = "#07111F";
const AZURE  = "#0078D4";
const SILVER = "#64748B";
const BORDER = "#E2E8F0";
const CANVAS = "#F1F5F9";

/**
 * Referenced from every template's HTML as `cid:lagda-logo` rather than a
 * `data:` URI — Outlook desktop's Word rendering engine is well known to
 * strip `data:` image sources outright (broken-image icon, not just
 * hidden-until-clicked). A CID attachment is the one embedding every major
 * client, Outlook included, actually renders inline. See `EmailAttachment`'s
 * doc comment in common/ports/notifications.ts.
 *
 * One constant, not rebuilt per render: the logo is the same bytes in every
 * message, so there is nothing per-render to compute — unlike the QR
 * attachment below, which differs by URL and must be built inside each
 * template's own `render()`.
 */
const LOGO_CONTENT_ID = "lagda-logo";
const LOGO_ATTACHMENT: EmailAttachment = {
  contentId: LOGO_CONTENT_ID,
  filename: "lagda-logo.png",
  contentType: "image/png",
  contentBase64: LAGDA_LOGO_PNG_BASE64,
};

/**
 * Wraps a body in the one shared branded HTML shell, so every template
 * shares one look: logo header, white card, footer.
 */
const htmlDocument = (heading: string, bodyHtml: string): string =>
  [
    `<!doctype html>`,
    `<html lang="en"><body style="margin:0;padding:0;background:${CANVAS};`,
    `font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 16px;">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;` +
      `overflow:hidden;border:1px solid ${BORDER};" cellpadding="0" cellspacing="0">`,
    `<tr><td style="padding:28px 32px 20px;text-align:center;border-bottom:1px solid ${BORDER};">`,
    `<img src="cid:${LOGO_CONTENT_ID}" width="140" height="105" alt="${PRODUCT}" style="display:inline-block;border:0;max-width:140px;height:auto;" />`,
    `</td></tr>`,
    `<tr><td style="padding:28px 32px 8px;">`,
    `<h1 style="margin:0 0 16px;font-size:19px;color:${NAVY};">${heading}</h1>`,
    bodyHtml,
    `</td></tr>`,
    `<tr><td style="padding:20px 32px 28px;border-top:1px solid ${BORDER};">`,
    `<p style="font-size:11px;color:${SILVER};margin:0;line-height:1.5;">`,
    `This is an automated message from ${PRODUCT}. Please do not reply.`,
    `</p>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body></html>`,
  ].join("");

/** Body copy paragraph — the one text style every template's HTML body uses. */
const p = (html: string): string =>
  `<p style="margin:0 0 14px;font-size:14px;color:#334155;line-height:1.6;">${html}</p>`;

/** A call-to-action button. The URL is built from configured base, never echoed. */
const linkHtml = (url: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;">` +
  `<tr><td style="border-radius:8px;background:${AZURE};">` +
  `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 26px;font-size:14px;` +
  `font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
  `</td></tr></table>`;

const QR_CONTENT_ID = "signing-qr";

/**
 * A scannable alternative to the button above, for a reader opening the mail
 * on a computer who will actually sign on their phone. Renders from the SAME
 * url the button and the text part use — never a second, independently-built
 * link — so there is exactly one URL this message can send someone to.
 *
 * Unlike the logo, this differs per message (it encodes THIS message's own
 * signing link), so it cannot be a module-level constant — the caller must
 * fold the returned `attachment` into its own `attachments` array.
 */
const qrBlockHtml = (url: string): { readonly html: string; readonly attachment: EmailAttachment } => ({
  html:
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 4px;">` +
    `<tr><td align="center" style="padding:16px;background:${CANVAS};border:1px solid ${BORDER};border-radius:10px;">` +
    `<img src="cid:${QR_CONTENT_ID}" width="132" height="132" alt="QR code — scan to open on your phone" ` +
    `style="display:block;border:0;margin:0 auto 8px;" />` +
    `<p style="margin:0;font-size:11px;color:${SILVER};">Or scan with your phone's camera to open the document</p>` +
    `</td></tr></table>`,
  attachment: {
    contentId: QR_CONTENT_ID,
    filename: "signing-qr.png",
    contentType: "image/png",
    contentBase64: qrCodePngBase64(url),
  },
});

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
        p(`Hello ${escapeHtml(name)},`) +
          p(`Confirm your email address to finish setting up your ${PRODUCT} account.`) +
          linkHtml(url, "Confirm email address") +
          p(`If you did not create this account, you can ignore this message.`),
      ),
      attachments: [LOGO_ATTACHMENT],
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
        p(`Hello ${escapeHtml(name)},`) +
          p(`Use the link below to choose a new password.`) +
          linkHtml(url, "Reset password") +
          p(`If you did not request a password reset, your account is unchanged ` +
            `and no action is needed.`),
      ),
      attachments: [LOGO_ATTACHMENT],
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
        p(`${escapeHtml(inviter)} has invited you to join the ${PRODUCT} ` +
          `workspace "${escapeHtml(workspace)}".`) +
          linkHtml(url, "Accept invitation"),
      ),
      attachments: [LOGO_ATTACHMENT],
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
    const qr = qrBlockHtml(url);
    if (input.accessKind === "view") {
      // A viewer: the same personal link, opening the document read-only.
      return {
        subject: `${sender} shared "${title}" with you to view`,
        textBody: [
          `Hello ${name},`,
          ``,
          `${sender} (${workspace}) has given you access to view a document: "${title}".`,
          `Nothing is needed from you — you can read it while it is being signed.`,
          ``,
          `View the document:`,
          url,
          ``,
          `This link is personal to you. Do not forward this message.`,
        ].join("\n"),
        htmlBody: htmlDocument(
          `A document has been shared with you`,
          p(`Hello ${escapeHtml(name)},`) +
            p(`${escapeHtml(sender)} (${escapeHtml(workspace)}) has given you access ` +
              `to view a document: "${escapeHtml(title)}".`) +
            p(`Nothing is needed from you — you can read it while it is being signed.`) +
            linkHtml(url, "View document") +
            qr.html +
            p(`This link is personal to you. Do not forward this message.`),
        ),
        attachments: [LOGO_ATTACHMENT, qr.attachment],
      };
    }
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
        p(`Hello ${escapeHtml(name)},`) +
          p(`${escapeHtml(sender)} (${escapeHtml(workspace)}) has sent you a ` +
            `document to sign: "${escapeHtml(title)}".`) +
          linkHtml(url, "Open document") +
          qr.html +
          p(`This link is personal to you. Do not forward this message.`),
      ),
      attachments: [LOGO_ATTACHMENT, qr.attachment],
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
        p(`Hello ${escapeHtml(name)},`) +
          p(`All signatures are in. "${escapeHtml(title)}" has been completed ` +
            `by ${escapeHtml(people)} and the sealed document is now final.`) +
          linkHtml(url, `View in ${workspace}`) +
          p(`You are receiving this because you sent this document for signature.`),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/**
 * Where an assignee finds what has been asked of them.
 *
 * The LIST, not a per-request deep link: the web platform has no
 * `/app/upload-requests/:id` route, and inventing one would produce a 404 in
 * a message whose whole purpose is to say "this is waiting for you". The
 * list is where the reader finds it, so the list is what this points at —
 * the same rule `SENDER_DOCUMENTS_PATH` follows.
 *
 * This pointed at `/app/documents` until the queue itself shipped, because
 * until then there was nowhere truer to send someone.
 */
const ASSIGNEE_REQUESTS_PATH = "/app/upload-requests";

export const documentUploadRequestedV1 = defineTemplate({
  key: "document-upload-requested",
  version: 1,
  locale: "en",
  schema: DocumentUploadRequestedModelV1,
  // Carries no credential. The reader is a workspace member who signs in as
  // themselves — see this type's own entry in NOTIFICATION_TYPES.
  secretBearing: false,
  render: (input, context) => {
    const name = input.recipientName;
    const title = input.requestTitle;
    const requester = input.requesterDisplayName;
    const workspace = input.workspaceName;
    const note = input.note;
    const url = context.buildPath(ASSIGNEE_REQUESTS_PATH);
    return {
      // Names the thing being asked for, because somebody with several
      // outstanding requests cannot otherwise tell them apart.
      subject: `${requester} asked you to upload "${title}"`,
      textBody: [
        `Hello ${name},`,
        ``,
        `${requester} (${workspace}) has asked you to upload a document: "${title}".`,
        ...(note === undefined ? [] : [``, `Their note: ${note}`]),
        ``,
        `Sign in to ${workspace} to upload it:`,
        url,
        ``,
        `You are receiving this because the request was assigned to you.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `A document has been requested from you`,
        p(`Hello ${escapeHtml(name)},`) +
          p(`${escapeHtml(requester)} (${escapeHtml(workspace)}) has asked you ` +
            `to upload a document: "${escapeHtml(title)}".`) +
          (note === undefined ? "" : p(`<em>${escapeHtml(note)}</em>`)) +
          linkHtml(url, "Upload the document") +
          p(`You are receiving this because the request was assigned to you.`),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/**
 * A participant's copy of the completed document (073).
 *
 * `/copy` + the sealed download credential. The link opens only the sealed
 * PDF of this one completed request; it cannot reach the signing ceremony.
 */
export const finalCopyAvailableV1 = defineTemplate({
  key: "final-copy-available",
  version: 1,
  locale: "en",
  schema: FinalCopyAvailableModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    const title = input.documentTitle;
    const sender = input.senderDisplayName;
    const workspace = input.workspaceName;
    const url = context.buildLink("/copy", context.secret as string);
    return {
      subject: `"${title}" is complete — download your copy`,
      textBody: [
        `Hello ${name},`,
        ``,
        `"${title}", sent by ${sender} (${workspace}), has been completed by everyone involved.`,
        `Your copy of the final signed document is ready:`,
        url,
        ``,
        `This link is personal to you and expires in 30 days. Do not forward this message.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Your signed document is ready`,
        p(`Hello ${escapeHtml(name)},`) +
          p(`"${escapeHtml(title)}", sent by ${escapeHtml(sender)} ` +
            `(${escapeHtml(workspace)}), has been completed by everyone involved.`) +
          linkHtml(url, "Download signed document") +
          p(`This link is personal to you and expires in 30 days. Do not forward this message.`),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/**
 * 078. A single-use join link. `/join/<token>` opens the join page, where the
 * person signs in and asks to join; an owner or administrator approves.
 */
export const workspaceJoinLinkV1 = defineTemplate({
  key: "workspace-join-link",
  version: 1,
  locale: "en",
  schema: WorkspaceJoinLinkModelV1,
  secretBearing: true,
  render: (input, context) => {
    const workspace = input.workspaceName;
    const sender = input.senderDisplayName;
    const url = context.buildLink("/join", context.secret as string);
    return {
      subject: `${sender} invited you to join ${workspace} on LAGDA`,
      textBody: [
        `Hello,`,
        ``,
        `${sender} invited you to join the ${workspace} workspace on LAGDA.`,
        `Open this link to ask to join:`,
        url,
        ``,
        `An owner or administrator of ${workspace} will review your request.`,
        `This link works once — do not forward this message.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `You're invited to join ${escapeHtml(workspace)}`,
        p(`${escapeHtml(sender)} invited you to join the ${escapeHtml(workspace)} workspace on LAGDA.`) +
          linkHtml(url, "Ask to join") +
          p(`An owner or administrator of ${escapeHtml(workspace)} will review your request. ` +
            `This link works once — do not forward this message.`),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

const JOIN_REQUESTS_PATH = "/app/workspace/members";

/** 078. An owner or administrator told that someone asked to join. */
export const workspaceJoinRequestedV1 = defineTemplate({
  key: "workspace-join-requested",
  version: 1,
  locale: "en",
  schema: WorkspaceJoinRequestedModelV1,
  secretBearing: false,
  render: (input, context) => {
    const name = input.recipientName;
    const who = input.requesterName;
    const email = input.requesterEmail;
    const workspace = input.workspaceName;
    const reason = input.reason;
    const url = context.buildPath(JOIN_REQUESTS_PATH);
    return {
      subject: `${who} asked to join ${workspace}`,
      textBody: [
        `Hello ${name},`,
        ``,
        `${who} (${email}) asked to join ${workspace}.`,
        ...(reason === undefined ? [] : [``, `Their reason: ${reason}`]),
        ``,
        `Review the request:`,
        url,
      ].join("\n"),
      htmlBody: htmlDocument(
        `New request to join ${escapeHtml(workspace)}`,
        p(`Hello ${escapeHtml(name)},`) +
          p(`${escapeHtml(who)} (${escapeHtml(email)}) asked to join ${escapeHtml(workspace)}.`) +
          (reason === undefined ? "" : p(`<em>${escapeHtml(reason)}</em>`)) +
          linkHtml(url, "Review the request"),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/** 078. The requester told whether they were let in. */
export const workspaceJoinDecidedV1 = defineTemplate({
  key: "workspace-join-decided",
  version: 1,
  locale: "en",
  schema: WorkspaceJoinDecidedModelV1,
  secretBearing: false,
  render: (input, context) => {
    const name = input.recipientName;
    const workspace = input.workspaceName;
    const url = context.buildPath("/app/dashboard");
    const subject = input.approved
      ? `You've joined ${workspace} on LAGDA`
      : `Your request to join ${workspace} was declined`;
    const line = input.approved
      ? `Your request to join ${workspace} was approved. You can switch to it from your workspace menu.`
      : `Your request to join ${workspace} was declined. Contact the workspace owner if you think this is a mistake.`;
    return {
      subject,
      textBody: [`Hello ${name},`, ``, line, ...(input.approved ? [``, url] : [])].join("\n"),
      htmlBody: htmlDocument(
        subject,
        p(`Hello ${escapeHtml(name)},`) + p(escapeHtml(line))
          + (input.approved ? linkHtml(url, "Open LAGDA") : ""),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/**
 * 083. The six-digit Verify Document code. No link: the reader is already on
 * the verification page and types the code there.
 */
export const verificationAccessCodeV1 = defineTemplate({
  key: "verification-access-code",
  version: 1,
  locale: "en",
  schema: VerificationAccessCodeModelV1,
  secretBearing: true,
  render: (input, context) => {
    const name = input.recipientName;
    const title = input.documentTitle;
    const code = context.secret as string;
    const line = `Your ${PRODUCT} verification code is ${code}. It expires in 10 minutes. `
      + `If you did not ask for it, ignore this email.`;
    return {
      subject: `Your ${PRODUCT} verification code`,
      textBody: [
        `Hello ${name},`,
        ``,
        line,
        ``,
        `Document: "${title}"`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `Your verification code`,
        p(`Hello ${escapeHtml(name)},`) +
          p(`Your ${PRODUCT} verification code is <strong style="font-size:22px;letter-spacing:4px">${escapeHtml(code)}</strong>.`) +
          p(`It expires in 10 minutes. If you did not ask for it, ignore this email.`) +
          p(`Document: "${escapeHtml(title)}"`),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

// ── 086. Contact requests ───────────────────────────────────────────────────

const CONTACT_REQUEST_ASK: Readonly<Record<"signed-document" | "upload" | "preparation", string>> = {
  "signed-document": "provide a signed copy of a document",
  upload: "upload a document",
  preparation: "prepare a document for signing",
};

/** Where a member finds what was asked of them: Documents, "Others". */
const CONTACT_REQUESTS_PATH = "/app/documents";

/**
 * 086. In-app only — the policy stops its email at creation. Registered and
 * renderable anyway, because every type has a template and a preview of what
 * the feed says is worth having.
 */
export const contactRequestReceivedV1 = defineTemplate({
  key: "contact-request-received",
  version: 1,
  locale: "en",
  schema: ContactRequestReceivedModelV1,
  secretBearing: false,
  render: (input, context) => {
    const ask = CONTACT_REQUEST_ASK[input.requestKind];
    const url = context.buildPath(CONTACT_REQUESTS_PATH);
    const about = input.documentTitle === undefined ? "" : ` ("${input.documentTitle}")`;
    return {
      subject: `${input.requesterDisplayName} asked you to ${ask}`,
      textBody: [
        `Hello ${input.recipientName},`,
        ``,
        `${input.requesterDisplayName} (${input.workspaceName}) asked you to ${ask}${about}: "${input.requestTitle}".`,
        ...(input.message === undefined ? [] : [``, `Their message: ${input.message}`]),
        ...(input.dueAt === undefined ? [] : [``, `Due: ${input.dueAt}`]),
        ``,
        url,
      ].join("\n"),
      htmlBody: htmlDocument(
        `A request from ${escapeHtml(input.requesterDisplayName)}`,
        p(`Hello ${escapeHtml(input.recipientName)},`) +
          p(`${escapeHtml(input.requesterDisplayName)} (${escapeHtml(input.workspaceName)}) asked you to ` +
            `${escapeHtml(ask)}${escapeHtml(about)}: "${escapeHtml(input.requestTitle)}".`) +
          (input.message === undefined ? "" : p(`<em>${escapeHtml(input.message)}</em>`)) +
          linkHtml(url, "Open the request"),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

/**
 * 086. To an external contact. No link and no credential: there is nothing an
 * external contact can open in LAGDA, so the message says who asked and how
 * to reach them.
 */
export const contactRequestEmailedV1 = defineTemplate({
  key: "contact-request-emailed",
  version: 1,
  locale: "en",
  schema: ContactRequestEmailedModelV1,
  secretBearing: false,
  render: input => {
    const ask = CONTACT_REQUEST_ASK[input.requestKind];
    const about = input.documentTitle === undefined ? "" : ` ("${input.documentTitle}")`;
    const reply = input.requesterEmail === undefined
      ? `Reply to ${input.requesterDisplayName} directly to send it.`
      : `Reply to ${input.requesterDisplayName} at ${input.requesterEmail} to send it.`;
    return {
      subject: `${input.requesterDisplayName} asked you to ${ask}`,
      textBody: [
        `Hello ${input.recipientName},`,
        ``,
        `${input.requesterDisplayName} (${input.workspaceName}) asked you to ${ask}${about}: "${input.requestTitle}".`,
        ...(input.message === undefined ? [] : [``, `Their message: ${input.message}`]),
        ...(input.dueAt === undefined ? [] : [``, `Due: ${input.dueAt}`]),
        ``,
        reply,
        ``,
        `You are receiving this because ${input.requesterDisplayName} sent you a request through ${PRODUCT}.`,
      ].join("\n"),
      htmlBody: htmlDocument(
        `A request from ${escapeHtml(input.requesterDisplayName)}`,
        p(`Hello ${escapeHtml(input.recipientName)},`) +
          p(`${escapeHtml(input.requesterDisplayName)} (${escapeHtml(input.workspaceName)}) asked you to ` +
            `${escapeHtml(ask)}${escapeHtml(about)}: "${escapeHtml(input.requestTitle)}".`) +
          (input.message === undefined ? "" : p(`<em>${escapeHtml(input.message)}</em>`)) +
          (input.dueAt === undefined ? "" : p(`Due: ${escapeHtml(input.dueAt)}`)) +
          p(escapeHtml(reply)),
      ),
      attachments: [LOGO_ATTACHMENT],
    };
  },
});

function answeredTemplate(key: "contact-request-completed" | "contact-request-declined", verb: string) {
  return defineTemplate({
    key,
    version: 1,
    locale: "en",
    schema: ContactRequestAnsweredModelV1,
    secretBearing: false,
    render: (input, context) => {
      const url = context.buildPath(CONTACT_REQUESTS_PATH);
      return {
        subject: `${input.responderDisplayName} ${verb} "${input.requestTitle}"`,
        textBody: [
          `Hello ${input.recipientName},`,
          ``,
          `${input.responderDisplayName} ${verb} your request "${input.requestTitle}" in ${input.workspaceName}.`,
          ...(input.reason === undefined ? [] : [``, `Reason: ${input.reason}`]),
          ``,
          url,
        ].join("\n"),
        htmlBody: htmlDocument(
          `Your request was ${escapeHtml(verb)}`,
          p(`Hello ${escapeHtml(input.recipientName)},`) +
            p(`${escapeHtml(input.responderDisplayName)} ${escapeHtml(verb)} your request ` +
              `"${escapeHtml(input.requestTitle)}" in ${escapeHtml(input.workspaceName)}.`) +
            (input.reason === undefined ? "" : p(`<em>${escapeHtml(input.reason)}</em>`)) +
            linkHtml(url, "Open your requests"),
        ),
        attachments: [LOGO_ATTACHMENT],
      };
    },
  });
}

/** 086. In-app only, to the requester. */
export const contactRequestCompletedV1 = answeredTemplate("contact-request-completed", "completed");
/** 086. In-app only, to the requester. */
export const contactRequestDeclinedV1 = answeredTemplate("contact-request-declined", "declined");

// ── 087. Document sharing ────────────────────────────────────────────────────
//
// All four are in-app only — the policy stops their email at creation — and
// registered anyway so every type renders and the feed has a preview.

/** Where a recipient finds documents shared with them. */
const SHARED_WITH_ME_PATH = "/app/documents/shared-with-me";
/** Where an owner manages the sharing of what they sent. */
const SHARED_BY_ME_PATH = "/app/documents/shared-by-me";

function inAppNotice(title: string, recipientName: string, line: string, url: string, cta: string) {
  return {
    subject: title,
    textBody: [`Hello ${recipientName},`, ``, line, ``, url].join("\n"),
    htmlBody: htmlDocument(
      escapeHtml(title),
      p(`Hello ${escapeHtml(recipientName)},`) + p(escapeHtml(line)) + linkHtml(url, cta),
    ),
    attachments: [LOGO_ATTACHMENT],
  };
}

export const documentShareReceivedV1 = defineTemplate({
  key: "document-share-received",
  version: 1,
  locale: "en",
  schema: DocumentShareReceivedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.sharerDisplayName} shared "${input.documentTitle}" with you`,
    input.recipientName,
    `${input.sharerDisplayName} (${input.workspaceName}) shared the completed document `
      + `"${input.documentTitle}" (${input.verificationId}) with you. Accept it to open it.`,
    context.buildPath(SHARED_WITH_ME_PATH),
    "Open Shared with me",
  ),
});

export const documentShareAnsweredV1 = defineTemplate({
  key: "document-share-answered",
  version: 1,
  locale: "en",
  schema: DocumentShareAnsweredModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.responderDisplayName} ${input.answer} "${input.documentTitle}"`,
    input.recipientName,
    `${input.responderDisplayName} ${input.answer} the completed document `
      + `"${input.documentTitle}" (${input.verificationId}) you shared from ${input.workspaceName}.`,
    context.buildPath(SHARED_BY_ME_PATH),
    "Open Shared by me",
  ),
});

export const documentAccessRequestedV1 = defineTemplate({
  key: "document-access-requested",
  version: 1,
  locale: "en",
  schema: DocumentAccessRequestedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.requesterDisplayName} asked for access to "${input.documentTitle}"`,
    input.recipientName,
    `${input.requesterDisplayName} (${input.requesterEmail}) asked for access to the completed `
      + `document "${input.documentTitle}" (${input.verificationId}) in ${input.workspaceName}.`
      + (input.note === undefined ? "" : ` Their note: ${input.note}`),
    context.buildPath(SHARED_BY_ME_PATH),
    "Review the request",
  ),
});

export const documentAccessDecidedV1 = defineTemplate({
  key: "document-access-decided",
  version: 1,
  locale: "en",
  schema: DocumentAccessDecidedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `Your access request for "${input.documentTitle}" was ${input.decision}`,
    input.recipientName,
    `${input.deciderDisplayName} ${input.decision} your request for access to the completed `
      + `document "${input.documentTitle}" (${input.verificationId}) in ${input.workspaceName}.`,
    context.buildPath(SHARED_WITH_ME_PATH),
    "Open Shared with me",
  ),
});

// ── 089. The invitee inbox ─────────────────────────────────────────────────
//
// Both in-app only, like the sharing notices above.

/** Where an account finds the invitations addressed to it. */
const MY_INVITATIONS_PATH = "/app/invitations";
/** Where a manager sees the invitations their workspace sent. */
const WORKSPACE_INVITATIONS_PATH = "/app/settings/members";

const INVITED_ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  administrator: "Administrator",
  template_administrator: "Template administrator",
  sender: "Sender",
  reviewer: "Reviewer",
  auditor: "Auditor",
  member: "New Comer",
});
const invitedRole = (role: string): string => INVITED_ROLE_LABELS[role] ?? role;

export const workspaceInvitationReceivedV1 = defineTemplate({
  key: "workspace-invitation-received",
  version: 1,
  locale: "en",
  schema: WorkspaceInvitationReceivedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.inviterDisplayName} invited you to ${input.workspaceName}`,
    input.recipientName,
    `${input.inviterDisplayName} invited you to join ${input.workspaceName} as `
      + `${invitedRole(input.role)}. The invitation is open until ${input.expiresAt}.`,
    context.buildPath(MY_INVITATIONS_PATH),
    "Open your invitations",
  ),
});

export const workspaceInvitationDeclinedV1 = defineTemplate({
  key: "workspace-invitation-declined",
  version: 1,
  locale: "en",
  schema: WorkspaceInvitationDeclinedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.inviteeDisplayName} declined the invitation to ${input.workspaceName}`,
    input.recipientName,
    `${input.inviteeDisplayName} (${input.inviteeEmail}) declined the invitation to join `
      + `${input.workspaceName} as ${invitedRole(input.role)}.`
      + (input.reason === undefined ? "" : ` Their reason: ${input.reason}`),
    context.buildPath(WORKSPACE_INVITATIONS_PATH),
    "Open invitations",
  ),
});

// ── 091. Contact connections ────────────────────────────────────────────────
//
// In-app only, like 087's and 089's: rendered so the intent is complete, never
// sent (the policy suppresses the email).

const PENDING_CONTACTS_PATH = "/app/contacts/pending";
const CONTACTS_PATH = "/app/contacts";

export const contactConnectionRequestedV1 = defineTemplate({
  key: "contact-connection-requested",
  version: 1,
  locale: "en",
  schema: ContactConnectionRequestedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.requesterDisplayName} wants to add you as a contact`,
    input.recipientName,
    `${input.requesterDisplayName} (${input.workspaceName}) asked to add you as a contact on LAGDA. `
      + "Accept to add each other, or decline — they are not told.",
    context.buildPath(PENDING_CONTACTS_PATH),
    "Review the request",
  ),
});

export const contactConnectionAcceptedV1 = defineTemplate({
  key: "contact-connection-accepted",
  version: 1,
  locale: "en",
  schema: ContactConnectionAcceptedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.responderDisplayName} accepted your contact request`,
    input.recipientName,
    `${input.responderDisplayName} accepted your request. You are now in each other's contacts.`,
    context.buildPath(CONTACTS_PATH),
    "Open contacts",
  ),
});

// ── 093. Plans ─────────────────────────────────────────────────────────────
//
// Emailed AND listed in-app. The approver's link opens the request inside
// LAGDA, where deciding needs the approver's own session: the email carries
// no credential and no bank details.

const PLAN_PATH = "/app/settings/plan";

export const planUpgradeRequestedV1 = defineTemplate({
  key: "plan-upgrade-requested",
  version: 1,
  locale: "en",
  schema: PlanUpgradeRequestedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.requesterDisplayName} asked for the ${input.planName} plan`,
    input.recipientName,
    `${input.requesterDisplayName} (${input.requesterEmail}) asked to move to ${input.planName} `
      + `for ${input.amount} a month, using the test-mode sample account. No money was moved. `
      + `Approve or decline it in LAGDA before ${input.expiresAt}.`,
    context.buildPath(`/app/plan-requests/${encodeURIComponent(input.requestId)}`),
    "Review the request",
  ),
});

export const planUpgradeApprovedV1 = defineTemplate({
  key: "plan-upgrade-approved",
  version: 1,
  locale: "en",
  schema: PlanUpgradeDecidedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `Your ${input.planName} plan is active`,
    input.recipientName,
    `Your request was approved. ${input.planName} is active`
      + (input.paidUntil === undefined ? "." : ` until ${input.paidUntil}.`)
      + " Everything it includes is unlocked now.",
    context.buildPath(PLAN_PATH),
    "Open Plan & Billing",
  ),
});

export const planUpgradeDeclinedV1 = defineTemplate({
  key: "plan-upgrade-declined",
  version: 1,
  locale: "en",
  schema: PlanUpgradeDecidedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `Your ${input.planName} plan request was declined`,
    input.recipientName,
    `Your request to move to ${input.planName} was declined. You can send a new request from Plan & Billing.`,
    context.buildPath(PLAN_PATH),
    "Open Plan & Billing",
  ),
});

// ── 095. Messages from the public website ──────────────────────────────────
//
// To the LAGDA owner's inbox account only. It says who wrote and what kind of
// message it is; the message itself is read inside LAGDA, with that account's
// own session. The email carries no credential.

export const publicInquiryReceivedV1 = defineTemplate({
  key: "public-inquiry-received",
  version: 1,
  locale: "en",
  schema: PublicInquiryReceivedModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.kindLabel} from ${input.senderName}`,
    input.recipientName,
    `${input.senderName} (${input.senderEmail}) sent a message from the LAGDA website: `
      + `${input.kindLabel}. Open it in LAGDA to read it and reply to them.`,
    context.buildPath(`/app/inquiries/${encodeURIComponent(input.inquiryId)}`),
    "Open the message",
  ),
});

// ── 096. A document waiting for your signature, in-app ─────────────────────
//
// Never emailed (the policy stops it): the SIGNING_INVITATION email carried
// the link. This is what the signed-in account sees, and it opens the
// "Needs your signature" list, where the in-app continue takes over.

const TO_SIGN_PATH = "/app/documents?list=to-sign";

export const documentWaitingForSignatureV1 = defineTemplate({
  key: "document-waiting-for-signature",
  version: 1,
  locale: "en",
  schema: DocumentWaitingForSignatureModelV1,
  secretBearing: false,
  render: (input, context) => inAppNotice(
    `${input.documentTitle} is waiting for your signature`,
    input.recipientName,
    `${input.senderDisplayName} (${input.workspaceName}) sent you ${input.documentTitle} to sign. `
      + "It is under Needs your signature in LAGDA.",
    context.buildPath(TO_SIGN_PATH),
    "Open Needs your signature",
  ),
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
  documentUploadRequestedV1,
  finalCopyAvailableV1,
  workspaceJoinLinkV1,
  workspaceJoinRequestedV1,
  workspaceJoinDecidedV1,
  verificationAccessCodeV1,
  contactRequestReceivedV1,
  contactRequestEmailedV1,
  contactRequestCompletedV1,
  contactRequestDeclinedV1,
  documentShareReceivedV1,
  documentShareAnsweredV1,
  documentAccessRequestedV1,
  documentAccessDecidedV1,
  workspaceInvitationReceivedV1,
  workspaceInvitationDeclinedV1,
  contactConnectionRequestedV1,
  contactConnectionAcceptedV1,
  planUpgradeRequestedV1,
  planUpgradeApprovedV1,
  planUpgradeDeclinedV1,
  publicInquiryReceivedV1,
  documentWaitingForSignatureV1,
] as const;

export type AccountEmailVerificationModel = Static<typeof AccountEmailVerificationModelV1>;
export type PasswordResetModel = Static<typeof PasswordResetModelV1>;
export type WorkspaceInvitationModel = Static<typeof WorkspaceInvitationModelV1>;
export type SigningInvitationModel = Static<typeof SigningInvitationModelV1>;
export type SigningCompletedModel = Static<typeof SigningCompletedModelV1>;
export type DocumentUploadRequestedModel = Static<typeof DocumentUploadRequestedModelV1>;
