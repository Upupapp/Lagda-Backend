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

import type { UserId, WorkspaceId } from "@lagda/contracts";
import { authorize } from "../signing-requests/signing-requests.js";
import { normalizeEmail } from "../auth/email-identity.js";
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

/**
 * Who a feed is FOR (071).
 *
 * `mine` — requests this reader sent, or is a participant on. What a person
 * means by "my notifications", and the default.
 *
 * `workspace` — every request in the workspace the reader may view. The
 * original #52 behaviour, kept for a manager who does want the whole picture.
 *
 * `mine` is a NARROWING filter, never a widening one: both scopes sit behind
 * the same `signing-request.view` check, and `mine` only removes rows. It
 * therefore discloses nothing `workspace` would not.
 */
export const DOCUMENT_FEED_SCOPES = ["mine", "workspace"] as const;
export type DocumentFeedScope = (typeof DOCUMENT_FEED_SCOPES)[number];
export const DEFAULT_FEED_SCOPE: DocumentFeedScope = "mine";

/**
 * Which of two events at the SAME instant better describes where a request
 * now stands.
 *
 * Needed because the evidence order breaks a timestamp tie by event id, and
 * an id says nothing about meaning. One send writes `transaction-sent` and the
 * first `recipient-activated` together; one signature writes
 * `signature-completed` and the next `recipient-activated` together. Picked
 * by id, a document waiting on its second signer could read "Participant
 * signed" — true, and not the thing the reader needs to know.
 *
 * Terminal outcomes rank highest (nothing follows them), then "whose turn it
 * is", then a participant's own act, then the send.
 */
const PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  "transaction-completed": 3,
  "transaction-cancelled": 3,
  "transaction-expired": 3,
  "participant-declined": 3,
  "recipient-activated": 2,
  "signature-completed": 1,
  "approval-completed": 1,
  "participant-skipped": 1,
  "transaction-sent": 0,
});

function rank(event: EvidenceEventRecord): number {
  return PRECEDENCE[event.eventType] ?? 0;
}

/** Newer first; at the same instant, the more decisive event first; then id,
 *  so the order is total and a feed does not reshuffle between reads. */
function newerFirst(a: EvidenceEventRecord, b: EvidenceEventRecord): number {
  return b.occurredAt - a.occurredAt
    || rank(b) - rank(a)
    || String(b.evidenceEventId).localeCompare(String(a.evidenceEventId));
}

/**
 * ONE row per request: its current state, not its history.
 *
 * #52 returned one row per event, and a single completed document produces
 * four or more of them (sent, activated, signed, completed) — three documents
 * read as sixteen notifications. The history belongs to the audit trail; the
 * feed answers "what is the state of my documents".
 *
 * Because the row is the request's LATEST event, a new transition produces a
 * new row id — and a new row id is unread. So a document the reader already
 * dismissed comes back exactly when something new happens to it.
 */
function latestPerRequest(
  events: readonly EvidenceEventRecord[],
): EvidenceEventRecord[] {
  const latest = new Map<string, EvidenceEventRecord>();
  for (const event of events) {
    const key = String(event.signingRequestId);
    const current = latest.get(key);
    if (current === undefined || newerFirst(event, current) < 0) {
      latest.set(key, event);
    }
  }
  return [...latest.values()].sort(newerFirst);
}

export interface DocumentNotificationView {
  /** The request's LATEST notifiable evidence event. Stable until something
   *  new happens to the request, which is what read state keys on. */
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
  /** 071. Whether THIS reader has marked this row read. */
  readonly read: boolean;
  /** 071. Whether THIS reader has dismissed this row. The row is still
   *  returned — a client shows dismissed rows in their own view, and must be
   *  able to restore them. */
  readonly dismissed: boolean;
}

export interface DocumentNotificationFeedDependencies {
  readonly transactions: TransactionManager;
  /**
   * The reader's OWN account email, looked up by their own session user id.
   *
   * Resolved BEFORE the tenant transaction and passed in, never read inside
   * it: `WorkspaceUnitOfWork.actorProfiles` records why account data stays
   * out of a workspace unit of work. It is used for one thing — to recognise
   * the reader among a request's participants — and never returned.
   *
   * Null when it cannot be resolved; `mine` then means "requests I sent".
   */
  readonly accountEmailOf: (userId: UserId) => Promise<string | null>;
}

export interface GetDocumentNotificationsInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly limit?: number;
  readonly scope?: DocumentFeedScope;
}

/** A normalized address, or null — never a raw one that silently fails to
 *  match. Recipients are keyed with the same rule (`RecipientEmailKey`). */
async function readerEmail(
  input: GetDocumentNotificationsInput,
  deps: DocumentNotificationFeedDependencies,
): Promise<string | null> {
  const raw = await deps.accountEmailOf(input.actor.userId);
  if (raw === null) return null;
  const normalized = normalizeEmail(raw);
  return normalized.outcome === "ok" ? normalized.normalized : null;
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
 * ── Read state (071) ─────────────────────────────────────────────────────
 *
 * Reading a feed writes nothing. Each row carries `read` and `dismissed`,
 * looked up from the reader's own state; changing it happens through
 * `setDocumentNotificationState`.
 */
export async function getDocumentNotifications(
  input: GetDocumentNotificationsInput,
  deps: DocumentNotificationFeedDependencies,
): Promise<readonly DocumentNotificationView[]> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_FEED_LIMIT, 1), MAX_FEED_LIMIT);
  const scope = input.scope ?? DEFAULT_FEED_SCOPE;
  // Only `mine` needs it, so `workspace` does not pay for the lookup.
  const email = scope === "mine" ? await readerEmail(input, deps) : null;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.view");

    const events = await uow.evidence.listRecentForWorkspace(EVIDENCE_SCAN_LIMIT);
    const representatives = latestPerRequest(
      events.filter(event => NOTIFIABLE.has(event.eventType)));
    if (representatives.length === 0) return [];

    const titles = new Map<string, string>();
    const names = new Map<string, string>();
    const kept: EvidenceEventRecord[] = [];

    for (const event of representatives) {
      // Enough to fill the page. Reading past it would cost a request read
      // per document for rows nobody will be shown.
      if (kept.length >= limit) break;

      const requestId = String(event.signingRequestId);
      const typedId = requestId as unknown as Parameters<typeof uow.signingRequests.find>[0];
      const request = await uow.signingRequests.find(typedId);
      // Skip rather than throw: a request that cannot be read is a request
      // this reader should not be told about.
      if (request === null) continue;

      // The IMMUTABLE snapshot names, for the same reason the audit trail
      // uses them: a contact renamed later must not rewrite who acted.
      const recipients = await uow.signingRequests.listRecipients(typedId);

      if (scope === "mine") {
        const sentByReader = request.createdByUserId === input.actor.userId;
        const readerParticipates = email !== null
          && recipients.some(recipient => recipient.normalizedEmail === email);
        if (!sentByReader && !readerParticipates) continue;
      }

      titles.set(requestId, request.documentTitle);
      for (const recipient of recipients) {
        names.set(String(recipient.recipientId), recipient.name);
      }
      kept.push(event);
    }

    const states = await uow.notificationStates.listStates(
      input.actor.userId, kept.map(event => String(event.evidenceEventId)));

    return kept.map(event => present(event, titles, names, states));
  });
}

/** One call changes at most a feed's worth — the most any honest client holds. */
export const MAX_STATE_CHANGE_IDS = MAX_FEED_LIMIT;

export interface SetDocumentNotificationStateDependencies {
  readonly transactions: TransactionManager;
}

export interface SetDocumentNotificationStateInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  /** Feed row ids. Ids that are not real events in this workspace are
   *  skipped, not refused — see the repository. */
  readonly ids: readonly string[];
  /** Absent leaves read state alone. `true` marks read, `false` unread. */
  readonly read?: boolean;
  /** Absent leaves dismissal alone. `true` dismisses, `false` restores. */
  readonly dismissed?: boolean;
}

export type SetDocumentNotificationStateResult =
  | { readonly outcome: "updated"; readonly updated: number }
  /** Neither `read` nor `dismissed` was given: nothing to change. */
  | { readonly outcome: "empty-change" };

/**
 * Changes this reader's own state on feed rows (071): mark read or unread,
 * dismiss or restore — the four acts the notification UI offers, all of
 * which used to last one page load.
 *
 * Behind the same capability as the feed itself: a reader can only change
 * rows they can see. The user id is the session's — there is no way to name
 * another member — so one member's reading cannot change another's badge.
 */
export async function setDocumentNotificationState(
  input: SetDocumentNotificationStateInput,
  deps: SetDocumentNotificationStateDependencies,
): Promise<SetDocumentNotificationStateResult> {
  if (input.read === undefined && input.dismissed === undefined) {
    return { outcome: "empty-change" };
  }
  const change = {
    ...(input.read === undefined ? {} : { read: input.read }),
    ...(input.dismissed === undefined ? {} : { dismissed: input.dismissed }),
  };
  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.view");
    const updated = await uow.notificationStates.setState(
      input.actor.userId, input.ids.slice(0, MAX_STATE_CHANGE_IDS), change);
    return { outcome: "updated", updated };
  });
}

function present(
  event: EvidenceEventRecord,
  titles: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, string>,
  states: ReadonlyMap<string, { readonly read: boolean; readonly dismissed: boolean }>,
): DocumentNotificationView {
  const id = String(event.evidenceEventId);
  const requestId = String(event.signingRequestId);
  const documentTitle = titles.get(requestId) ?? "A document";
  const recipientName = event.recipientId === undefined
    ? null
    : names.get(String(event.recipientId)) ?? null;

  // Non-null: every member of `NOTIFIABLE` has an entry, and nothing else
  // reaches here.
  const shape = PRESENTATION[event.eventType]!;

  return {
    id,
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
    read: states.get(id)?.read ?? false,
    dismissed: states.get(id)?.dismissed ?? false,
  };
}

/**
 * Exported so a test can assert every notifiable type has a presentation. A
 * missing one would otherwise surface on a reader's screen rather than in CI.
 */
export const NOTIFIABLE_EVENT_TYPES: readonly EvidenceEventType[] = [...NOTIFIABLE];
