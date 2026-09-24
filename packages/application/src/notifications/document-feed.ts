// The in-app DOCUMENT notification feed.
//
// ── Why this is not the email notification substrate ───────────────────────
//
// Everything else in this directory exists to SEND EMAIL: intents, deliveries,
// templates, providers. `/me/notifications` reads that substrate back, which
// makes it a feed of "messages we tried to email you" — and since a signing
// invitation is addressed to a RECIPIENT and a workspace invitation to an
// INVITEE, a workspace member's own feed contains almost nothing. No status
// transition produces a row there at all.
//
// This module answers a different question: what has HAPPENED to this
// workspace's documents. It reads EVIDENCE, which is the record every signing
// transition already writes, and projects it. Nothing new is written, and no
// second source of truth is created — the notification is a VIEW of the
// evidence, so it cannot drift from what actually occurred.
//
// ── Why evidence, and what that bounds this to ─────────────────────────────
//
// Every evidence row carries a `signingRequestId` by construction, so this
// feed is document activity and nothing else. Workspace membership changes,
// billing and integrations have no evidence and therefore no notifications
// here — correctly, rather than by inventing a record for them.

import type { WorkspaceId } from "@lagda/contracts";
import { authorize } from "../signing-requests/signing-requests.js";
import type {
  TransactionManager, EvidenceEventRecord, EvidenceEventType,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";

/**
 * How much evidence to read before filtering.
 *
 * Read wide, present narrow: most evidence is not notifiable (a viewed page,
 * a consent, four pipeline steps per completion), so reading only as many
 * rows as the feed shows would return a feed of almost nothing on a busy
 * workspace. This is the read bound; `DEFAULT_FEED_LIMIT` is what comes back.
 */
const EVIDENCE_SCAN_LIMIT = 400;

/** How many notifications a feed returns when the caller names no limit. */
export const DEFAULT_FEED_LIMIT = 50;
export const MAX_FEED_LIMIT = 100;

/**
 * Which events are worth telling somebody about.
 *
 * NARROWER than the audit timeline on purpose. `EVENT_VISIBILITY` decides
 * what belongs in a document's own history, where "recipient entered the
 * ceremony" and "recipient accepted consent" are genuinely useful. A
 * notification is an interruption, and interrupting a sender for every page
 * view is how a feed becomes something people stop reading.
 *
 * So this is the set of STATUS CHANGES: the request moved, or a participant
 * reached an outcome. `transaction-created` is excluded because the person
 * who would be notified is the person who just did it.
 */
const NOTIFIABLE: ReadonlySet<EvidenceEventType> = new Set<EvidenceEventType>([
  "transaction-sent",
  "transaction-cancelled",
  "transaction-expired",
  "transaction-completed",
  // Whose turn it now is — what "I must sign" is built on.
  "recipient-activated",
  "signature-completed",
  "participant-declined",
  // 069's two approver outcomes, as notifiable as a signer's.
  "approval-completed",
  "participant-skipped",
]);

/**
 * How each notifiable event reads, and how loudly.
 *
 * A total map, so adding an event type to `NOTIFIABLE` without deciding how
 * it presents is a compile error rather than a notification that says
 * "Notification".
 */
type Severity = "info" | "success" | "warning" | "critical";

interface Presentation {
  readonly title: string;
  readonly severity: Severity;
  /** Whether the reader is expected to DO something, not merely know it. */
  readonly actionRequired: boolean;
}

const PRESENTATION: Readonly<Record<string, Presentation>> = Object.freeze({
  "transaction-sent": {
    title: "Sent for signing", severity: "info", actionRequired: false,
  },
  "transaction-cancelled": {
    title: "Signing request cancelled", severity: "warning", actionRequired: false,
  },
  "transaction-expired": {
    title: "Signing request expired", severity: "warning", actionRequired: true,
  },
  "transaction-completed": {
    title: "Fully signed", severity: "success", actionRequired: false,
  },
  "recipient-activated": {
    title: "Waiting on a participant", severity: "info", actionRequired: true,
  },
  "signature-completed": {
    title: "Participant signed", severity: "success", actionRequired: false,
  },
  "participant-declined": {
    // The one outcome that ends the request for everybody.
    title: "Participant declined", severity: "critical", actionRequired: true,
  },
  "approval-completed": {
    title: "Participant approved", severity: "success", actionRequired: false,
  },
  "participant-skipped": {
    title: "Participant skipped approval", severity: "info", actionRequired: false,
  },
});

export interface DocumentNotificationView {
  /** The evidence event's own id. Stable, so read state can key on it. */
  readonly id: string;
  readonly type: EvidenceEventType;
  readonly title: string;
  /** One sentence naming the document, and the participant where there is one. */
  readonly body: string;
  readonly severity: Severity;
  readonly actionRequired: boolean;
  readonly signingRequestId: string;
  readonly documentTitle: string;
  /** The participant this is about, where the event has one. */
  readonly recipientName: string | null;
  readonly occurredAt: number;
}

export interface DocumentNotificationFeedDependencies {
  readonly transactions: TransactionManager;
}

export interface GetDocumentNotificationsInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly limit?: number;
}

/**
 * This workspace's recent document activity, for an authorized reader.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 *
 * `signing-request.view`, the same capability the audit trail uses and for
 * the same reason: everything here is derived from evidence that a holder of
 * that capability can already read, request by request. This discloses no
 * fact they could not already reach — it only saves them opening each one.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 *
 * Reading a feed appends nothing. There is no read/unread column behind
 * this: the client tracks that itself, keyed on the evidence event id.
 */
export async function getDocumentNotifications(
  input: GetDocumentNotificationsInput,
  deps: DocumentNotificationFeedDependencies,
): Promise<readonly DocumentNotificationView[]> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_FEED_LIMIT, 1), MAX_FEED_LIMIT);

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.view");

    const events = await uow.evidence.listRecentForWorkspace(EVIDENCE_SCAN_LIMIT);
    const notifiable = events.filter(event => NOTIFIABLE.has(event.eventType));
    if (notifiable.length === 0) return [];

    // The requests these events belong to, read once each rather than per
    // event: a busy workspace produces many events against few requests.
    const requestIds = [...new Set(notifiable.map(event => String(event.signingRequestId)))];
    const titles = new Map<string, string>();
    const names = new Map<string, string>();

    for (const requestId of requestIds) {
      const typedId = requestId as unknown as Parameters<typeof uow.signingRequests.find>[0];
      const request = await uow.signingRequests.find(typedId);
      // Skip rather than throw: evidence outlives nothing here, but a request
      // that cannot be read is a request this reader should not be told about.
      if (request === null) continue;
      titles.set(requestId, request.documentTitle);

      // The IMMUTABLE snapshot names, for the same reason the audit trail
      // uses them: a contact renamed later must not rewrite who acted.
      const recipients = await uow.signingRequests.listRecipients(typedId);
      for (const recipient of recipients) {
        names.set(String(recipient.recipientId), recipient.name);
      }
    }

    return notifiable
      .filter(event => titles.has(String(event.signingRequestId)))
      .slice(0, limit)
      .map(event => present(event, titles, names));
  });
}

function present(
  event: EvidenceEventRecord,
  titles: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, string>,
): DocumentNotificationView {
  const requestId = String(event.signingRequestId);
  const documentTitle = titles.get(requestId) ?? "A document";
  const recipientName = event.recipientId === undefined
    ? null
    : names.get(String(event.recipientId)) ?? null;

  // Non-null: every member of `NOTIFIABLE` has an entry, and nothing else
  // reaches here.
  const shape = PRESENTATION[event.eventType]!;

  return {
    id: String(event.evidenceEventId),
    type: event.eventType,
    title: shape.title,
    body: recipientName === null
      ? `"${documentTitle}"`
      : `${recipientName} — "${documentTitle}"`,
    severity: shape.severity,
    actionRequired: shape.actionRequired,
    signingRequestId: requestId,
    documentTitle,
    recipientName,
    occurredAt: event.occurredAt,
  };
}

/**
 * Exported so a test can assert every notifiable type has a presentation. A
 * missing one would otherwise surface on a reader's screen rather than in CI.
 */
export const NOTIFIABLE_EVENT_TYPES: readonly EvidenceEventType[] = [...NOTIFIABLE];
