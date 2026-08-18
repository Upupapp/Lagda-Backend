// The provider-neutral notification substrate.
//
// ── The distinction this package exists to hold ────────────────────────────
//
// BACKEND-43 separated five concepts that a naive design collapses into one:
//
//   AUTHORITATIVE EVIDENCE EVENT  what happened, legally
//   OPERATIONAL LOG               what the process saw
//   WORKFLOW STATE                where the request is now
//   PRIVATE AUDIT TRAIL           the workspace-facing projection
//   PUBLIC VERIFICATION           the curated external view
//
// BACKEND-44 adds a sixth, and it is the one most likely to be smuggled back
// into the others: NOTIFICATION INTENT.
//
// A notification is communication ABOUT a domain fact. It is never the fact.
// `RECIPIENT_SIGNED` does not become less true because the confirmation email
// bounced, and a request is not un-sent because a provider was down. Every
// interface below is shaped to make the opposite hard to express: there is no
// method that takes a delivery outcome and a SigningRequest, and no delivery
// state that a workflow reads.
//
// ── Intent vs delivery ─────────────────────────────────────────────────────
//
//   NotificationIntent    LAGDA's durable decision that one logical message
//                         should reach one audience for one reason. Business
//                         state. Immutable once written (S55).
//   NotificationDelivery  the channel-specific transport work that intent
//                         requires. Operational state. Mutable (S56).
//
// One intent, one EMAIL delivery, today (S50). The split is not speculative
// fanout — it is what lets a provider retry twenty times without the business
// record ever suggesting twenty notifications happened.
//
// ── What is deliberately absent ────────────────────────────────────────────
//
// No provider. No SMTP. No `sentAt`. No `DELIVERED`. BACKEND-44 builds the
// substrate and stops; BACKEND-45 selects a transport and earns those states.
// A foundation that fakes success is worse than one that admits it cannot
// send yet (S212).

import type {
  WorkspaceId, UserId, WorkspaceInvitationId,
} from "@lagda/contracts";
import type { SigningRequestRecipientId } from "./signing-requests.js";
import type { SealedDeliverySecret } from "./signing-access.js";

// ── Identity ─────────────────────────────────────────────────────────────────
//
// Opaque, server-generated, internal. Notifications have no public API surface
// (S224), so these never appear in a route contract and are not in
// `@lagda/contracts` — the same placement `EvidenceEventId` takes.

export type NotificationIntentId = string & {
  readonly __brand: "NotificationIntentId";
};
export type NotificationDeliveryId = string & {
  readonly __brand: "NotificationDeliveryId";
};

export interface NotificationIntentIdGenerator {
  nextNotificationIntentId(): NotificationIntentId;
}

export interface NotificationDeliveryIdGenerator {
  nextNotificationDeliveryId(): NotificationDeliveryId;
}

// ── Type, channel, audience ──────────────────────────────────────────────────

/**
 * WHY this message is being sent. The business reason, and nothing else.
 *
 * Closed, and deliberately short. Every value here corresponds to a message
 * LAGDA's product actually produces today — the inventory in
 * NOTIFICATION_PRODUCT_INVENTORY.md is what decided the list, not a survey of
 * what an eSignature product could conceivably send.
 *
 * A type is NOT a template (S15) and NOT a channel (S16). `SIGNING_INVITATION`
 * is the reason; `signing-invitation` v1 is one rendering of it; EMAIL is one
 * way to carry it. Collapsing any two of those means a copy change and a
 * channel change become the same edit.
 *
 * Reminders and expiration notices are absent on purpose: BACKEND-46 owns the
 * policy that decides when they occur, and a type with no producer is a
 * promise this command cannot keep.
 */
export const NOTIFICATION_TYPES = [
  "ACCOUNT_EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "MFA_OTP",
  "WORKSPACE_INVITATION",
  "SIGNING_INVITATION",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * HOW it travels.
 *
 * EMAIL alone. SMS, PUSH, WHATSAPP and SLACK are not here, and adding them
 * "for extensibility" (S18) would mean channel-conditional branches guarding
 * transports nobody has built. Widening a closed union later is a one-line
 * change; deleting speculative infrastructure is not.
 */
export const NOTIFICATION_CHANNELS = ["EMAIL"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * WHO the message is for — an identity, never an address (S21).
 *
 * `alice@example.com` is a destination. `SigningRequestRecipientId` is an
 * audience. Keeping them apart is what allows the destination to be frozen
 * from one authoritative source while the audience stays a real foreign key.
 */
export const NOTIFICATION_AUDIENCE_KINDS = [
  "USER",
  "SIGNING_REQUEST_RECIPIENT",
  "WORKSPACE_INVITEE",
] as const;
export type NotificationAudienceKind =
  (typeof NOTIFICATION_AUDIENCE_KINDS)[number];

/**
 * The audience, as a discriminated union rather than a nullable-id soup.
 *
 * `EXTERNAL_EMAIL_DESTINATION` from the command's candidate list (S20) is not
 * here: every message LAGDA sends today is addressed to a party it already has
 * a record for, and an audience kind whose identity is "the email itself"
 * would be the one shape that permits an arbitrary send (S288).
 */
export type NotificationAudience =
  | { readonly kind: "USER"; readonly userId: UserId }
  | {
      readonly kind: "SIGNING_REQUEST_RECIPIENT";
      readonly signingRequestRecipientId: SigningRequestRecipientId;
    }
  | {
      readonly kind: "WORKSPACE_INVITEE";
      readonly invitationId: WorkspaceInvitationId;
    };

// ── Tenancy ──────────────────────────────────────────────────────────────────

/**
 * Which tenancy a notification belongs to.
 *
 * A password reset belongs to an account, not a workspace, and forcing one
 * into a fake `WorkspaceId` (S46, S186) would put a global security message
 * behind a tenant filter — where a workspace admin could read it, and where
 * deleting the workspace would strand it.
 *
 * So the scope is explicit and the workspace is present only where it is real.
 * This is the same discriminant shape `JobTenantScope` uses, for the same
 * reason: the dangerous value must not be the easiest one to produce.
 */
export type NotificationScope =
  | { readonly kind: "WORKSPACE"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "GLOBAL_USER"; readonly userId: UserId };

// ── Source ───────────────────────────────────────────────────────────────────

/**
 * WHY this intent exists — the authoritative record that caused it.
 *
 * Two jobs. It answers "explain this message" for support, and it is the
 * dedupe key's backbone (S37): the same source producing the same type for the
 * same audience on the same channel is the same logical notification, however
 * many times an event is replayed.
 *
 * Note what is NOT a source: the private audit projection (S33, S34). A
 * projection is a read model that can be rebuilt; deriving communication from
 * it would mean a rebuild re-sends mail.
 */
export const NOTIFICATION_SOURCE_KINDS = [
  "SIGNING_ACCESS_GRANT",
  "SECURITY_CHALLENGE",
  "WORKSPACE_INVITATION",
] as const;
export type NotificationSourceKind =
  (typeof NOTIFICATION_SOURCE_KINDS)[number];

/**
 * The source reference.
 *
 * `sourceId` is a string rather than a branded union because the kinds span
 * three domains with three id types, and PostgreSQL cannot foreign-key a
 * polymorphic pair (S192). Rather than a misleading pseudo-FK, integrity comes
 * from the typed constructors in `notification-sources.ts` and from real FKs on
 * the audience columns, which cover the tenant-safety cases that matter.
 * That trade-off is documented in NOTIFICATION_ARCHITECTURE.md.
 */
export interface NotificationSource {
  readonly kind: NotificationSourceKind;
  readonly sourceId: string;
}

// ── Delivery state ───────────────────────────────────────────────────────────

/**
 * The provider-neutral transport lifecycle.
 *
 * All nine values are declared here so BACKEND-45 inherits a vocabulary rather
 * than inventing one under deadline, and so the DB CHECK constraint never has
 * to widen mid-flight. But declaring a state is not the same as producing it:
 * `producibleNow` below is the honest subset, and a test asserts BACKEND-44
 * never writes outside it (S267, S312).
 *
 * `SENT` is deliberately not a value (S117). It reads as "we sent it" while
 * meaning any of queued, handed to a provider, or actually delivered — the
 * exact ambiguity that lets a UI claim delivery it cannot support.
 */
export const NOTIFICATION_DELIVERY_STATES = [
  /** Durable work exists and nothing has claimed it. The only initial state. */
  "PENDING",
  /** A worker has claimed it. BACKEND-45 writes this; BACKEND-44 cannot. */
  "PROCESSING",
  /**
   * A provider accepted the message for delivery.
   *
   * NOT delivery, and never presentable as human receipt (S116). An SMTP 250
   * means a queue accepted bytes.
   */
  "PROVIDER_ACCEPTED",
  /** The provider affirmed delivery to the destination mailbox. */
  "DELIVERED",
  /** The destination rejected it. */
  "BOUNCED",
  /** Failed, may succeed later. Retry budget applies. */
  "FAILED_RETRYABLE",
  /** Failed, will not succeed. No further attempts. */
  "FAILED_TERMINAL",
  /**
   * Deliberately not sent, and not an error.
   *
   * The foundation's one real use: the credential a secret-bearing message
   * carries expired or was revoked before transport (S156). Sending it would
   * deliver a link that cannot work.
   */
  "SUPPRESSED",
  /** The reason for the message disappeared before transport (S111). */
  "CANCELLED",
] as const;
export type NotificationDeliveryState =
  (typeof NOTIFICATION_DELIVERY_STATES)[number];

/**
 * The states BACKEND-44 is entitled to write.
 *
 * Everything else needs a provider to have said something, and no provider
 * exists. This constant is asserted against in tests rather than left as a
 * comment, because "we would never write DELIVERED" is exactly the kind of
 * discipline that erodes once someone needs a green checkmark in a demo.
 */
export const BACKEND_44_PRODUCIBLE_DELIVERY_STATES = [
  "PENDING",
  "SUPPRESSED",
  "CANCELLED",
] as const satisfies readonly NotificationDeliveryState[];

/**
 * Why a delivery stopped, as a bounded internal code.
 *
 * Bounded because the alternative is a provider's raw response body in a
 * column (S165) — unbounded, vendor-shaped, and routinely containing the
 * recipient address it failed to reach.
 */
export const NOTIFICATION_FAILURE_CODES = [
  "SECRET_EXPIRED",
  "SECRET_REVOKED",
  "SOURCE_CANCELLED",
  "DESTINATION_INVALID",
] as const;
export type NotificationFailureCode =
  (typeof NOTIFICATION_FAILURE_CODES)[number];

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * Which body of copy renders the message, and at which revision.
 *
 * The version is frozen onto the intent at creation (S59) and never resolved
 * as "latest" at send time. A queued invitation written on Tuesday renders
 * Tuesday's wording on Thursday, even if v2 shipped on Wednesday — otherwise a
 * deployment silently rewrites the content of mail already promised, and the
 * copy a recipient received becomes unreconstructable.
 *
 * Semantic and explicit, not a Git SHA (S60): a SHA changes when a comment
 * changes and tells a reader nothing about compatibility.
 */
export interface NotificationTemplateRef {
  readonly key: NotificationTemplateKey;
  readonly version: number;
}

export const NOTIFICATION_TEMPLATE_KEYS = [
  "account-email-verification",
  "password-reset",
  "mfa-otp",
  "workspace-invitation",
  "signing-invitation",
] as const;
export type NotificationTemplateKey =
  (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

/**
 * The locale a message renders in, frozen per intent (S144).
 *
 * One value, because LAGDA ships one language. It exists as a field anyway so
 * that adding a second locale is a widened union rather than a schema
 * migration across every queued row — and so a retry can never render in a
 * different language than the first attempt.
 *
 * Never inferred from a browser header or an email domain (S142).
 */
export const NOTIFICATION_LOCALES = ["en"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

/**
 * The frozen, non-secret inputs a template renders from.
 *
 * ── Why inputs and not a rendered body ─────────────────────────────────────
 *
 * S75 offers the choice explicitly: persist the variables, or persist the
 * finished message. LAGDA persists the variables (S76).
 *
 * A rendered body is a copy of everything the message says — recipient name,
 * document title, and, for secret-bearing mail, the live credential URL — sat
 * in a column for as long as the row lives (S77, S154). Variables keep the
 * privacy surface to the few fields the copy actually needs, and let
 * BACKEND-45 format per provider without re-deriving business inputs.
 *
 * ── Why `unknown` here ─────────────────────────────────────────────────────
 *
 * The port cannot name every template's model without depending on the
 * registry that owns them. The value is validated against the template's own
 * TypeBox schema on the way in and on the way out (S63, S244), so the
 * looseness stops at this boundary rather than reaching persistence.
 */
export type NotificationTemplateInput = Readonly<Record<string, unknown>>;

// ── Secret-bearing messages ──────────────────────────────────────────────────

/**
 * A reference to a one-time secret this message must carry.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A raw OTP, reset token, verification token, invitation token or signing
 * credential may never sit in `templateInput`, in a queue payload, or in a log
 * (S78, S80, S126). Those are ordinary structures: they are dumped in support
 * tickets, replicated to analytics, and printed by a debug line somebody adds
 * at 2am.
 *
 * ── Two mechanisms, because the domains already differ ─────────────────────
 *
 * `SEALED` carries the credential itself, encrypted with the established
 * `SecretBox` — the mechanism OD-098 named and BACKEND-33 proved for signing
 * links. It exists because a link's raw token is unrecoverable from a digest
 * and the renderer runs long after the transaction that minted it.
 *
 * `CHALLENGE` carries no credential at all, only the id of the auth challenge
 * that owns one. Verification, reset and OTP flows store digests and hand the
 * raw value to their caller; BACKEND-45 will resolve it through the owning
 * domain at render time. Modelling these as `SEALED` would mean encrypting and
 * storing secrets that today are never persisted at all — a strict weakening
 * of auth's posture to gain uniformity (S102, S233).
 */
export type NotificationSecretRef =
  | {
      readonly kind: "SEALED";
      readonly sealed: SealedDeliverySecret;
      readonly keyVersion: string;
    }
  | { readonly kind: "CHALLENGE"; readonly challengeId: string };

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * A durable decision to communicate. Immutable once written (S55).
 *
 * There is no `state` field. An intent does not have a lifecycle — it either
 * exists or it does not, and the transport status of the work it spawned lives
 * on the delivery (S54, S118). One mutable enum spanning both is how "the
 * email bounced" ends up meaning "the notification was never intended".
 */
export interface NotificationIntentRecord {
  readonly notificationIntentId: NotificationIntentId;
  readonly scope: NotificationScope;
  readonly notificationType: NotificationType;
  readonly source: NotificationSource;
  readonly audience: NotificationAudience;
  readonly template: NotificationTemplateRef;
  readonly locale: NotificationLocale;
  readonly templateInput: NotificationTemplateInput;
  /** Absent for ordinary messages. Present only where copy carries a secret. */
  readonly secretRef?: NotificationSecretRef;
  readonly createdAt: number;
}

/**
 * The channel-specific work one intent requires. Mutable, operationally (S56).
 *
 * `destination` is a snapshot, frozen at creation from the authoritative
 * identity for the source operation (S22, S28). It is never re-read from a
 * Contact or a User profile at send time: a queued invitation addressed to
 * alice@example.com must not follow an unrelated profile edit to
 * changed@example.com hours later (S29) — that is a redirect of a
 * security-bearing message triggered by an unrelated write.
 */
export interface NotificationDeliveryRecord {
  readonly notificationDeliveryId: NotificationDeliveryId;
  readonly notificationIntentId: NotificationIntentId;
  readonly channel: NotificationChannel;
  /** PII. Never logged (S26, S281), never a metric label (S282). */
  readonly destination: string;
  readonly state: NotificationDeliveryState;
  readonly failureCode?: NotificationFailureCode;
  readonly createdAt: number;
}

/**
 * What makes two notification requests the same logical notification (S37).
 *
 * Source identity carries the generation. A second OTP challenge has a new
 * `ChallengeId`, so it is naturally a new notification (S140); a replayed event
 * for the same grant is not (S39). That is why the key does not include a
 * timestamp or an attempt counter — those would make every retry unique and
 * defeat the constraint entirely, while a key too broad would block the
 * legitimate repeats S138 requires.
 */
export interface NotificationLogicalKey {
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  readonly notificationType: NotificationType;
  readonly channel: NotificationChannel;
}

// ── Repository ───────────────────────────────────────────────────────────────

/**
 * Everything one notification needs to be written.
 *
 * Identity and time come from the CALLER, matching every other repository in
 * LAGDA: ids are minted by an application-layer generator and the clock is a
 * port, so a repository stays a pure translation of a decision already made.
 * A repository that minted its own ids would also be a repository that could
 * not be replayed deterministically in a test.
 */
export interface NewNotificationIntent {
  readonly notificationIntentId: NotificationIntentId;
  readonly notificationDeliveryId: NotificationDeliveryId;
  readonly createdAt: number;
  readonly scope: NotificationScope;
  readonly notificationType: NotificationType;
  readonly source: NotificationSource;
  readonly audience: NotificationAudience;
  readonly template: NotificationTemplateRef;
  readonly locale: NotificationLocale;
  readonly templateInput: NotificationTemplateInput;
  readonly secretRef?: NotificationSecretRef;
  readonly channel: NotificationChannel;
  readonly destination: string;
}

/**
 * What `createIfAbsent` did.
 *
 * The caller is told which of the two happened rather than left to infer it
 * from a row count, because the difference decides whether queue work should
 * be enqueued: creating an intent means there is transport to schedule, and
 * finding an existing one means somebody already scheduled it (S36).
 */
export interface NotificationCreationResult {
  readonly outcome: "CREATED" | "ALREADY_EXISTS";
  readonly intent: NotificationIntentRecord;
  readonly delivery: NotificationDeliveryRecord;
}

/**
 * Semantic persistence for notifications. No generic CRUD (S202).
 *
 * Every method takes the business transaction as its final parameter, matching
 * the one transaction style the architecture settled on. That is what makes
 * S98 achievable: the intent commits with the fact that justified it, or
 * neither does.
 */
export interface NotificationRepository {
  /**
   * Creates intent + PENDING delivery, or returns the existing pair.
   *
   * Idempotent on `NotificationLogicalKey`, and idempotent under CONCURRENCY —
   * two workers racing on the same replayed event must converge on one intent
   * (S240). That is enforced by a unique constraint and an `ON CONFLICT`, not
   * by a read-then-write, which is exactly the pattern that produces two rows
   * under load and passes every single-threaded test.
   */
  createIfAbsent(
    intent: NewNotificationIntent,
    transaction: unknown,
  ): Promise<NotificationCreationResult>;

  findIntentById(
    notificationIntentId: NotificationIntentId,
    transaction?: unknown,
  ): Promise<NotificationIntentRecord | null>;

  findDeliveryById(
    notificationDeliveryId: NotificationDeliveryId,
    transaction?: unknown,
  ): Promise<NotificationDeliveryRecord | null>;

  /**
   * PENDING deliveries older than `olderThan`, oldest first.
   *
   * The reconciliation query (S132). An enqueue that was lost — a crash
   * between commit and queue insert, a queue truncated by an operator — leaves
   * a durable row nothing will ever pick up, and without this the message is
   * simply never sent and nothing reports it (S131).
   */
  findPendingDeliveries(
    olderThan: number,
    limit: number,
    transaction?: unknown,
  ): Promise<readonly NotificationDeliveryRecord[]>;

  /**
   * Moves a PENDING delivery to CANCELLED or SUPPRESSED. Returns false if it
   * was not PENDING.
   *
   * Deliberately not a `setState` (S56, S112). The two reachable terminal
   * states are named in the signature, so the method cannot be repurposed to
   * write `DELIVERED` the day somebody wants a green tick.
   *
   * It cannot un-send anything (S113). Once a provider has the message the
   * only real control is invalidating the credential it carries, which belongs
   * to the owning security domain (S114).
   */
  stopPendingDelivery(
    notificationDeliveryId: NotificationDeliveryId,
    state: "CANCELLED" | "SUPPRESSED",
    failureCode: NotificationFailureCode,
    transaction: unknown,
  ): Promise<boolean>;
}

// ── The provider seam ────────────────────────────────────────────────────────

/**
 * A rendered message, in LAGDA's own vocabulary.
 *
 * No provider type appears here and none may (S90, S217). The adapter
 * BACKEND-45 writes converts this into whatever shape its vendor wants; if the
 * vendor's request object reached the application layer, swapping providers
 * would become a refactor of the notification domain rather than a new file.
 */
export interface EmailMessage {
  readonly destination: string;
  readonly subject: string;
  readonly textBody: string;
  /** Optional: not every template needs an HTML part (S69). */
  readonly htmlBody?: string;
}

/**
 * The transport port. Declared here, implemented by nobody yet.
 *
 * ── Why it is empty of behaviour ───────────────────────────────────────────
 *
 * BACKEND-44 must not select a provider, and must not fake one (S212, S213). A
 * console transport that logs a message and marks the delivery successful
 * would satisfy a demo and lie in exactly the way this entire command exists
 * to prevent — and would print a secret-bearing URL to stdout while doing it.
 *
 * So the seam exists, the substrate fills PENDING rows behind it, and nothing
 * is wired. BACKEND-45 provides the implementation and the delivery states
 * that only a real provider can honestly produce.
 */
export interface EmailDeliveryProvider {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/**
 * A transport outcome, in LAGDA-owned terms.
 *
 * Retry classification is LAGDA's, not the vendor's (S218): providers disagree
 * about which failures are transient, and binding to one taxonomy makes the
 * next provider's error codes a domain change. `providerMessageReference` is
 * opaque operational metadata — never evidence (S120), never a receipt.
 */
export type EmailDeliveryResult =
  | { readonly outcome: "ACCEPTED"; readonly providerMessageReference?: string }
  | { readonly outcome: "FAILED_RETRYABLE" }
  | { readonly outcome: "FAILED_TERMINAL" };

// ── Claiming and attempts (BACKEND-45) ───────────────────────────────────────

export type NotificationDeliveryAttemptId = string & {
  readonly __brand: "NotificationDeliveryAttemptId";
};

export interface NotificationDeliveryAttemptIdGenerator {
  nextNotificationDeliveryAttemptId(): NotificationDeliveryAttemptId;
}

/**
 * What one transport attempt concluded. Mirrors the core vocabulary.
 *
 * Re-declared here rather than imported from `@lagda/core` because a port must
 * not force every adapter to depend on the domain package to name a value it
 * persists. A test asserts the two lists cannot drift.
 */
export const ATTEMPT_OUTCOMES = [
  "ACCEPTED", "RETRYABLE", "TERMINAL", "AMBIGUOUS",
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Why an attempt failed. Bounded; never a provider's response body (S17). */
export const ATTEMPT_FAILURE_CODES = [
  "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE",
  "PROVIDER_REJECTED", "DESTINATION_INVALID", "CONFIGURATION_INVALID",
  "CONNECTION_LOST",
] as const;
export type AttemptFailureCode = (typeof ATTEMPT_FAILURE_CODES)[number];

export interface NotificationDeliveryAttemptRecord {
  readonly notificationDeliveryAttemptId: NotificationDeliveryAttemptId;
  readonly notificationDeliveryId: NotificationDeliveryId;
  readonly attemptNumber: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly outcome?: AttemptOutcome;
  readonly failureCode?: AttemptFailureCode;
  /** Provider-neutral operational metadata. Never evidence (S11). */
  readonly providerMessageReference?: string;
}

/** A delivery a worker now holds a lease on, with everything a send needs. */
export interface ClaimedDelivery {
  readonly delivery: NotificationDeliveryRecord;
  readonly intent: NotificationIntentRecord;
  readonly attempt: NotificationDeliveryAttemptRecord;
}

export interface ClaimDeliveryInput {
  readonly notificationDeliveryId: NotificationDeliveryId;
  readonly attemptId: NotificationDeliveryAttemptId;
  readonly now: number;
  /** How long the lease lasts. A dead worker's row is reclaimable after it. */
  readonly leaseMs: number;
}

export interface CompleteAttemptInput {
  readonly notificationDeliveryId: NotificationDeliveryId;
  readonly attemptId: NotificationDeliveryAttemptId;
  readonly outcome: AttemptOutcome;
  readonly failureCode?: AttemptFailureCode;
  readonly providerMessageReference?: string;
  /** The state the outcome implies, decided by the domain, not the adapter. */
  readonly nextState: NotificationDeliveryState;
  /** When this delivery may be tried again. Absent for terminal outcomes. */
  readonly nextAttemptAt?: number;
  readonly now: number;
}

/**
 * Claiming, attempts, and lease recovery.
 *
 * Separated from `NotificationRepository` because these exist only once a
 * provider does. Keeping them apart means BACKEND-44's substrate does not grow
 * methods nothing can call, and a reader can see which half of the system a
 * given capability belongs to.
 */
export interface NotificationTransportRepository {
  /**
   * Atomically takes a lease on one delivery and opens an attempt.
   *
   * Returns null when the row was not claimable — already claimed, already
   * terminal, cancelled, suppressed, or not yet due. Null rather than a throw
   * because at-least-once queue delivery makes losing a claim race the ordinary
   * case, not a defect (S66, S67).
   *
   * The claim and the attempt row are written together (S70), so a provider
   * call can never happen without a durable record that it was about to.
   */
  claimForDelivery(
    input: ClaimDeliveryInput,
    transaction: unknown,
  ): Promise<ClaimedDelivery | null>;

  /**
   * Closes the attempt and moves the delivery, in one statement each.
   *
   * Called AFTER the provider call and in its own short transaction — the
   * network call must never happen inside a held transaction (S71, S73).
   */
  completeAttempt(
    input: CompleteAttemptInput,
    transaction: unknown,
  ): Promise<boolean>;

  /**
   * Returns leases that expired without completing, so their deliveries can be
   * retried.
   *
   * This is the worker-crash path (S109): a process that dies between claiming
   * and completing leaves a row in PROCESSING that no queue job will revisit.
   * The lease is what makes that recoverable without a human.
   */
  reclaimExpiredLeases(
    now: number,
    limit: number,
    transaction: unknown,
  ): Promise<readonly NotificationDeliveryId[]>;

  listAttempts(
    notificationDeliveryId: NotificationDeliveryId,
    transaction?: unknown,
  ): Promise<readonly NotificationDeliveryAttemptRecord[]>;
}
