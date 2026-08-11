// The private signing audit trail (BACKEND-43 §76–§95).
//
// ── What this is a projection OF ───────────────────────────────────────────
//
// Authoritative evidence events, and nothing else. Not Pino logs (§9, §137,
// §286 — no code path here reads one, and none could: logs are not injected
// into this module). Not current workflow state, which says where the workflow
// IS and cannot say what happened on the way (§4). Not the public verification
// projection, which is a different, deliberately smaller shape for a caller
// holding no credential at all (§6, §109).
//
// ── Computed at read time ──────────────────────────────────────────────────
//
// §164. One request's history is bounded — a handful of events per recipient
// plus four for completion — so the events are read, joined to the immutable
// recipient snapshot, and mapped. There is no materialized projection to keep
// in step with the events, and therefore no way for the two to disagree.
//
// ── The wording lives HERE, not in the row ─────────────────────────────────
//
// §13, §79, §81. Events store a machine type and a version; the sentence a
// person reads is produced by this presenter. Storing English would make the
// historical record depend on a copy decision and would not survive a
// rewording — and a legal record whose meaning changes when marketing edits a
// string is not a record.

import type {
  EvidenceEventRecord, EvidenceEventType, SigningRequestRecipientId,
  WorkspaceUnitOfWork, SigningRequestId,
} from "../common/ports/index.js";
import type { WorkspaceId } from "@lagda/contracts";
import type { AuthenticatedActor } from "../common/ports/session.js";
// The SAME authorization helper the signing-request use cases use, not a copy:
// it reads membership inside the transaction so a demotion mid-request cannot
// commit under authority just lost.
import { authorize } from "../signing-requests/signing-requests.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

// ── Visibility ───────────────────────────────────────────────────────────────

/**
 * Which events a human timeline shows.
 *
 * §74, §94, §210, §211. The evidence store legitimately holds MORE than the UI
 * displays, and this is where the two diverge — a **projection policy**, not a
 * column on the event (§75). One event can feed several projections, and a
 * stored visibility flag would freeze at write time a decision that belongs to
 * the reader.
 *
 * A frozen total `Record`, so a new event type cannot be added without deciding
 * whether a person sees it. The default that a lazy implementation would pick —
 * show everything — is exactly the one that fills a signer's timeline with
 * pipeline mechanics.
 */
export const EVENT_VISIBILITY: Readonly<Record<EvidenceEventType, "timeline" | "internal">> =
  Object.freeze({
    // What a person did, or what happened to their request.
    "transaction-created": "timeline",
    "transaction-sent": "timeline",
    "transaction-cancelled": "timeline",
    "transaction-expired": "timeline",
    "transaction-completed": "timeline",
    "recipient-activated": "timeline",
    "authentication-completed": "timeline",
    "document-viewed": "timeline",
    "consent-accepted": "timeline",
    "signature-completed": "timeline",
    "participant-declined": "timeline",

    // Pipeline provenance. Retained in evidence, kept out of the ordinary
    // timeline (§66, §67, §210) — a signer does not need to know a field merge
    // ran, and a reader looking for "who signed when" should not have to scroll
    // past three infrastructure steps to find it.
    "completion-ready": "internal",
    "field-merge-completed": "internal",
    "certificate-generated": "internal",
    "final-seal-completed": "internal",
    "document-sealed": "internal",
    "verification-record-created": "internal",

    // The backend accepting the submission. `signature-completed` is the
    // human-readable "signed" event (§63); showing both would read as two
    // signatures to anyone who did not know the difference.
    "submission-accepted": "internal",

    // BACKEND-45 will own delivery facts. Until something authoritative says a
    // message arrived, this event says only that LAGDA queued one — which is
    // not a claim worth a timeline row (§71, §172).
    "invitation-sent": "internal",
  });

// ── The view ─────────────────────────────────────────────────────────────────

/** Who acted, as a reader sees it. Never an internal id (§204). */
export type AuditActorView =
  | { readonly type: "workspace-user"; readonly displayName: string }
  | {
    readonly type: "recipient";
    readonly displayName: string;
    readonly recipientId: SigningRequestRecipientId;
  }
  | { readonly type: "system"; readonly displayName: string };

/**
 * Event-specific detail, type-discriminated.
 *
 * §78, §203: no generic metadata blob reaches a client. A payload the frontend
 * cannot know the shape of is one it will render by guessing.
 */
export type AuditDetailsView =
  | { readonly kind: "authentication"; readonly method: string }
  | { readonly kind: "consent"; readonly consentType: string; readonly consentVersion: string }
  | { readonly kind: "none" };

export interface AuditEntryView {
  readonly id: string;
  readonly type: EvidenceEventType;
  /** The version the event was WRITTEN under, so a client can branch too. */
  readonly eventVersion: number;
  /** ISO-8601 UTC (§176). Never a server-formatted local string. */
  readonly occurredAt: string;
  readonly actor: AuditActorView;
  readonly description: string;
  readonly details: AuditDetailsView;
}

export interface AuditTrailView {
  readonly signingRequestId: string;
  readonly state: string;
  readonly entries: readonly AuditEntryView[];
}

// ── Descriptions ─────────────────────────────────────────────────────────────

/**
 * The sanctioned wording, by event type.
 *
 * Every phrase here was chosen against §171–§175, and the omissions matter more
 * than the inclusions:
 *
 *   - `document-viewed` says **entered**, never "read" or "reviewed" (§173).
 *     LAGDA observed an entry; what a person read is not a fact it holds.
 *   - `authentication-completed` says **authenticated**, never "identity
 *     verified" (§174) — a signing link proves possession of a link.
 *   - `transaction-sent` says **sent for signing**, never "email delivered"
 *     (§172). Nothing here knows a message arrived.
 *   - Nothing anywhere says digitally signed, PKI, notarized or legally
 *     binding (§175).
 *
 * A frozen total `Record`: a new event type without a description is a compile
 * error, not a blank row.
 */
const DESCRIPTIONS: Readonly<Record<EvidenceEventType, string>> = Object.freeze({
  "transaction-created": "Signing request created",
  "transaction-sent": "Request sent for signing",
  "transaction-cancelled": "Signing request cancelled",
  "transaction-expired": "Signing request expired",
  "transaction-completed": "Signing request completed",
  "recipient-activated": "Recipient became eligible to sign",
  "invitation-sent": "Signing invitation queued",
  "authentication-completed": "Recipient authenticated",
  "document-viewed": "Recipient entered the signing ceremony",
  "consent-accepted": "Recipient accepted electronic-signature consent",
  "submission-accepted": "Recipient's signing submission accepted",
  "signature-completed": "Recipient completed signing",
  "participant-declined": "Recipient declined to sign",
  "completion-ready": "All required participants completed their obligations",
  "field-merge-completed": "Signed values merged into the document",
  "certificate-generated": "Completion certificate generated",
  "final-seal-completed": "Final document sealing completed",
  "document-sealed": "Final document sealed",
  "verification-record-created": "Verification record created",
});

/**
 * The version this presenter understands for each type.
 *
 * §179, §259: an event written under a LATER version than this build knows must
 * not be reinterpreted through today's assumptions. It is displayed generically
 * instead — the type and time are still true, and inventing a reading of a
 * payload shape that did not exist yet is the failure being avoided.
 */
const UNDERSTOOD_VERSION = 1;

// ── The use case ─────────────────────────────────────────────────────────────

export interface AuditTrailDependencies {
  readonly transactions: {
    runForWorkspace<T>(
      workspaceId: WorkspaceId,
      operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
    ): Promise<T>;
  };
}

export interface GetAuditTrailInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
}

/**
 * One request's history, for an authorized workspace reader.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 *
 * `signing-request.view`, reused rather than a new `signing-audit.view`
 * (§97, §98 — owner decision, 2026-08-11). The product renders this timeline on
 * the transaction detail page itself, so anyone who can open the request
 * already sees its history; a second capability would guard nothing while
 * implying a distinction the UI does not make.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * ONE request (§101, §104). RLS scopes the workspace and the repository is
 * bound to it, but neither of those narrows to a request — so the query does,
 * explicitly. A missing or other-tenant request is a 404, never a 403 (§102):
 * telling a stranger that a request exists but is not theirs is the disclosure.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 *
 * §197. Reading the audit appends nothing. Someone looking at the history is
 * not a participant in the signing.
 */
export async function getSigningRequestAuditTrail(
  input: GetAuditTrailInput,
  deps: AuditTrailDependencies,
): Promise<AuditTrailView> {
  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.view");

    const request = await uow.signingRequests.find(input.signingRequestId);
    if (request === null) throw new ResourceNotFoundError("SigningRequest");

    const events = await uow.evidence.listForSigningRequest(
      input.signingRequestId as unknown as Parameters<
        typeof uow.evidence.listForSigningRequest>[0]);

    // The IMMUTABLE request-recipient snapshot (§27, §82, §167). Never a
    // Contact join and never a current profile lookup: a recipient renamed in
    // the address book must not silently rewrite who signed. Loaded once into a
    // map rather than per event (§165).
    const recipients = await uow.signingRequests.listRecipients(input.signingRequestId);
    const namesById = new Map(
      recipients.map(recipient => [String(recipient.recipientId), recipient.name]));

    const entries = events
      .filter(event => EVENT_VISIBILITY[event.eventType] === "timeline")
      .map(event => toEntry(event, namesById));

    return {
      signingRequestId: String(input.signingRequestId),
      state: request.state,
      entries,
    };
  });
}

function toEntry(
  event: EvidenceEventRecord,
  namesById: ReadonlyMap<string, string>,
): AuditEntryView {
  // §179/§180: never cast a payload of an unknown version into today's shape.
  const understood = event.eventVersion <= UNDERSTOOD_VERSION;

  return {
    id: String(event.evidenceEventId),
    type: event.eventType,
    eventVersion: event.eventVersion,
    // §176/§177: ISO-8601 UTC. The client formats for its own locale; a
    // server-rendered local string would be one timezone presented as fact.
    occurredAt: new Date(event.occurredAt).toISOString(),
    actor: toActor(event, namesById),
    description: understood
      ? DESCRIPTIONS[event.eventType]
      // Generic, and honest: the type and time are still true.
      : "A recorded event this version cannot describe",
    details: understood ? toDetails(event) : { kind: "none" },
  };
}

function toActor(
  event: EvidenceEventRecord,
  namesById: ReadonlyMap<string, string>,
): AuditActorView {
  if (event.actor.type === "system") {
    // §84. Never a fabricated user. The pipeline did this.
    return { type: "system", displayName: "LAGDA system" };
  }

  if (event.actor.type === "recipient") {
    const recipientId = event.actor.actorId;
    return {
      type: "recipient",
      // §169: a name that cannot be resolved degrades rather than breaking the
      // trail. The event is still true without it.
      displayName: namesById.get(String(recipientId)) ?? "Recipient",
      recipientId,
    };
  }

  // ── Workspace users (§25, §83, §168, §266) ────────────────────────────────
  //
  // NOT resolved to the user's current profile name. LAGDA does not snapshot an
  // actor display name at event time, so the only name available is today's —
  // and rendering it beside a historical event asserts it was their name then,
  // which nothing here knows.
  //
  // A generic label is the honest projection of what is actually stored. If the
  // product later needs the name, the fix is to snapshot it at write time
  // (§25's preferred direction), not to join the current profile here.
  return { type: "workspace-user", displayName: "Workspace user" };
}

function toDetails(event: EvidenceEventRecord): AuditDetailsView {
  const payload = event.details?.payload;
  if (payload === undefined) return { kind: "none" };

  if (event.eventType === "authentication-completed") {
    const method = payload["method"];
    return typeof method === "string"
      ? { kind: "authentication", method }
      : { kind: "none" };
  }

  if (event.eventType === "consent-accepted") {
    const consentType = payload["consentType"];
    const consentVersion = payload["consentVersion"];
    return typeof consentType === "string" && typeof consentVersion === "string"
      ? { kind: "consent", consentType, consentVersion }
      : { kind: "none" };
  }

  // Everything else: nothing safe to surface. The seal's digest algorithm is
  // real but belongs to the detailed record, not a person's timeline (§209).
  return { kind: "none" };
}
