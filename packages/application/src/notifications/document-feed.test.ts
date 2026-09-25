// The in-app document notification feed.
//
// The claims that carry weight:
//
//   it reports STATUS CHANGES and stays quiet about page views, consents and
//   the four pipeline steps every completion writes — a feed nobody reads is
//   the failure mode here, not a missing row;
//
//   ONE ROW PER DOCUMENT, showing where it stands now (071). Three completed
//   documents used to read as sixteen notifications, because every event was
//   a row;
//
//   at the same instant, the MORE DECISIVE event represents the document —
//   an event id is not a meaning;
//
//   `mine` is the reader's own documents — sent by them, or ones they are a
//   participant on — and only ever narrows `workspace`;
//
//   read state PERSISTS, belongs to one reader, and a new event on a document
//   makes it unread again;
//
//   it names the document and the participant from the IMMUTABLE snapshot.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  getDocumentNotifications, setDocumentNotificationState,
  NOTIFIABLE_EVENT_TYPES, MAX_FEED_LIMIT,
  type DocumentFeedScope,
} from "./document-feed.js";
import { EVIDENCE_EVENT_TYPES } from "../common/ports/evidence.js";
import type { EvidenceEventType } from "../common/ports/evidence.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
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
const COLLEAGUE = "usr_colleague" as UserId;
/** Mixed case on purpose: the match must go through normalization. */
const OWNER_EMAIL = "Owner@Acme.test";

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: {
    transactions: FakeTransactionManager;
    accountEmailOf: (userId: UserId) => Promise<string | null>;
  };
}

interface RequestSpec {
  readonly id: string;
  readonly title: string;
  readonly createdBy: UserId;
  readonly recipients?: readonly { id: string; name: string; email: string }[];
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

  return {
    store,
    workspaceId: created.workspaceId,
    deps: {
      transactions,
      accountEmailOf: userId => Promise.resolve(userId === OWNER ? OWNER_EMAIL : null),
    },
  };
}

function addRequest(h: Harness, spec: RequestSpec): void {
  h.store.signingRequests.push({
    signingRequestId: spec.id as never,
    workspaceId: h.workspaceId,
    documentId: `doc_${spec.id}` as never,
    documentTitle: spec.title,
    sourceArtifactId: "art_1" as never,
    state: "sent",
    createdByUserId: spec.createdBy,
    createdAt: AT,
    sentAt: AT,
  } as never);
  for (const recipient of spec.recipients ?? []) {
    h.store.signingRequestRecipients.push({
      recipientId: recipient.id as never,
      sourcePreparationRecipientId: null,
      name: recipient.name,
      email: recipient.email,
      normalizedEmail: recipient.email.toLocaleLowerCase("en-US"),
      organization: null,
      type: "signer",
      isRequired: true,
      orderIndex: 0,
      routingOrder: 1,
    } as never);
    h.store.snapshotOwners.set(recipient.id, spec.id as never);
  }
}

/** The common case: a request the OWNER sent to Maria. */
const LEASE: RequestSpec = {
  id: "sreq_lease", title: "Office Lease", createdBy: OWNER,
  recipients: [{ id: "srr_maria", name: "Maria Santos", email: "maria@ayalaland.test" }],
};

let sequence = 0;

/** Pushes one evidence row straight into the store. Returns its id. */
function evidence(
  h: Harness, request: string, eventType: EvidenceEventType, at: number,
  recipientId?: string,
): string {
  const id = `ev_${String(++sequence).padStart(4, "0")}`;
  h.store.evidence.push({
    evidenceEventId: id as never,
    workspaceId: h.workspaceId,
    signingRequestId: request as never,
    ...(recipientId === undefined ? {} : { recipientId: recipientId as never }),
    eventType,
    eventVersion: 1,
    actor: recipientId === undefined
      ? { type: "system" }
      : { type: "recipient", actorId: recipientId as never },
    occurredAt: at,
    recordedAt: at,
  } as never);
  return id;
}

const read = (
  h: Harness,
  options: { limit?: number; scope?: DocumentFeedScope; as?: UserId } = {},
) => getDocumentNotifications({
  actor: actor(options.as ?? OWNER),
  workspaceId: h.workspaceId,
  ...(options.limit === undefined ? {} : { limit: options.limit }),
  ...(options.scope === undefined ? {} : { scope: options.scope }),
}, h.deps);

describe("what reaches the feed", () => {
  it("reports a participant declining — the outcome that ends the request", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "participant-declined", AT + 1000, "srr_maria");

    const feed = await read(h);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe("Participant declined");
    expect(feed[0]?.severity).toBe("critical");
    expect(feed[0]?.actionRequired).toBe(true);
    // Named from the snapshot, both of them.
    expect(feed[0]?.documentTitle).toBe("Office Lease");
    expect(feed[0]?.recipientName).toBe("Maria Santos");
  });

  it("stays quiet about page views, consent and the completion pipeline", async () => {
    // The whole point of a narrower set than the audit timeline: a sender
    // interrupted for every page view stops reading the feed.
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "document-viewed", AT + 1000, "srr_maria");
    evidence(h, LEASE.id, "consent-accepted", AT + 2000, "srr_maria");
    evidence(h, LEASE.id, "authentication-completed", AT + 3000, "srr_maria");
    evidence(h, LEASE.id, "submission-accepted", AT + 4000, "srr_maria");
    evidence(h, LEASE.id, "field-merge-completed", AT + 5000);
    evidence(h, LEASE.id, "certificate-generated", AT + 6000);
    evidence(h, LEASE.id, "final-seal-completed", AT + 7000);
    evidence(h, LEASE.id, "document-sealed", AT + 8000);
    // The one thing the person being notified just did themselves.
    evidence(h, LEASE.id, "transaction-created", AT + 9000);

    expect(await read(h)).toEqual([]);
  });

  it("is empty for a workspace nothing has happened in", async () => {
    const h = await harness();
    expect(await read(h)).toEqual([]);
  });
});

describe("one row per document (071)", () => {
  it("collapses a document's whole history into its current state", async () => {
    // The shape of the report that prompted this: a completed document is
    // sent, activated, signed and completed — four events, one document.
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    evidence(h, LEASE.id, "recipient-activated", AT + 1001, "srr_maria");
    evidence(h, LEASE.id, "signature-completed", AT + 2000, "srr_maria");
    evidence(h, LEASE.id, "transaction-completed", AT + 3000);

    const feed = await read(h);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe("Fully signed");
  });

  it("three completed documents are three notifications, not twelve", async () => {
    const h = await harness();
    for (const n of [1, 2, 3]) {
      const id = `sreq_${String(n)}`;
      addRequest(h, { id, title: `Contract ${String(n)}`, createdBy: OWNER });
      evidence(h, id, "transaction-sent", AT + n * 100);
      evidence(h, id, "recipient-activated", AT + n * 100 + 1);
      evidence(h, id, "signature-completed", AT + n * 100 + 2);
      evidence(h, id, "transaction-completed", AT + n * 100 + 3);
    }

    const feed = await read(h);

    expect(feed).toHaveLength(3);
    expect(feed.every(row => row.title === "Fully signed")).toBe(true);
  });

  it("at the same instant, whose turn it is outranks the send", async () => {
    // One send writes both, in the same transaction, at the same instant.
    // Chosen by event id, this document could read "Sent for signing" while
    // it is actually waiting on somebody.
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "recipient-activated", AT + 1000, "srr_maria");
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);

    expect((await read(h))[0]?.title).toBe("Waiting on a participant");
  });

  it("at the same instant, a terminal outcome outranks a participant's act", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-completed", AT + 1000);
    evidence(h, LEASE.id, "signature-completed", AT + 1000, "srr_maria");

    expect((await read(h))[0]?.title).toBe("Fully signed");
  });

  it("orders documents newest first and honours the limit", async () => {
    const h = await harness();
    for (const n of [1, 2, 3]) {
      const id = `sreq_${String(n)}`;
      addRequest(h, { id, title: `Contract ${String(n)}`, createdBy: OWNER });
      evidence(h, id, "transaction-sent", AT + n * 1000);
    }

    const feed = await read(h, { limit: 2 });

    expect(feed.map(row => row.documentTitle)).toEqual(["Contract 3", "Contract 2"]);
  });

  it("clamps an absurd limit rather than reading unbounded", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "signature-completed", AT + 1000, "srr_maria");

    // Not a throw: a caller asking for too much gets the maximum, the same
    // way every other paginated read in this codebase behaves.
    expect(await read(h, { limit: MAX_FEED_LIMIT + 5_000 })).toHaveLength(1);
  });
});

describe("scope (071)", () => {
  async function mixed(): Promise<Harness> {
    const h = await harness();
    // Mine: I sent it.
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    // Not mine: a colleague sent it to somebody else.
    addRequest(h, {
      id: "sreq_other", title: "Colleague's NDA", createdBy: COLLEAGUE,
      recipients: [{ id: "srr_ben", name: "Ben Cruz", email: "ben@vendor.test" }],
    });
    evidence(h, "sreq_other", "transaction-sent", AT + 2000);
    // Mine: a colleague sent it, and I am a participant — addressed in a
    // different case than my account stores it.
    addRequest(h, {
      id: "sreq_for_me", title: "Board Resolution", createdBy: COLLEAGUE,
      recipients: [{ id: "srr_me", name: "Me", email: "owner@acme.TEST" }],
    });
    evidence(h, "sreq_for_me", "recipient-activated", AT + 3000, "srr_me");
    return h;
  }

  it("defaults to `mine`: documents I sent, and ones I must act on", async () => {
    const h = await mixed();

    const titles = (await read(h)).map(row => row.documentTitle);

    expect(titles).toEqual(["Board Resolution", "Office Lease"]);
  });

  it("`workspace` shows every document the reader may view", async () => {
    const h = await mixed();

    const titles = (await read(h, { scope: "workspace" })).map(row => row.documentTitle);

    expect(titles).toEqual(["Board Resolution", "Colleague's NDA", "Office Lease"]);
  });

  it("`mine` only ever narrows `workspace`", async () => {
    const h = await mixed();

    const mine = new Set((await read(h)).map(row => row.id));
    const all = new Set((await read(h, { scope: "workspace" })).map(row => row.id));

    for (const id of mine) expect(all.has(id)).toBe(true);
  });

  it("with no resolvable address, `mine` still means the documents I sent", async () => {
    const h = await mixed();
    const withoutEmail = { ...h, deps: { ...h.deps, accountEmailOf: () => Promise.resolve(null) } };

    const titles = (await read(withoutEmail)).map(row => row.documentTitle);

    expect(titles).toEqual(["Office Lease"]);
  });

  it("does not resolve an address for the `workspace` scope at all", async () => {
    const h = await mixed();
    let lookups = 0;
    const counting = {
      ...h,
      deps: {
        ...h.deps,
        accountEmailOf: () => { lookups++; return Promise.resolve(OWNER_EMAIL); },
      },
    };

    await read(counting, { scope: "workspace" });

    expect(lookups).toBe(0);
  });
});

describe("read state (071)", () => {
  const change = (
    h: Harness, ids: readonly string[],
    delta: { read?: boolean; dismissed?: boolean }, as: UserId = OWNER,
  ) => setDocumentNotificationState({
    actor: actor(as), workspaceId: h.workspaceId, ids, ...delta,
  }, { transactions: h.deps.transactions });
  const mark = async (h: Harness, ids: readonly string[]) => {
    const result = await change(h, ids, { read: true });
    return { marked: result.outcome === "updated" ? result.updated : -1 };
  };

  it("arrives unread, and stays read once marked — across reads", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);

    const before = await read(h);
    expect(before[0]?.read).toBe(false);

    const result = await mark(h, before.map(row => row.id));
    expect(result.marked).toBe(1);

    // A second, separate read — the thing #52 could not do.
    expect((await read(h))[0]?.read).toBe(true);
  });

  it("a new event on a read document makes it unread again", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    await mark(h, (await read(h)).map(row => row.id));

    evidence(h, LEASE.id, "signature-completed", AT + 2000, "srr_maria");

    const after = await read(h);
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe("Participant signed");
    expect(after[0]?.read).toBe(false);
  });

  it("marks unread again, and that too survives a new read", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    const ids = (await read(h)).map(row => row.id);

    await mark(h, ids);
    await change(h, ids, { read: false });
    expect((await read(h))[0]?.read).toBe(false);
  });

  it("dismisses and restores durably, keeping read state independent", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    const ids = (await read(h)).map(row => row.id);

    await change(h, ids, { read: true });
    await change(h, ids, { dismissed: true });
    let row = (await read(h))[0];
    expect(row?.dismissed).toBe(true);
    expect(row?.read).toBe(true);

    await change(h, ids, { dismissed: false });
    row = (await read(h))[0];
    expect(row?.dismissed).toBe(false);
    expect(row?.read).toBe(true);
  });

  it("refuses a change that names neither read nor dismissed", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    const ids = (await read(h)).map(row => row.id);
    expect((await change(h, ids, {})).outcome).toBe("empty-change");
  });

  it("skips an invented id instead of failing the rest", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    const [real] = (await read(h)).map(row => row.id);

    const result = await mark(h, ["ev_does_not_exist", real!]);

    expect(result.marked).toBe(1);
    expect(h.store.notificationStates).toHaveLength(1);
  });

  it("belongs to one reader: my reading does not clear a colleague's badge", async () => {
    const h = await harness();
    addRequest(h, LEASE);
    evidence(h, LEASE.id, "transaction-sent", AT + 1000);
    await mark(h, (await read(h)).map(row => row.id));

    const rows = h.store.notificationStates;
    expect(rows.every(row => row.userId === OWNER)).toBe(true);
    expect(rows.some(row => row.userId === COLLEAGUE)).toBe(false);
  });
});

describe("the vocabulary", () => {
  it("only names event types that actually exist", () => {
    // A typo here would silently mean "never notify", which is exactly the
    // bug this feed was built to fix.
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      expect(EVIDENCE_EVENT_TYPES).toContain(type);
    }
  });

  it("gives every notifiable type a presentation, not a generic fallback", async () => {
    // One document per type: the feed collapses a document's history, so
    // every type needs its own document to be seen.
    const h = await harness();
    let at = AT;
    for (const type of NOTIFIABLE_EVENT_TYPES) {
      at += 1000;
      const id = `sreq_${type}`;
      addRequest(h, { id, title: `Document for ${type}`, createdBy: OWNER });
      evidence(h, id, type, at);
    }

    const feed = await read(h, { limit: MAX_FEED_LIMIT });

    expect(feed).toHaveLength(NOTIFIABLE_EVENT_TYPES.length);
    for (const notification of feed) {
      expect(notification.title).not.toBe("");
      expect(notification.title).not.toBe("Notification");
      expect(notification.body).toContain("Document for");
    }
  });
});
