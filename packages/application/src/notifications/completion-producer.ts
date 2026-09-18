// Turning a completed signing request into a notification.
//
// ── Why this is a producer and not a call in the sealing step ─────────────
//
// The same reason `invitation-producer.ts` exists (S96): once
// `sendEmail(...)` appears inside the finalization transaction, the answer to
// "what does LAGDA send when a request completes?" becomes a grep, and a copy
// change means editing the transaction that seals legal documents.
//
// So `final-seal.ts` names a business reason and hands over identifiers. It
// does not assemble a message, does not know the template key, and does not
// know an email is involved.
//
// ── Inside the finalization transaction, on purpose ───────────────────────
//
// It takes the transaction and the repositories rather than opening its own.
// That is what makes the required boundary hold in BOTH directions, which is
// the whole reason this file is shaped the way it is:
//
//   A notification can never exist for a completion that rolled back,
//   because the intent is written by the same transaction that writes the
//   completion, the seal, the evidence and the `completed` state. If
//   `markCompleted` refuses, the intent goes with it.
//
//   A committed completion can never lose its notification to a provider
//   outage, because this writes an INTENT, not an email. Nothing here touches
//   a network (S99). Transport is a separate, retried, bounded process that
//   reads the committed row — so a provider that is down when the document
//   seals changes nothing about whether the message is owed.
//
// ── Duplicate suppression is the database's job, not this file's ──────────
//
// There is no `if (!existing)` here, and there must not be: a read-then-insert
// is two statements with a window between them, and two concurrent completion
// runs for one request would both read "absent" and both insert.
//
// Instead `createIfAbsent` is an insert-on-conflict-do-nothing against
// `notification_intents_logical_key`, the UNIQUE index on
// (source_kind, source_id, notification_type) from migration 030. With
// `sourceKind: "SIGNING_REQUEST"` and `sourceId` the request id, a second
// insert for the same request is refused by the index itself — under any
// interleaving, including two workers on two machines. The retry path added in
// Phase 1 makes this load-bearing rather than theoretical: a run that fails
// after this insert commits will be re-driven, and the re-drive must not
// produce a second email.

import type {
  NotificationRepository, ActorProfileRepository, ScopedWorkspaceRepository,
  Clock,
} from "../common/ports/index.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type { SigningRequestId } from "../common/ports/signing-requests.js";
import type { NotificationTemplateRegistry } from "./template-registry.js";
import { createNotificationIntent } from "./create-intent.js";

/** Shown when the sender's profile can no longer be read. */
const UNKNOWN_SENDER = "there";
/** Shown when the workspace row is unreadable. Should not happen; not fatal. */
const UNKNOWN_WORKSPACE = "your LAGDA workspace";
/** Shown when the request's frozen title is empty. Should not happen. */
const UNTITLED_DOCUMENT = "Untitled document";

/**
 * The template model's own bounds, mirrored here so a value that exceeds one
 * is CLAMPED rather than rejected.
 *
 * This matters more than it looks. `createNotificationIntent` validates the
 * model before inserting, and it is called inside the finalization
 * transaction — so a title one character over the schema's limit would throw,
 * roll back the seal, and fail the completion on every retry. A document's
 * title is workspace-supplied content; it must not be able to prevent its own
 * document from completing.
 *
 * Truncation is safe for the same reason it would be wrong elsewhere: this is
 * display copy in an email, not the authoritative record. The untruncated
 * title stays on the request, the artifact and the evidence chain.
 */
const MAX_TITLE = 300;
const MAX_DISPLAY_NAME = 200;
const MAX_SIGNERS = 1000;

/** Clamps to the schema's bounds, substituting a fallback for an empty value. */
function bounded(value: string | null, fallback: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface CompletionProducerDependencies {
  readonly templates: NotificationTemplateRegistry;
  readonly ids: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly clock: Clock;
}

export interface CompletionNotificationInput {
  readonly signingRequestId: SigningRequestId;
  readonly workspaceId: WorkspaceId;
  /** `signing_requests.created_by_user_id` — the sender, and the audience. */
  readonly senderUserId: UserId;
  /**
   * The sender's account address, resolved by the caller OUTSIDE this
   * transaction (S22).
   *
   * A parameter rather than something read here, for two separate reasons.
   *
   * First, `users` is a global table with no tenant, and this runs in a
   * workspace transaction. Reading it here would mean a workspace-scoped unit
   * of work reaching across into account data.
   *
   * Second, the snapshot rule: whichever identity is authoritative for an
   * operation is frozen onto the intent by the caller who knows which that is.
   * For a completion the authoritative identity is the SENDER'S ACCOUNT — not
   * a `SigningRequestRecipient` (those are the counterparties, and one of them
   * sharing the sender's address must not redirect this message), and not a
   * Contact.
   */
  readonly senderEmail: string;
  /** The request's own frozen title, not the document's current one. */
  readonly documentTitle: string;
  /** How many participants completed. Rendered as a count, never as a roster. */
  readonly signerCount: number;
}

export function createCompletionNotificationProducer(
  deps: CompletionProducerDependencies,
) {
  return async (
    input: CompletionNotificationInput,
    repositories: {
      readonly notifications: NotificationRepository;
      readonly workspaces: ScopedWorkspaceRepository;
      readonly actorProfiles: ActorProfileRepository;
    },
    transaction: unknown,
  ): Promise<void> => {
    // A completion with no certified participant is a data anomaly, not a
    // message. Skipping is the honest answer: the schema's minimum is 1, and
    // clamping up to 1 would state a falsehood in the body ("completed by 1
    // signer") to satisfy a validator.
    if (!Number.isInteger(input.signerCount) || input.signerCount < 1) return;

    // Both reads are in the caller's transaction, so the names frozen onto the
    // intent are the ones true at the instant the request completed.
    const [workspace, sender] = await Promise.all([
      repositories.workspaces.find(),
      repositories.actorProfiles.displayNameOf(input.senderUserId),
    ]);

    await createNotificationIntent({
      notifications: repositories.notifications,
      templates: deps.templates,
      ids: deps.ids,
      clock: deps.clock,
    })({
      notificationType: "SIGNING_COMPLETED",
      // The REQUEST is the source. One request completes once, so this is the
      // key the unique index dedupes on.
      sourceId: input.signingRequestId,
      scope: { kind: "WORKSPACE", workspaceId: input.workspaceId },
      // The sender's ACCOUNT, as an identity rather than an address (S21).
      audience: { kind: "USER", userId: input.senderUserId },
      destination: input.senderEmail,
      templateInput: {
        recipientName: bounded(sender, UNKNOWN_SENDER, MAX_DISPLAY_NAME),
        documentTitle: bounded(
          input.documentTitle, UNTITLED_DOCUMENT, MAX_TITLE),
        workspaceName: bounded(
          workspace?.name ?? null, UNKNOWN_WORKSPACE, MAX_DISPLAY_NAME),
        signerCount: Math.min(input.signerCount, MAX_SIGNERS),
      },
      // No `secretRef`. Nothing in this message is a credential: the sender
      // already has an account and authorised access to the document, so the
      // body links to the ordinary signed-in app. Passing one would be
      // rejected by the policy check in `createNotificationIntent`.
    }, transaction);
  };
}
