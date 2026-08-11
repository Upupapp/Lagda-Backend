// The evidence event registry (BACKEND-43).
//
// What matters here is not that each factory returns an object — it is that a
// producer cannot get the four coupled things wrong: type, version, source and
// actor. Most of these tests assert a constraint rather than a value.

import { describe, it, expect } from "vitest";
import { EVIDENCE_EVENT_TYPES } from "../common/ports/evidence.js";
import type {
  EvidenceEventId, EvidenceEventInput, SigningRequestRecipientId,
} from "../common/ports/evidence.js";
import type { TransactionId, UserId, DocumentId } from "@lagda/contracts";
import * as events from "./events.js";

const REQ = "req_1" as TransactionId;
const USER = "usr_1" as UserId;
const DOC = "doc_1" as DocumentId;
// The IMMUTABLE signing-request recipient. Evidence never cites the mutable
// preparation recipient — see the note on the port.
const REC = "srr_1" as SigningRequestRecipientId;
const AT = Date.parse("2026-08-11T10:00:00.000Z");

let minted = 0;
const base = () => ({
  newEventId: () => `ev_${String(++minted)}` as EvidenceEventId,
  signingRequestId: REQ,
  occurredAt: AT,
});

/** Every factory, called with plausible arguments. */
function all(): readonly EvidenceEventInput[] {
  return [
    events.requestCreated(base(), USER, DOC),
    events.requestSent(base(), USER),
    events.requestCompleted(base(), "cmp_1"),
    events.recipientActivated(base(), REC),
    events.recipientAuthenticated(base(), REC, "ses_1", "signing-link"),
    events.ceremonyEntered(base(), REC),
    events.consentAccepted(base(), REC, "con_1", "electronic-signature", "1"),
    events.submissionAccepted(base(), REC, "sub_1"),
    events.recipientSigned(base(), REC, "sub_1"),
    events.participantDeclined(base(), REC),
    events.completionReady(base(), "run_1"),
    events.fieldMergeCompleted(base(), "stp_1"),
    events.certificateGenerated(base(), "stp_2"),
    events.finalSealCompleted(base(), "stp_3"),
    events.documentSealed(base(), "sel_1", "sha-256"),
    events.verificationRecordCreated(base(), "LAGDA-VER-2026-A7bK9mQ2xZ"),
  ];
}

describe("the version registry", () => {
  it("assigns a version to every declared event type", () => {
    // Totality is a compile-time guarantee from the frozen `Record`. This
    // asserts it at runtime too, because the compile-time check disappears if
    // anyone widens the type to `Record<string, number>`.
    for (const type of EVIDENCE_EVENT_TYPES) {
      expect(events.EVENT_VERSIONS[type]).toBeGreaterThan(0);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(events.EVENT_VERSIONS)).toBe(true);
  });

  it("declares no version the database would reject", () => {
    // `check (event_version > 0)`.
    for (const version of Object.values(events.EVENT_VERSIONS)) {
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThan(0);
    }
  });
});

describe("every factory", () => {
  it("stamps the registry's version, never one of its own", () => {
    for (const event of all()) {
      expect(event.eventVersion).toBe(events.EVENT_VERSIONS[event.eventType]);
    }
  });

  it("carries the occurredAt it was given, never a fresh clock read", () => {
    // §14/§16: the time is the authoritative business fact's, supplied by the
    // producer from the row. A factory that read a clock would drift from the
    // record it describes by however long the transaction took.
    for (const event of all()) {
      expect(event.occurredAt).toBe(AT);
    }
  });

  it("mints exactly one event id per call", () => {
    const ids = all().map(e => e.evidenceEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces no English anywhere", () => {
    // §13, §79, §81. The factory returns the machine fact; the projection makes
    // the sentence. A stored description would make the record depend on a copy
    // decision and would not survive a rewording.
    for (const event of all()) {
      const wire = JSON.stringify(event).toLowerCase();
      for (const prose of [
        "recipient signed", "request sent", " the ", "completed the",
        "successfully", "please",
      ]) {
        expect(wire).not.toContain(prose);
      }
    }
  });

  it("never carries a signature, field value, token or storage key", () => {
    // §35, §190-§193. Asserted over the whole serialized event.
    for (const event of all()) {
      const wire = JSON.stringify(event).toLowerCase();
      for (const forbidden of [
        "signature_image", "signatureimage", "strokes", "otp", "token",
        "cookie", "storagekey", "storage_key", "bucket", "password",
      ]) {
        expect(wire).not.toContain(forbidden);
      }
    }
  });
});

describe("actors are never conflated", () => {
  it("attributes workspace acts to the user who performed them", () => {
    for (const event of [events.requestCreated(base(), USER, DOC),
      events.requestSent(base(), USER)]) {
      expect(event.actor).toEqual({ type: "workspace-user", actorId: USER });
    }
  });

  it("attributes recipient acts to the RECIPIENT, not a user id", () => {
    // §21. An external signer has no LAGDA account; modelling them as a user
    // would need a fake row or a meaningless actor id.
    for (const event of [
      events.recipientAuthenticated(base(), REC, "ses_1", "signing-link"),
      events.ceremonyEntered(base(), REC),
      events.submissionAccepted(base(), REC, "sub_1"),
      events.recipientSigned(base(), REC, "sub_1"),
    ]) {
      expect(event.actor).toEqual({ type: "recipient", actorId: REC });
    }
  });

  it("attributes pipeline acts to the system, inventing no user", () => {
    // §22, §84. Attributing completion to the owner would make "who did this"
    // a fiction.
    for (const event of [
      events.requestCompleted(base(), "cmp_1"),
      events.recipientActivated(base(), REC),
      events.completionReady(base(), "run_1"),
      events.fieldMergeCompleted(base(), "stp_1"),
      events.finalSealCompleted(base(), "stp_3"),
      events.documentSealed(base(), "sel_1", "sha-256"),
    ]) {
      expect(event.actor).toEqual({ type: "system" });
      expect(event.actor).not.toHaveProperty("actorId");
    }
  });
});

describe("idempotency sources", () => {
  it("gives EVERY event a source", () => {
    // Including `document-viewed`. Migration 003 declined uniqueness on it
    // because a recipient may view many times — but LAGDA only persists the
    // FIRST entry, so that is the only view evidence can honestly claim, and
    // sourcing it by the recipient settles §93 structurally: a reload cannot
    // fill the timeline, because the index refuses the second.
    for (const event of all()) {
      expect(event.source).toBeDefined();
    }
  });

  it("makes ceremony entry exactly-once per recipient", () => {
    const event = events.ceremonyEntered(base(), REC);
    expect(event.source).toEqual({ type: "signing-request-recipient", id: REC });
  });

  it("sources the SIGNED event from the submission, so a retry converges", () => {
    // §49, §261: applying the same submission to the workflow twice must not
    // produce two signature events. The unique index refuses the second.
    const first = events.recipientSigned(base(), REC, "sub_1");
    const second = events.recipientSigned(base(), REC, "sub_1");
    expect(first.source).toEqual({ type: "recipient-submission", id: "sub_1" });
    expect(second.source).toEqual(first.source);
    // Different event IDs — the dedupe key is the SOURCE, not the id.
    expect(second.evidenceEventId).not.toBe(first.evidenceEventId);
  });

  it("sources completion steps from the step, so a duplicate worker converges", () => {
    // §260.
    expect(events.fieldMergeCompleted(base(), "stp_1").source)
      .toEqual({ type: "completion-step", id: "stp_1" });
    expect(events.certificateGenerated(base(), "stp_2").source)
      .toEqual({ type: "completion-step", id: "stp_2" });
  });

  it("sources authentication from the SESSION, not the recipient", () => {
    // A recipient may legitimately authenticate more than once. Sourcing by
    // recipient would make the second attempt a constraint violation.
    const one = events.recipientAuthenticated(base(), REC, "ses_1", "signing-link");
    const two = events.recipientAuthenticated(base(), REC, "ses_2", "signing-link");
    expect(one.source).not.toEqual(two.source);
  });

  it("sources completion from the completion record", () => {
    // §120.
    expect(events.requestCompleted(base(), "cmp_1").source)
      .toEqual({ type: "signing-request-completion", id: "cmp_1" });
  });
});

describe("submission accepted and recipient signed are distinct facts", () => {
  it("emits two different event types from one submission", () => {
    // §62 vs §63. The backend accepting an immutable record and the workflow
    // transitioning the recipient are different facts.
    const accepted = events.submissionAccepted(base(), REC, "sub_1");
    const signed = events.recipientSigned(base(), REC, "sub_1");

    expect(accepted.eventType).toBe("submission-accepted");
    expect(signed.eventType).toBe("signature-completed");
  });

  it("shares one timestamp between them", () => {
    // §248 requires it. They describe the same instant from two angles, so
    // event precedence rather than the clock is what orders them for a reader.
    const accepted = events.submissionAccepted(base(), REC, "sub_1");
    const signed = events.recipientSigned(base(), REC, "sub_1");
    expect(signed.occurredAt).toBe(accepted.occurredAt);
  });

  it("does not collide in the unique index despite one source", () => {
    // Both are sourced from the same submission, and the index is keyed on
    // (workspace, TYPE, sourceType, sourceId) — so the differing type is what
    // lets both exist. If the index dropped `event_type`, one would be refused.
    const accepted = events.submissionAccepted(base(), REC, "sub_1");
    const signed = events.recipientSigned(base(), REC, "sub_1");
    expect(accepted.source).toEqual(signed.source);
    expect(accepted.eventType).not.toBe(signed.eventType);
  });
});

describe("details payloads", () => {
  it("carries the authentication method and nothing more", () => {
    // §88 permits the method in a detailed audit; §174 forbids reading it as
    // verified identity, which is a projection-wording concern, not a payload.
    const event = events.recipientAuthenticated(base(), REC, "ses_1", "email-otp");
    expect(event.details).toEqual({ version: 1, payload: { method: "email-otp" } });
  });

  it("carries consent type and version, never the legal text", () => {
    // §61. The text belongs to the consent record and would exceed the 8 KB cap.
    const event = events.consentAccepted(
      base(), REC, "con_1", "electronic-signature", "1");
    expect(event.details?.payload).toEqual({
      consentType: "electronic-signature", consentVersion: "1",
    });
  });

  it("carries the seal's algorithm but not its digests", () => {
    // §208/§209: the digests are on the seal row. Duplicating them into events
    // would put bulk technical data in the timeline for no gain.
    const event = events.documentSealed(base(), "sel_1", "sha-256");
    expect(event.details?.payload).toEqual({ digestAlgorithm: "sha-256" });
    expect(JSON.stringify(event)).not.toMatch(/[a-f0-9]{64}/);
  });

  it("keeps every payload inside the database's 8 KB cap", () => {
    for (const event of all()) {
      if (event.details === undefined) continue;
      expect(JSON.stringify(event.details.payload).length).toBeLessThan(8192);
    }
  });
});
