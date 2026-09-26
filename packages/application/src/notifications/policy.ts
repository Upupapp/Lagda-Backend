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
   * How the credential this message carries is referenced, or ABSENT when it
   * carries none.
   *
   * SEALED    an encrypted credential travels with the intent, because it
   *           cannot be recovered from a digest — signing links.
   * CHALLENGE only the id of the auth challenge that owns the credential.
   *           Verification, reset and OTP flows persist digests, and storing
   *           their raw values here would weaken them for uniformity's sake.
   * absent    the message carries no credential at all. `SIGNING_COMPLETED` is
   *           the first such message: it notifies an account holder about
   *           their own request, and the reader follows an ordinary
   *           authenticated route.
   *
   * ── Why optional rather than a third "NONE" value ─────────────────────────
   *
   * Because the DATABASE already models it that way. Migration 030's
   * `notification_intents_secret_kind_check` is
   * `secret_ref_kind IS NULL OR IN ('SEALED','CHALLENGE')`, and
   * `notification_intents_secret_ref_check` has an explicit all-null branch.
   * `NotificationIntentRecord.secretRef` is likewise already optional, and
   * `deliverNotification` already treats an absent ref as "AVAILABLE, no
   * secret" without calling the resolver. A `"NONE"` sentinel would be a
   * fourth spelling of null that the schema would then have to map back to
   * NULL on the way in and out.
   */
  readonly secretKind?: "SEALED" | "CHALLENGE";
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
  SIGNING_COMPLETED: {
    notificationType: "SIGNING_COMPLETED",
    templateKey: "signing-completed",
    channel: "EMAIL",
    // The REQUEST, not a grant and not the completion run. There is exactly one
    // completion per request, so this is the granularity at which
    // `notification_intents_logical_key` becomes the no-duplicates guarantee.
    //
    // Deliberately not the completion RUN: a run is an attempt, and BACKEND-38
    // may legitimately produce several for one request after a retryable
    // failure. Keying on the run would mean one email per attempt.
    sourceKind: "SIGNING_REQUEST",
    // The SENDER's account, which is why this is the first USER-audience
    // message that is nonetheless workspace-scoped: the completion is the
    // workspace's record, but the person told about it is an account holder.
    audienceKind: "USER",
    // No `secretKind`. Nothing in this message is a credential.
    //
    // Workspace-scoped, unlike the other two USER-audience policies above. A
    // password reset is a fact about a person and must not be filed under a
    // workspace (S46); a completed signing request is a fact about the
    // WORKSPACE's document, and filing it globally would orphan it from the
    // tenant whose data it describes.
    scopeKind: "WORKSPACE",
  },
  DOCUMENT_UPLOAD_REQUESTED: {
    notificationType: "DOCUMENT_UPLOAD_REQUESTED",
    templateKey: "document-upload-requested",
    channel: "EMAIL",
    // The REQUEST. There is exactly one notification per request, so this is
    // the granularity at which `notification_intents_logical_key` becomes the
    // no-duplicates guarantee.
    sourceKind: "DOCUMENT_UPLOAD_REQUEST",
    // The ASSIGNEE's account. Addressed to a user rather than a contact
    // because fulfilling this means writing into the workspace, and workspace
    // writes are authorized by membership — see migration 067's header.
    audienceKind: "USER",
    // No `secretKind`. The reader signs in and follows an ordinary
    // authenticated route to their own queue; a bearer token here would be a
    // credential minted for somebody who does not need one.
    //
    // Workspace-scoped for the same reason `SIGNING_COMPLETED` is: the
    // request is the WORKSPACE's record, even though the person told about it
    // is an account holder.
    scopeKind: "WORKSPACE",
  },
  FINAL_COPY_AVAILABLE: {
    notificationType: "FINAL_COPY_AVAILABLE",
    templateKey: "final-copy-available",
    channel: "EMAIL",
    // The GRANT: one per participant, so one email per participant, and the
    // logical-key index refuses a second for a re-driven completion.
    sourceKind: "FINAL_COPY_GRANT",
    audienceKind: "SIGNING_REQUEST_RECIPIENT",
    // The download link travels sealed, exactly as a signing link does.
    secretKind: "SEALED",
    scopeKind: "WORKSPACE",
  },
  WORKSPACE_JOIN_LINK: {
    notificationType: "WORKSPACE_JOIN_LINK",
    templateKey: "workspace-join-link",
    channel: "EMAIL",
    // One SEND of the ticket, each with its own id, so sending again is a new
    // email rather than a collision with the first.
    sourceKind: "WORKSPACE_JOIN_TICKET",
    audienceKind: "WORKSPACE_JOIN_TICKET",
    secretKind: "SEALED",
    scopeKind: "WORKSPACE",
  },
  WORKSPACE_JOIN_REQUESTED: {
    notificationType: "WORKSPACE_JOIN_REQUESTED",
    templateKey: "workspace-join-requested",
    channel: "EMAIL",
    // One notice per owner/administrator, each its own id.
    sourceKind: "WORKSPACE_JOIN_REQUEST",
    audienceKind: "USER",
    scopeKind: "WORKSPACE",
  },
  WORKSPACE_JOIN_DECIDED: {
    notificationType: "WORKSPACE_JOIN_DECIDED",
    templateKey: "workspace-join-decided",
    channel: "EMAIL",
    // The request itself: exactly one decision per request.
    sourceKind: "WORKSPACE_JOIN_REQUEST",
    audienceKind: "USER",
    scopeKind: "WORKSPACE",
  },
};

export function policyFor(notificationType: NotificationType): NotificationPolicy {
  return NOTIFICATION_POLICIES[notificationType];
}
