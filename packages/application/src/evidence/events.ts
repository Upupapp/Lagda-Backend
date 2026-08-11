// The evidence event registry (BACKEND-43 §132, §133).
//
// ── Why producers do not build events themselves ───────────────────────────
//
// §132 forbids scattered `append({ eventType: "..." })` calls through arbitrary
// use cases, and the reason is not tidiness. An evidence event has four things
// that must agree and that nothing in the type system would otherwise couple:
//
//   the event type          "transaction-sent"
//   its semantic version    the reading of that type this row was written under
//   its authoritative source the durable row the fact comes from
//   its actor shape         who may legitimately have caused it
//
// A hand-built literal can get any of them wrong and still compile. Version 1
// on an event whose meaning has moved to 2, a `completion-run` source id on a
// `recipient-submission` event, a `system` actor on a fact a person performed —
// all type-check, all corrupt the record silently, and none is recoverable
// afterwards because evidence is append-only.
//
// So each event type gets exactly one constructor, which takes precisely the
// inputs that event needs and nothing else. A producer cannot supply a version
// at all, and cannot supply a source of the wrong kind.
//
// ── These are not the display layer ────────────────────────────────────────
//
// §13 and §79: nothing here produces English. A factory returns the machine
// fact; the audit projection turns it into a sentence at read time. Storing the
// wording would make the record depend on a copy decision, and §81 requires
// event semantics to survive a rewording.

import type {
  EvidenceEventId, EvidenceEventInput, EvidenceEventType, EvidenceSource,
  EvidenceActor, ObservedRequestContext, SigningRequestRecipientId,
} from "../common/ports/evidence.js";
import type { TransactionId, UserId, DocumentId } from "@lagda/contracts";

/**
 * The current semantic version of every event type.
 *
 * A **frozen total `Record`**: adding a member to `EvidenceEventType` without
 * deciding its version is a compile error, not a row that quietly writes
 * whatever the column defaults to.
 *
 * Bumping a value here is a deliberate statement that the MEANING of that event
 * changed. Historical rows keep the version they were written with, and the
 * projection branches on it (§179) — this constant says what NEW rows assert,
 * never how old ones are read.
 *
 * Everything is v1: BACKEND-43 is the first command to write any of them.
 */
export const EVENT_VERSIONS: Readonly<Record<EvidenceEventType, number>> =
  Object.freeze({
    "transaction-created": 1,
    "transaction-sent": 1,
    "transaction-cancelled": 1,
    "transaction-expired": 1,
    "transaction-completed": 1,
    "invitation-sent": 1,
    "authentication-completed": 1,
    "consent-accepted": 1,
    "document-viewed": 1,
    "signature-completed": 1,
    "participant-declined": 1,
    "document-sealed": 1,
    "verification-record-created": 1,
    "recipient-activated": 1,
    "submission-accepted": 1,
    "completion-ready": 1,
    "field-merge-completed": 1,
    "certificate-generated": 1,
    "final-seal-completed": 1,
  });

/**
 * What every factory needs regardless of event type.
 *
 * `newEventId` rather than a generator port, so a factory stays a pure function
 * and a producer keeps control of when an id is minted — which matters inside a
 * transaction that may roll back.
 */
interface EventBase {
  readonly newEventId: () => EvidenceEventId;
  readonly signingRequestId: TransactionId;
  readonly occurredAt: number;
}

/** Assembles the common shape. Private — no producer calls this directly. */
function build(
  base: EventBase,
  eventType: EvidenceEventType,
  actor: EvidenceActor,
  source: EvidenceSource,
  extra: {
    readonly documentId?: DocumentId;
    readonly recipientId?: SigningRequestRecipientId;
    readonly observed?: ObservedRequestContext;
    readonly details?: EvidenceEventInput["details"];
  } = {},
): EvidenceEventInput {
  return {
    evidenceEventId: base.newEventId(),
    signingRequestId: base.signingRequestId,
    eventType,
    // Read from the registry, never passed in. A producer cannot assert a
    // version, which is the whole point of the registry existing.
    eventVersion: EVENT_VERSIONS[eventType],
    actor,
    occurredAt: base.occurredAt,
    source,
    // Spread one at a time. Under `exactOptionalPropertyTypes` an ABSENT key
    // and a key holding `undefined` are different types, and a bulk spread of
    // `extra` produces the second — which the port deliberately does not accept.
    ...(extra.documentId === undefined ? {} : { documentId: extra.documentId }),
    ...(extra.recipientId === undefined ? {} : { recipientId: extra.recipientId }),
    ...(extra.observed === undefined ? {} : { observed: extra.observed }),
    ...(extra.details === undefined ? {} : { details: extra.details }),
  };
}

// ── Request lifecycle ────────────────────────────────────────────────────────

/**
 * An authorized workspace actor created the immutable SigningRequest snapshot.
 *
 * `occurredAt` is `SigningRequest.createdAt` (§16) — not a clock read at append
 * time, which would drift from the row by however long the transaction took.
 */
export function requestCreated(
  base: EventBase, actorUserId: UserId, documentId: DocumentId,
): EvidenceEventInput {
  return build(base, "transaction-created",
    { type: "workspace-user", actorId: actorUserId },
    // The request itself is the durable fact. One creation per request, so the
    // partial unique index makes a duplicate impossible rather than unlikely.
    { type: "signing-request", id: base.signingRequestId },
    { documentId });
}

/**
 * An authorized workspace actor committed the request for recipient access.
 *
 * **Not "email delivered"** (§55, §172). Nothing here claims a message reached
 * anyone; BACKEND-45 owns delivery facts and they are a different record.
 *
 * `occurredAt` is `SigningRequest.sentAt`.
 */
export function requestSent(
  base: EventBase, actorUserId: UserId,
): EvidenceEventInput {
  return build(base, "transaction-sent",
    { type: "workspace-user", actorId: actorUserId },
    { type: "signing-request", id: base.signingRequestId });
}

/**
 * Final artifact, seal, completion record and request state all durably
 * committed (§69).
 *
 * A `system` actor: completion is performed by the pipeline, not by a person.
 * Attributing it to the owner would make "who did this" a fiction (§22, §84).
 *
 * `occurredAt` is `SigningRequest.completedAt` — BACKEND-41's finalization
 * clock, and §18 makes that mandatory rather than preferred.
 */
export function requestCompleted(
  base: EventBase, completionId: string,
): EvidenceEventInput {
  return build(base, "transaction-completed", { type: "system" },
    { type: "signing-request-completion", id: completionId });
}

// ── Recipient lifecycle ──────────────────────────────────────────────────────

/**
 * A recipient became routing-eligible for signing access (§56).
 *
 * **Not "email delivered", not "recipient viewed".** Eligibility is a workflow
 * fact about the request, which is why the actor is `system`.
 */
export function recipientActivated(
  base: EventBase, recipientId: SigningRequestRecipientId,
): EvidenceEventInput {
  return build(base, "recipient-activated", { type: "system" },
    // The recipient row is the source: one activation per recipient, and the
    // unique index says so.
    { type: "signing-request-recipient", id: recipientId },
    { recipientId });
}

/**
 * A recipient completed the authentication method BACKEND-34 recorded (§58).
 *
 * The method is carried in `details` because it varies by event and is exactly
 * the kind of thing §88 permits in a detailed audit. **No assurance claim is
 * made** — §174 forbids reading a link or an OTP as verified identity.
 *
 * Sourced by SESSION, not by recipient: a recipient may legitimately
 * authenticate more than once, and §305 warns against a constraint that blocks
 * a repeat the product allows.
 */
export function recipientAuthenticated(
  base: EventBase, recipientId: SigningRequestRecipientId, sessionId: string, method: string,
): EvidenceEventInput {
  return build(base, "authentication-completed",
    { type: "recipient", actorId: recipientId },
    { type: "recipient-session", id: sessionId },
    { recipientId, details: { version: 1, payload: { method } } });
}

/**
 * A recipient entered the signing ceremony (§59).
 *
 * **Not "read", not "reviewed"** (§173). Entering is what LAGDA observed;
 * whether anyone read anything is not a fact it holds.
 *
 * **No source.** A recipient may enter many times, and no single durable row
 * makes any one entry the fact — so this event is deliberately outside the
 * partial unique index. BACKEND-35's coalescing is what keeps reload traffic
 * from filling the timeline (§93), not a database constraint.
 */
export function ceremonyEntered(
  base: EventBase, recipientId: SigningRequestRecipientId,
  observed?: ObservedRequestContext,
): EvidenceEventInput {
  return {
    evidenceEventId: base.newEventId(),
    signingRequestId: base.signingRequestId,
    eventType: "document-viewed",
    eventVersion: EVENT_VERSIONS["document-viewed"],
    actor: { type: "recipient", actorId: recipientId },
    occurredAt: base.occurredAt,
    recipientId,
    ...(observed === undefined ? {} : { observed }),
  };
}

/**
 * A recipient accepted electronic-signature consent (§61).
 *
 * Type and version only — never the legal text, which belongs to the consent
 * record and would blow past the 8 KB payload cap besides.
 */
export function consentAccepted(
  base: EventBase, recipientId: SigningRequestRecipientId, consentId: string,
  consentType: string, consentVersion: string,
): EvidenceEventInput {
  return build(base, "consent-accepted",
    { type: "recipient", actorId: recipientId },
    { type: "recipient-consent", id: consentId },
    {
      recipientId,
      details: { version: 1, payload: { consentType, consentVersion } },
    });
}

/**
 * The backend accepted a recipient's authoritative final submission (§62).
 *
 * Distinct from `signature-completed` below, and deliberately so. This is the
 * BACKEND ACCEPTING an immutable record; that one is the WORKFLOW transitioning
 * the recipient to SIGNED. They share a timestamp — §248 requires it — and §43's
 * precedence is what orders them for a reader rather than the clock.
 */
export function submissionAccepted(
  base: EventBase, recipientId: SigningRequestRecipientId, submissionId: string,
): EvidenceEventInput {
  return build(base, "submission-accepted",
    { type: "recipient", actorId: recipientId },
    { type: "recipient-submission", id: submissionId },
    { recipientId });
}

/**
 * The workflow transitioned this recipient to SIGNED (§63).
 *
 * `occurredAt` is `RecipientSubmission.acceptedAt` — §17 makes this mandatory.
 * Reading a clock here instead would put the human-readable "Signed" moment a
 * few milliseconds after the fact it reports.
 *
 * Sourced by the SUBMISSION, so a retried workflow application converges on the
 * one event rather than appending a second (§49, §261).
 */
export function recipientSigned(
  base: EventBase, recipientId: SigningRequestRecipientId, submissionId: string,
): EvidenceEventInput {
  return build(base, "signature-completed",
    { type: "recipient", actorId: recipientId },
    { type: "recipient-submission", id: submissionId },
    { recipientId });
}

/** A recipient declined to sign (§72). Only where the product has the state. */
export function participantDeclined(
  base: EventBase, recipientId: SigningRequestRecipientId,
): EvidenceEventInput {
  return build(base, "participant-declined",
    { type: "recipient", actorId: recipientId },
    { type: "signing-request-recipient", id: recipientId },
    { recipientId });
}

// ── Completion pipeline ──────────────────────────────────────────────────────

/**
 * Every required participant finished; final document production became
 * eligible (§65).
 *
 * **Not "the final PDF exists".** That is three events later.
 */
export function completionReady(
  base: EventBase, runId: string,
): EvidenceEventInput {
  return build(base, "completion-ready", { type: "system" },
    { type: "completion-run", id: runId });
}

/**
 * The three completion-step successes (§66, §67, §68).
 *
 * Sourced by `completion-step`, whose id already encodes run and step, so a
 * duplicate worker converges on the existing event rather than appending a
 * second (§260). Internal provenance — retained in evidence, kept out of the
 * ordinary human timeline (§210, §211).
 */
export function fieldMergeCompleted(
  base: EventBase, stepId: string,
): EvidenceEventInput {
  return build(base, "field-merge-completed", { type: "system" },
    { type: "completion-step", id: stepId });
}

export function certificateGenerated(
  base: EventBase, stepId: string,
): EvidenceEventInput {
  return build(base, "certificate-generated", { type: "system" },
    { type: "completion-step", id: stepId });
}

/**
 * The final seal output was accepted (§68).
 *
 * **Not the same as the request being completed** — the database finalization
 * follows, and §68 is explicit that conflating them misreports the moment.
 */
export function finalSealCompleted(
  base: EventBase, stepId: string,
): EvidenceEventInput {
  return build(base, "final-seal-completed", { type: "system" },
    { type: "completion-step", id: stepId });
}

/**
 * A seal record exists for this request.
 *
 * The digest algorithm travels in `details`; the digests themselves do not. They
 * are on the seal row, and §208/§209 keep bulk technical data out of the
 * timeline rather than duplicating it into every event.
 */
export function documentSealed(
  base: EventBase, sealId: string, digestAlgorithm: string,
): EvidenceEventInput {
  return build(base, "document-sealed", { type: "system" },
    { type: "document-seal", id: sealId },
    { details: { version: 1, payload: { digestAlgorithm } } });
}

/**
 * The public verification identity was minted.
 *
 * The identifier itself is public-safe (BACKEND-42) and appears in the audit
 * header, so it is not repeated in the payload.
 */
export function verificationRecordCreated(
  base: EventBase, verificationId: string,
): EvidenceEventInput {
  return build(base, "verification-record-created", { type: "system" },
    { type: "verification-record", id: verificationId });
}
