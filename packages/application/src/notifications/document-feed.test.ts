// The in-app document notification feed.
//
// The claims that carry weight:
//
//   it reports STATUS CHANGES and stays quiet about page views, consents and
//   the four pipeline steps every completion writes — a feed nobody reads is
//   the failure mode here, not a missing row;
//
//   it names the document and the participant from the IMMUTABLE snapshot;
//
//   newest first, and bounded.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  getDocumentNotifications, NOTIFIABLE_EVENT_TYPES, MAX_FEED_LIMIT,
} from "./document-feed.js";
import { EVIDENCE_EVENT_TYPES } from "../common/ports/evidence.js";
import type { EvidenceEventType } from "../common/ports/evidence.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { SigningRequestId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const REQUEST = "sreq_1";
const RECIPIENT = "srr_1";

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: { transactions: FakeTransactionManager };
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock, policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  // A signing request and one recipient, so the feed has names to resolve.
  store.signingRequests.push({
    signingRequestId: REQUEST as never,
    workspaceId: created.workspaceId,
    documentId: "doc_1" as never,
    documentTitle: "Office Lease",
    sourceArtifactId: "art_1" as never,
    state: "sent",
    createdByUserId: OWNER,
    createdAt: AT,
    sentAt: AT,
  } as never);
  store.signingRequestRecipients.push({
    recipientId: RECIPIENT as never,
    sourcePreparationRecipientId: null,
    name: "Maria Santos",
    email: "maria@ayalaland.test",
    normalizedEmail: "maria@ayalaland.test",
    organization: null,
    type: "signer",
    isRequired: true,
    orderIndex: 0,
    routingOrder: 1,
  } as never);
  store.snapshotOwners.set(RECIPIENT, REQUEST as never);

  return { store, workspaceId: created.workspaceId, deps: { transactions } };
}

/** Pushes one evidence row straight into the store. */
function evidence(
  h: Harness, eventType: EvidenceEventType, at: number, withRecipient = true,
): void {
  h.store.evidence.push({
    evidenceEventId: `ev_${eventType}_${String(at)}` as never,
    workspaceId: h.workspaceId,
    signingRequestId: REQUEST as never,
    ...(withRecipient ? { recipientId: RECIPIENT as never } : {}),
    eventType,
    eventVersion: 1,
    actor: withRecipient
      ? { type: "recipient", actorId: RECIPIENT as never }
      : { type: "system" },
    occurredAt: at,
    recordedAt: at,
  } as never);
}

const read = (h: Harness, limit?: number) => getDocumentNotifications({
  actor: actor(OWNER), workspaceId: h.workspaceId,
  ...(limit === undefined ? {} : { limit }),
}, h.deps as never);

describe("what reaches the feed", () => {
  it("reports a participant declining — the outcome that ends the request", async () => {
    const h = await harness();
    evidence(h, "participant-declined", AT + 1000);

    const feed = await read(h);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe("Participant declined");
    expect(feed[0]?.severity).toBe("critical");
    expect(feed[0]?.actionRequired).toBe(true);
    // Named from the snapshot, both of them.
    expect(feed[0]?.documentTitle).toBe("Office Lease");
    expect(feed[0]?.recipientName).toBe("Maria Santos");
  });

  it("reports completion, signing and 069's two approver outcomes", async () => {
    const h = await harness();
    evidence(h, "signature-completed", AT + 1000);
    evidence(h, "approval-completed", AT + 2000);
    evidence(h, "participant-skipped", AT + 3000);
    evidence(h, "transaction-completed", AT + 4000, false);

    const feed = await read(h);

    expect(feed.map(n => n.type)).toEqual([
      "transaction-completed", "participant-skipped",
      "approval-completed", "signature-completed",
    ]);
  });

  it("stays quiet about page views, consent and the completion pipeline", async () => {
    // The whole point of a narrower set than the audit timeline: a sender
    // interrupted for every page view stops reading the feed.
    const h = await harness();
    evidence(h, "document-viewed", AT + 1000);
    evidence(h, "consent-accepted", AT + 2000);
    evidence(h, "authentication-completed", AT + 3000);
    evidence(h, "submission-accepted", AT + 4000);
    evidence(h, "field-merge-completed", AT + 5000, false);
    evidence(h, "certificate-generated", AT + 6000, false);
    evidence(h, "final-seal-completed", AT + 7000, false);
    evidence(h, "document-sealed", AT + 8000, false);
    // The one thing the person being notified just did themselves.
    evidence(h, "transaction-created", AT + 9000, false);

    expect(await read(h)).toEqual([]);
  });

  it("orders newest first and honours the limit", async () => {
    const h = await harness();
    evidence(h, "signature-completed", AT + 1000);
    evidence(h, "participant-declined", AT + 2000);
    evidence(h, "transaction-completed", AT + 3000, false);

    const feed = await read(h, 2);

    expect(feed).toHaveLength(2);
    expect(feed[0]?.occurredAt).toBe(AT + 3000);
    expect(feed[1]?.occurredAt).toBe(AT + 2000);
  });

  it("clamps an absurd limit rather than reading unbounded", async () => {
    const h = await harness();
    evidence(h, "signature-completed", AT + 1000);

    // Not a throw: a caller asking for too much gets the maximum, the same
    // way every other paginated read in this codebase behaves.
    expect(await read(h, MAX_FEED_LIMIT + 5_000)).toHaveLength(1);
  });

  it("is empty for a workspace nothing has happened in", async () => {
    const h = await harness();
    expect(await read(h)).toEqual([]);
  });
});

describe("the vocabulary", () => {
  it("only names event types that actually exist", async () => {
    // A typo here would silently mean "never notify", which is exactly the
    // bug this feed was built to fix.
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      expect(EVIDENCE_EVENT_TYPES).toContain(type);
    }
  });

  it("gives every notifiable type a presentation, not a generic fallback", async () => {
    const h = await harness();
    let at = AT;
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      at += 1000;
      evidence(h, type, at);
    }

    const feed = await read(h, MAX_FEED_LIMIT);

    expect(feed).toHaveLength(NOTIFIABLE_EVENT_TYPES.length);
    for (const notification of feed) {
      expect(notification.title).not.toBe("");
      expect(notification.title).not.toBe("Notification");
      expect(notification.body).toContain("Office Lease");
    }
  });
});
