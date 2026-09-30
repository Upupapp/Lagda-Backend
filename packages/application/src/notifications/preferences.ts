// 084. Which notification types an account's preferences may switch off.
//
// ── One table, keyed by the closed type union ─────────────────────────────
//
// A `Record<NotificationType, …>`, so adding a notification type without
// deciding here whether a person may opt out of it is a compile error, not a
// message that is silently optional (or silently mandatory).
//
// ── What can never be switched off ─────────────────────────────────────────
//
// `null` means ALWAYS SENT. That is every security and transactional message:
// a credential someone is waiting for (verification, reset, access code), a
// document someone must act on or is entitled to (signing invitation, final
// copy), and anything addressed to a person who may hold no account at all
// (workspace invitation, join link) — a preference can only belong to an
// account, and those audiences are not accounts.
//
// ── Only an ACCOUNT audience is ever consulted ─────────────────────────────
//
// A category is applied only when the intent's audience is `USER`. Every
// mapped type below is USER-audience by policy today; the audience check in
// `createNotificationIntent` keeps that true if a policy ever changes.
//
// ── Categories with no type yet ────────────────────────────────────────────
//
//   signerActivity   no per-signer "X signed / declined / approved" notice is
//                    sent to the sender today (the sender learns from the
//                    in-app document feed, which reads evidence, not intents).
//   actionReminders  no reminder notification exists yet.
//   invitations      the only invitation notices (WORKSPACE_INVITATION,
//                    WORKSPACE_JOIN_LINK) are addressed to invitees who may
//                    have no account, so they are always sent.
//
// The switches are stored and returned so the settings page is truthful the
// day those notices are added: map the new type here and it is honoured.

import type { NotificationType } from "../common/ports/notifications.js";
import type { NotificationPreferenceCategory } from "../common/ports/notification-preferences.js";

export const NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE: Readonly<
  Record<NotificationType, NotificationPreferenceCategory | null>
> = {
  // Security: a credential for the account itself.
  ACCOUNT_EMAIL_VERIFICATION: null,
  PASSWORD_RESET: null,
  // Addressed to an invitee who may have no account.
  WORKSPACE_INVITATION: null,
  // Transactional: a document a recipient must act on, with its link.
  SIGNING_INVITATION: null,
  // "Your request is complete" — to the SENDER's account. Optional.
  SIGNING_COMPLETED: "requestCompleted",
  // Work assigned to a member (supply a document). Transactional: switching
  // it off would hide a task from the person it is assigned to.
  DOCUMENT_UPLOAD_REQUESTED: null,
  // A participant's entitlement to the signed copy, with its link.
  FINAL_COPY_AVAILABLE: null,
  // A join link to someone who may have no account.
  WORKSPACE_JOIN_LINK: null,
  // "Someone asked to join" — to each owner/administrator. Optional.
  WORKSPACE_JOIN_REQUESTED: "workspaceRequests",
  // The requester's own answer. Transactional.
  WORKSPACE_JOIN_DECIDED: null,
  // Security: the emailed code unlocking a verified document.
  VERIFICATION_ACCESS_CODE: null,
  // 086. The three member notices are in-app only, so there is no email for a
  // preference to stop; the external one goes to somebody with no account.
  CONTACT_REQUEST_RECEIVED: null,
  CONTACT_REQUEST_EMAILED: null,
  CONTACT_REQUEST_COMPLETED: null,
  CONTACT_REQUEST_DECLINED: null,
  // 087. The six sharing notices are in-app only; the code is security mail.
  DOCUMENT_SHARE_RECEIVED: null,
  DOCUMENT_SHARE_ACCEPTED: null,
  DOCUMENT_SHARE_REJECTED: null,
  DOCUMENT_ACCESS_REQUESTED: null,
  DOCUMENT_ACCESS_APPROVED: null,
  DOCUMENT_ACCESS_REJECTED: null,
  SHARED_DOCUMENT_ACCESS_CODE: null,
  // 089. Both invitation-inbox notices are in-app only: no email to stop.
  WORKSPACE_INVITATION_RECEIVED: null,
  WORKSPACE_INVITATION_DECLINED: null,
  // 091. Both connection notices are in-app only: no email to stop.
  CONTACT_CONNECTION_REQUESTED: null,
  CONTACT_CONNECTION_ACCEPTED: null,
  // 093. About the account's own plan: always sent.
  PLAN_UPGRADE_REQUESTED: null,
  PLAN_UPGRADE_APPROVED: null,
  PLAN_UPGRADE_DECLINED: null,
};

/** The category governing a type, or null when it is always sent. */
export function notificationPreferenceCategoryOf(
  notificationType: NotificationType,
): NotificationPreferenceCategory | null {
  return NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE[notificationType];
}
