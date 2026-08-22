// The event→notification policy, in one table.
//
// ── Why this is a table and not a call site ────────────────────────────────
//
// The failure this prevents is `if (signed) sendEmail(...)` appearing in a
// domain use case (S96). Once one exists, the answer to "what does LAGDA send
// when a request completes?" is a grep, the answer to "does this send twice?"
// is unknowable, and a change to invitation copy means editing the signing
// transaction.
//
// So the mapping from a business reason to everything that reason implies —
// which template, which audience shape, which source, whether a secret is
// involved — lives here, and producers name a type rather than assembling a
// message.
//
// ── What is deliberately not in it ────────────────────────────────────────
//
// The DECISION to notify. This table answers "if a SIGNING_INVITATION happens,
// what does it look like?"; it does not decide that one happened. That belongs
// to the domain transition that owns the fact, inside its own transaction
// (S97, S98), because only that transaction knows whether the fact committed.

import type {
  NotificationType, NotificationChannel, NotificationSourceKind,
  NotificationAudienceKind, NotificationTemplateKey,
} from "../common/ports/notifications.js";

/**
 * Everything one business reason implies.
 *
 * `secretKind` is part of the policy rather than a per-call argument because
 * whether a message carries a credential is a property of what the message IS.
 * A signing invitation without a link is not a signing invitation, and letting
 * a caller pass `undefined` would make that a runtime accident.
 */
export interface NotificationPolicy {
  readonly notificationType: NotificationType;
  readonly templateKey: NotificationTemplateKey;
  readonly channel: NotificationChannel;
  readonly sourceKind: NotificationSourceKind;
  readonly audienceKind: NotificationAudienceKind;
  /**
   * How the credential this message carries is referenced.
   *
   * SEALED    an encrypted credential travels with the intent, because it
   *           cannot be recovered from a digest — signing links.
   * CHALLENGE only the id of the auth challenge that owns the credential.
   *           Verification, reset and OTP flows persist digests, and storing
   *           their raw values here would weaken them for uniformity's sake.
   */
  readonly secretKind: "SEALED" | "CHALLENGE";
  /**
   * Whether the intent belongs to a workspace or to an account.
   *
   * Account security messages are GLOBAL_USER: a password reset is a fact
   * about a person, and filing it under a workspace would both leak it to that
   * workspace's admins and orphan it when the workspace is deleted (S46).
   */
  readonly scopeKind: "WORKSPACE" | "GLOBAL_USER";
}

/**
 * The complete policy table. Every notification LAGDA sends appears once.
 *
 * A `Record` keyed by the closed type union, so adding a `NotificationType`
 * without a policy is a compile error rather than a message that silently
 * never sends.
 */
export const NOTIFICATION_POLICIES: Record<NotificationType, NotificationPolicy> = {
  ACCOUNT_EMAIL_VERIFICATION: {
    notificationType: "ACCOUNT_EMAIL_VERIFICATION",
    templateKey: "account-email-verification",
    channel: "EMAIL",
    sourceKind: "SECURITY_CHALLENGE",
    audienceKind: "USER",
    secretKind: "CHALLENGE",
    scopeKind: "GLOBAL_USER",
  },
  PASSWORD_RESET: {
    notificationType: "PASSWORD_RESET",
    templateKey: "password-reset",
    channel: "EMAIL",
    sourceKind: "SECURITY_CHALLENGE",
    audienceKind: "USER",
    secretKind: "CHALLENGE",
    scopeKind: "GLOBAL_USER",
  },
  WORKSPACE_INVITATION: {
    notificationType: "WORKSPACE_INVITATION",
    templateKey: "workspace-invitation",
    channel: "EMAIL",
    sourceKind: "WORKSPACE_INVITATION",
    audienceKind: "WORKSPACE_INVITEE",
    secretKind: "CHALLENGE",
    // Workspace-scoped despite being addressed to somebody who is not yet a
    // member: the invitation is the workspace's record, and revoking it is a
    // workspace operation.
    scopeKind: "WORKSPACE",
  },
  SIGNING_INVITATION: {
    notificationType: "SIGNING_INVITATION",
    templateKey: "signing-invitation",
    channel: "EMAIL",
    // The GRANT, not the signing request. A grant is provisioned once per
    // recipient activation, which is exactly the granularity one invitation
    // has — keying on the request would collapse a five-recipient request into
    // one notification (S39).
    sourceKind: "SIGNING_ACCESS_GRANT",
    audienceKind: "SIGNING_REQUEST_RECIPIENT",
    secretKind: "SEALED",
    scopeKind: "WORKSPACE",
  },
};

export function policyFor(notificationType: NotificationType): NotificationPolicy {
  return NOTIFICATION_POLICIES[notificationType];
}
