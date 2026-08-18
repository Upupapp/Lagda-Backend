// Turning a password-reset challenge into a notification.
//
// The account-scoped sibling of the invitation producer, and the reason OD-185
// exists: this runs inside a transaction that had no user context until the
// address lookup found one.
//
// ── What it carries ────────────────────────────────────────────────────────
//
// A POINTER to the challenge. The raw token is sealed on the challenge row,
// where `expires_at`, `consumed_at` and `superseded_at` bound its life; the
// link is rebuilt from configuration at send time. Nothing here holds a
// credential, and nothing here builds a URL.
//
// ── What it must never do ──────────────────────────────────────────────────
//
// Distinguish a known address from an unknown one. It is only reached when an
// account was found, and the caller returns the same result either way — so
// there is no branch here that could become an oracle.

import type { NotificationRepository, Clock } from "../common/ports/index.js";
import type { UserId } from "@lagda/contracts";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { PasswordResetChallengeId } from "../common/ports/auth.js";
import type { VerificationChallengeId } from "../common/ports/auth.js";
import type { NotificationTemplateRegistry } from "./template-registry.js";
import { createNotificationIntent } from "./create-intent.js";

/** Shown when the account carries no display name. */
const FALLBACK_NAME = "there";

export interface ResetProducerDependencies {
  readonly templates: NotificationTemplateRegistry;
  readonly ids: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly clock: Clock;
}

export interface ResetNotificationInput {
  readonly challengeId: PasswordResetChallengeId | VerificationChallengeId;
  readonly userId: UserId;
  /**
   * The account's canonical address, read in this transaction.
   *
   * Not the address the requester TYPED. Normalisation means the two can differ
   * in case or dots, and mail must go to the account's own address rather than
   * to whatever form resolved it.
   */
  readonly destination: string;
  readonly displayName: string | null;
}

/**
 * The verification sibling.
 *
 * A separate function rather than a parameterised one, matching the separation
 * the challenge TABLES already keep: `email_verification_challenges` and
 * `password_reset_challenges` were built as distinct types with the same shape
 * precisely so one cannot be passed where the other is expected. Collapsing
 * their producers would re-introduce by parameter what the schema separates by
 * type — and the parameter that decides which credential domain a message
 * belongs to is the one worst suited to being a variable.
 */
export function createVerificationNotificationProducer(
  deps: ResetProducerDependencies,
) {
  return async (
    input: ResetNotificationInput,
    notifications: NotificationRepository,
    transaction: unknown,
  ): Promise<void> => {
    await createNotificationIntent({
      notifications,
      templates: deps.templates,
      ids: deps.ids,
      clock: deps.clock,
    })({
      notificationType: "ACCOUNT_EMAIL_VERIFICATION",
      sourceId: input.challengeId,
      scope: { kind: "GLOBAL_USER", userId: input.userId },
      audience: { kind: "USER", userId: input.userId },
      destination: input.destination,
      templateInput: { recipientName: input.displayName ?? FALLBACK_NAME },
      secretRef: { kind: "CHALLENGE", challengeId: input.challengeId },
    }, transaction);
  };
}

export function createResetNotificationProducer(deps: ResetProducerDependencies) {
  return async (
    input: ResetNotificationInput,
    notifications: NotificationRepository,
    transaction: unknown,
  ): Promise<void> => {
    await createNotificationIntent({
      notifications,
      templates: deps.templates,
      ids: deps.ids,
      clock: deps.clock,
    })({
      notificationType: "PASSWORD_RESET",
      // The CHALLENGE is the source, so one rotation is one logical
      // notification. A replayed request supersedes the old challenge and
      // creates a new one, which is a different source and therefore correctly
      // a different message.
      sourceId: input.challengeId,
      // GLOBAL_USER, never a workspace. A password reset is a fact about a
      // person; filing it under a workspace would leak it to that workspace's
      // administrators and orphan it when the workspace was deleted.
      scope: { kind: "GLOBAL_USER", userId: input.userId },
      audience: { kind: "USER", userId: input.userId },
      destination: input.destination,
      templateInput: { recipientName: input.displayName ?? FALLBACK_NAME },
      secretRef: { kind: "CHALLENGE", challengeId: input.challengeId },
    }, transaction);
  };
}
