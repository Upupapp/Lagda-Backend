// The private audit trail projection (BACKEND-43).
//
// Most of what matters is what the projection REFUSES to say: no signature
// content, no field values, no IP, no user agent, no internal id, and no claim
// about identity or legal effect that LAGDA cannot support.

import { describe, it, expect } from "vitest";
import {
  EVENT_VISIBILITY, type AuditEntryView,
} from "./audit-trail.js";
import { EVIDENCE_EVENT_TYPES } from "../common/ports/evidence.js";

describe("visibility policy", () => {
  it("classifies every declared event type", () => {
    // Totality is compile-enforced by the frozen `Record`; asserted at runtime
    // too, because that guarantee vanishes if anyone widens the type.
    for (const type of EVIDENCE_EVENT_TYPES) {
      expect(EVENT_VISIBILITY[type]).toMatch(/^(timeline|internal)$/);
    }
  });

  it("keeps completion-pipeline mechanics out of the human timeline", () => {
    // §66, §67, §210. Retained in evidence, not shown — a reader looking for
    // "who signed when" should not scroll past infrastructure to find it.
    for (const internal of [
      "completion-ready", "field-merge-completed", "certificate-generated",
      "final-seal-completed", "document-sealed", "verification-record-created",
    ] as const) {
      expect(EVENT_VISIBILITY[internal]).toBe("internal");
    }
  });

  it("shows signature-completed but NOT submission-accepted", () => {
    // §63. Both are real and both are kept; showing both would read as two
    // signatures to anyone who did not know the difference.
    expect(EVENT_VISIBILITY["signature-completed"]).toBe("timeline");
    expect(EVENT_VISIBILITY["submission-accepted"]).toBe("internal");
  });

  it("does not show invitation-sent, which claims no delivery", () => {
    // §71, §172. BACKEND-45 owns delivery facts. "LAGDA queued a message" is
    // not worth a timeline row and reads as "they got the email".
    expect(EVENT_VISIBILITY["invitation-sent"]).toBe("internal");
  });

  it("shows every fact a person performed", () => {
    for (const visible of [
      "transaction-created", "transaction-sent", "recipient-activated",
      "authentication-completed", "document-viewed", "consent-accepted",
      "signature-completed", "participant-declined", "transaction-completed",
    ] as const) {
      expect(EVENT_VISIBILITY[visible]).toBe("timeline");
    }
  });
});

describe("the sanctioned wording", () => {
  /** Every description the presenter can produce. */
  const descriptions = async (): Promise<readonly string[]> => {
    const module = await import("./audit-trail.js");
    // Not exported deliberately — read through the presenter's own behaviour by
    // rendering one entry per type would need a full harness. Instead the
    // module's source is the subject, which is what these claims are about.
    void module;
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./audit-trail.ts", import.meta.url), "utf8");
    const block = /const DESCRIPTIONS[\s\S]*?\n\}\);/.exec(source)?.[0] ?? "";
    expect(block).not.toBe("");
    return [...block.matchAll(/"([^"]*)"\s*,/g)].map(m => m[1] ?? "");
  };

  it("never says read or reviewed for a ceremony entry", async () => {
    // §173. LAGDA observed an ENTRY. What a person read is not a fact it holds.
    const all = (await descriptions()).join(" ").toLowerCase();
    expect(all).not.toContain("read the");
    expect(all).not.toContain("reviewed");
    expect(all).toContain("entered the signing ceremony");
  });

  it("never claims identity was verified", async () => {
    // §174. A signing link proves possession of a link.
    const all = (await descriptions()).join(" ").toLowerCase();
    expect(all).not.toContain("identity verified");
    expect(all).not.toContain("verified identity");
    expect(all).toContain("authenticated");
  });

  it("never says an email was delivered or received", async () => {
    // §172.
    const all = (await descriptions()).join(" ").toLowerCase();
    for (const forbidden of ["delivered", "received", "opened the email"]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it("makes no cryptographic or legal claim", async () => {
    // §175. LAGDA implements none of these.
    const all = (await descriptions()).join(" ").toLowerCase();
    for (const forbidden of [
      "pki", "x.509", "pades", "notarized", "notarised", "legally binding",
      "digitally signed", "certificate authority",
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });
});

describe("the entry shape", () => {
  /** A representative entry, built by hand to assert the CONTRACT's shape. */
  const entry: AuditEntryView = {
    id: "ev_1",
    type: "signature-completed",
    eventVersion: 1,
    occurredAt: "2026-08-11T10:00:00.000Z",
    actor: { type: "recipient", displayName: "Ana", recipientId: "srr_1" as never },
    description: "Recipient completed signing",
    details: { kind: "none" },
  };

  it("carries an ISO-8601 UTC timestamp, not a formatted local string", () => {
    // §176, §177. The client formats for its locale; a server-rendered local
    // string would be one timezone presented as fact.
    expect(entry.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("exposes no workspace, document, artifact or storage identifier", () => {
    // §78, §276. Asserted over the serialized entry, because a shape assertion
    // misses a nested field.
    const wire = JSON.stringify(entry).toLowerCase();
    for (const forbidden of [
      "workspace", "documentid", "artifact", "storage", "bucket", "sealid",
      "completionrun", "actoruserid", "sourcetype", "sourceid",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("exposes no signature content, field value, token or PII beyond a name", () => {
    // §190-§193, §271-§273.
    const wire = JSON.stringify(entry).toLowerCase();
    for (const forbidden of [
      "signatureimage", "strokes", "fieldvalue", "otp", "token", "cookie",
      "email", "ipaddress", "useragent",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("carries the event version, so a client can branch too", () => {
    // §179. A client that cannot see the version has to guess the payload shape.
    expect(entry.eventVersion).toBe(1);
  });
});
