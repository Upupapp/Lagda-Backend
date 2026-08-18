// Creating a notification intent.
//
// ── One entry point, and no public one ─────────────────────────────────────
//
// This is the only way a notification comes into existence (S104). There is no
// route behind it and there must not be: a `POST /notifications` taking a type,
// a destination and a body is an email-sending API attached to a product that
// signs legal documents (S105, S288). Notification creation is
// server-authoritative, and every producer is a domain transition that already
// holds the fact justifying the message.
//
// ── It runs inside the caller's transaction ────────────────────────────────
//
// The `transaction` parameter is the whole design (S98). The intent commits
// with the fact that justified it, or neither does. A request that is SENT with
// no invitation queued, or an invitation queued for a request that rolled back,
// are both states nothing should be able to produce.
//
// What does NOT happen here is any provider call (S99). Nothing in this file
// touches a network, so a provider outage cannot hold a database transaction
// open or fail a send.

import type {
  NotificationRepository, NotificationCreationResult, NotificationType,
  NotificationAudience, NotificationScope, NotificationSecretRef,
  NotificationTemplateInput, NotificationLocale, NewNotificationIntent,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "./template-registry.js";
import { policyFor } from "./policy.js";

/** The default and only locale. Frozen onto every intent (S144). */
const DEFAULT_LOCALE: NotificationLocale = "en";

export interface CreateNotificationIntentInput {
  readonly notificationType: NotificationType;
  /** The authoritative record that justifies the message. */
  readonly sourceId: string;
  readonly scope: NotificationScope;
  readonly audience: NotificationAudience;
  /**
   * The delivery address, snapshotted by the CALLER from the authoritative
   * identity for its own operation (S22).
   *
   * A parameter rather than something resolved here, because only the caller
   * knows which identity is authoritative for its source: a signing invitation
   * must use the immutable `SigningRequestRecipient` email (S23, S249), never
   * the Contact it was copied from and never the account email of a user who
   * happens to share the address (S252).
   */
  readonly destination: string;
  readonly templateInput: NotificationTemplateInput;
  readonly secretRef: NotificationSecretRef;
}

export class NotificationPolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationPolicyViolation";
  }
}

export interface CreateNotificationIntentDependencies {
  readonly notifications: NotificationRepository;
  readonly templates: NotificationTemplateRegistry;
}

/**
 * Creates the intent and its PENDING delivery, or returns the existing pair.
 *
 * Idempotent on the logical key, so a producer may call it on every replay of
 * its source event without guarding (S36). The returned `outcome` tells the
 * caller whether transport needs scheduling.
 */
export function createNotificationIntent(
  deps: CreateNotificationIntentDependencies,
) {
  return async (
    input: CreateNotificationIntentInput,
    transaction: unknown,
  ): Promise<NotificationCreationResult> => {
    const policy = policyFor(input.notificationType);

    // The policy owns the shape; a caller cannot substitute another audience or
    // another scope for a type. Checked rather than trusted, because these are
    // the two fields whose confusion produces a cross-tenant or cross-account
    // message (S272, S273).
    if (input.audience.kind !== policy.audienceKind) {
      throw new NotificationPolicyViolation(
        `${input.notificationType} requires a ${policy.audienceKind} audience, ` +
          `received ${input.audience.kind}`);
    }
    if (input.scope.kind !== policy.scopeKind) {
      throw new NotificationPolicyViolation(
        `${input.notificationType} is ${policy.scopeKind}-scoped, ` +
          `received ${input.scope.kind}`);
    }
    if (input.secretRef.kind !== policy.secretKind) {
      throw new NotificationPolicyViolation(
        `${input.notificationType} uses a ${policy.secretKind} secret reference, ` +
          `received ${input.secretRef.kind}`);
    }

    // The version is resolved ONCE, here, and frozen onto the row. Resolving it
    // at render time is the substitution the freeze exists to prevent (S59).
    const version = deps.templates.currentVersion(policy.templateKey);
    const template = { key: policy.templateKey, version };

    // Validated before the row exists, so a model the template cannot render is
    // a failure the producer sees rather than a message that fails at send time
    // when it is already owed to somebody (S244).
    deps.templates.validateInput(template, input.templateInput);

    const newIntent: NewNotificationIntent = {
      scope: input.scope,
      notificationType: input.notificationType,
      source: { kind: policy.sourceKind, sourceId: input.sourceId },
      audience: input.audience,
      template,
      locale: DEFAULT_LOCALE,
      templateInput: input.templateInput,
      secretRef: input.secretRef,
      channel: policy.channel,
      destination: input.destination,
    };

    return deps.notifications.createIfAbsent(newIntent, transaction);
  };
}
