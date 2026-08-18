// Delivering one notification.
//
// ── The shape is dictated by one rule ──────────────────────────────────────
//
// A provider network call may never happen inside a database transaction
// (S71, S73). So this is three phases, not one:
//
//   1. short transaction  — claim the delivery, open an attempt, COMMIT
//   2. no transaction     — check the credential, render, call the provider
//   3. short transaction  — close the attempt, move the delivery
//
// A single transaction spanning the send would hold a connection for the
// provider's entire latency, and a provider that hangs would exhaust the pool
// before it exhausted anyone's patience.
//
// The cost of splitting is that a crash between phase 2 and phase 3 leaves an
// attempt open and a lease held. That is not papered over: the lease expires,
// the reclaim sweep returns the delivery to FAILED_RETRYABLE, and the attempt
// budget has already been consumed — so the same message is retried a bounded
// number of times and then stops.
//
// ── What this does not do ──────────────────────────────────────────────────
//
// It does not mint credentials, rotate them, or create intents. A transport
// retry reuses the same intent, the same delivery and the same still-valid
// secret (S64). An explicit resend is a different operation owned by the domain
// that owns the credential (S65).
//
// It writes nothing to evidence, and reads no signing state. A delivery outcome
// is not a fact about a signer.

import type {
  NotificationTransportRepository,
  NotificationSecretRef, NotificationSource, NotificationDeliveryId,
  NotificationDeliveryAttemptIdGenerator, NotificationFailureCode,
  EmailDeliveryProvider, EmailMessage, AttemptOutcome, AttemptFailureCode,
} from "../common/ports/notifications.js";
import type { Clock } from "../common/ports/index.js";
import type { NotificationTemplateRegistry } from "./template-registry.js";
import { deliveryStateForOutcome, retryDelayMs } from "@lagda/core";

/**
 * Resolves the raw one-time secret a message carries, or refuses.
 *
 * Implemented per secret kind by the domain that owns the credential — the
 * signing access domain for `SEALED`, the auth domain for `CHALLENGE`. It is a
 * port rather than a branch here because only those domains know what expiry,
 * revocation and supersession mean for their own credential.
 *
 * The `UNUSABLE` case is the important one (S58-S62). A reset token that
 * expired while the message sat in a queue must not be delivered: the recipient
 * receives a link that fails, learns nothing about why, and the send looks
 * successful in every metric.
 */
export interface NotificationSecretResolution {
  readonly status: "AVAILABLE" | "UNUSABLE";
  /** Present only when AVAILABLE. Lives for one render and is never stored. */
  readonly secret?: string;
  readonly reason?: NotificationFailureCode;
}

export interface NotificationSecretResolver {
  /**
   * @param secretRef  how the credential is referenced — sealed, or a pointer.
   * @param source     the record that OWNS the credential. Required, because a
   *                   validity check is a question about the grant, the reset
   *                   challenge or the invitation — not about the ciphertext,
   *                   which is only how transport carries it.
   */
  resolve(
    secretRef: NotificationSecretRef,
    source: NotificationSource,
    transaction?: unknown,
  ): Promise<NotificationSecretResolution>;
}

/** Builds first-party URLs from configured base only (S147). */
export interface NotificationLinkBuilder {
  build(path: string, token: string): string;
}

export interface DeliverNotificationDependencies {
  readonly transport: NotificationTransportRepository;
  readonly templates: NotificationTemplateRegistry;
  readonly secrets: NotificationSecretResolver;
  readonly links: NotificationLinkBuilder;
  readonly provider: EmailDeliveryProvider;
  readonly ids: NotificationDeliveryAttemptIdGenerator;
  readonly clock: Clock;
  readonly policy: DeliveryPolicy;
  /**
   * Runs one short transaction.
   *
   * Injected rather than taken as a `TransactionManager` because delivery is
   * scope-agnostic: a notification may be workspace- or user-scoped, and the
   * worker resolves which before calling in.
   */
  readonly runInTransaction: <T>(operation: (transaction: unknown) => Promise<T>) => Promise<T>;
}

export interface DeliveryPolicy {
  /** Bounded. Nothing retries forever, least of all a message with a secret. */
  readonly maxAttempts: number;
  /** How long a worker may hold a claim before it is reclaimable. */
  readonly leaseMs: number;
}

export type DeliveryRunOutcome =
  /** Another worker holds it, or it is cancelled, suppressed or not yet due. */
  | { readonly result: "NOT_CLAIMABLE" }
  | { readonly result: "SENT"; readonly providerMessageReference?: string }
  | { readonly result: "RETRY_SCHEDULED"; readonly attempt: number }
  | { readonly result: "GAVE_UP"; readonly attempt: number }
  /** The credential can no longer work. Not an error, and not retried. */
  | { readonly result: "SUPPRESSED"; readonly reason: NotificationFailureCode };

/** Provider outcomes that consume the budget but may be tried again. */
const RETRYABLE: ReadonlySet<AttemptOutcome> = new Set(["RETRYABLE", "AMBIGUOUS"]);

export function deliverNotification(deps: DeliverNotificationDependencies) {
  return async (
    notificationDeliveryId: NotificationDeliveryId,
  ): Promise<DeliveryRunOutcome> => {
    // ── Phase 1: claim, and commit the claim ─────────────────────────────────
    const claimed = await deps.runInTransaction(transaction =>
      deps.transport.claimForDelivery({
        notificationDeliveryId,
        attemptId: deps.ids.nextNotificationDeliveryAttemptId(),
        now: deps.clock.now(),
        leaseMs: deps.policy.leaseMs,
      }, transaction));

    // Ordinary, not exceptional. At-least-once queue delivery means losing a
    // claim race is the common case.
    if (claimed === null) return { result: "NOT_CLAIMABLE" };

    const { delivery, intent, attempt } = claimed;

    // ── Phase 2: no transaction is held from here until the result ───────────

    // The credential is checked BEFORE rendering, so an expired token never
    // reaches a message body even transiently (S58).
    const resolution = intent.secretRef === undefined
      ? { status: "AVAILABLE" as const, secret: undefined }
      : await deps.secrets.resolve(intent.secretRef, intent.source);

    if (resolution.status === "UNUSABLE") {
      const reason = resolution.reason ?? "SECRET_EXPIRED";
      await deps.runInTransaction(transaction => deps.transport.completeAttempt({
        notificationDeliveryId,
        attemptId: attempt.notificationDeliveryAttemptId,
        outcome: "TERMINAL",
        nextState: "SUPPRESSED",
        now: deps.clock.now(),
      }, transaction));
      // Suppressed rather than failed: nothing went wrong with the transport.
      // The message simply must not be sent, and issuing a replacement belongs
      // to the domain that owns the credential (S62, S63).
      return { result: "SUPPRESSED", reason };
    }

    // Rendered from the intent's OWN frozen template version, never the
    // current one (S78). A v1 message queued before a deploy renders v1.
    const rendered = deps.templates.render(intent.template, intent.templateInput, {
      secret: resolution.secret ?? null,
      buildLink: (path, token) => deps.links.build(path, token),
    });

    const message: EmailMessage = {
      destination: delivery.destination,
      subject: rendered.subject,
      textBody: rendered.textBody,
      ...(rendered.htmlBody === undefined ? {} : { htmlBody: rendered.htmlBody }),
    };

    const sent = await deps.provider.send(message);

    // ── Phase 3: record the outcome in its own short transaction ─────────────
    const outcome: AttemptOutcome =
      sent.outcome === "ACCEPTED" ? "ACCEPTED"
        : sent.outcome === "FAILED_TERMINAL" ? "TERMINAL"
          : sent.outcome === "AMBIGUOUS" ? "AMBIGUOUS" : "RETRYABLE";

    // The budget is spent when the attempt that consumed it was the last one.
    // Checked here rather than at claim time so an attempt is never opened that
    // cannot be recorded.
    const exhausted = attempt.attemptNumber >= deps.policy.maxAttempts;
    const willRetry = RETRYABLE.has(outcome) && !exhausted;

    const nextState = willRetry
      ? deliveryStateForOutcome(outcome)
      : outcome === "ACCEPTED"
        ? deliveryStateForOutcome("ACCEPTED")
        // A retryable failure with no budget left is terminal. Reporting it as
        // still-retryable would leave a delivery nothing will ever pick up,
        // which is indistinguishable from a stranded one.
        : "FAILED_TERMINAL";

    const failureCode = failureCodeFor(outcome);

    await deps.runInTransaction(transaction => deps.transport.completeAttempt({
      notificationDeliveryId,
      attemptId: attempt.notificationDeliveryAttemptId,
      outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(sent.outcome === "ACCEPTED" && sent.providerMessageReference !== undefined
        ? { providerMessageReference: sent.providerMessageReference }
        : {}),
      nextState,
      ...(willRetry
        ? { nextAttemptAt: deps.clock.now() + retryDelayMs(attempt.attemptNumber) }
        : {}),
      now: deps.clock.now(),
    }, transaction));

    if (outcome === "ACCEPTED") {
      return {
        result: "SENT",
        ...(sent.outcome === "ACCEPTED" && sent.providerMessageReference !== undefined
          ? { providerMessageReference: sent.providerMessageReference }
          : {}),
      };
    }
    return willRetry
      ? { result: "RETRY_SCHEDULED", attempt: attempt.attemptNumber }
      : { result: "GAVE_UP", attempt: attempt.attemptNumber };
  };
}

/**
 * The bounded code recorded against a failed attempt.
 *
 * Coarse on purpose. A finer taxonomy would have to come from the provider's
 * own error strings, which is exactly the vendor coupling S165 and S218 forbid.
 */
function failureCodeFor(outcome: AttemptOutcome): AttemptFailureCode | undefined {
  switch (outcome) {
    case "AMBIGUOUS": return "CONNECTION_LOST";
    case "RETRYABLE": return "PROVIDER_UNAVAILABLE";
    case "TERMINAL": return "PROVIDER_REJECTED";
    case "ACCEPTED": return undefined;
    default: return undefined;
  }
}
