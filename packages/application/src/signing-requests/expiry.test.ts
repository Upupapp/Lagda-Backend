// Deadlines and the sweep, tested with fakes.
//
// The claim carrying the most weight is the RESCUE: the sweep reads the index
// outside the workspace transaction, so a request that is signed, cancelled or
// extended in between must not be expired by a decision taken before that
// happened. `expireIfDue` carries both conditions in its own statement, and the
// fake mirrors that predicate exactly -- a fake that checked only the id would
// let this pass while the real thing expired somebody's rescued contract.

import { describe, it, expect } from "vitest";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  setSigningRequestExpiry, expireDueSigningRequests,
  SigningRequestNotExpirableError, ExpiryNotInFutureError,
} from "./expiry.js";
import type { SigningRequestDependencies } from "./signing-requests.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecord,
} from "../common/ports/index.js";
import type { SigningRequestState } from "@lagda/contracts";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialSigningRequestIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-11T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const REQUEST = "sr_1" as SigningRequestId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: SigningRequestDependencies;
  readonly workspaceId: WorkspaceId;
  readonly clock: FixedClock;
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

  store.memberships.push({
    memberId: "mem_auditor" as WorkspaceMemberId, workspaceId: created.workspaceId,
    userId: AUDITOR, role: "auditor", createdAt: AT + 1000,
  });

  return {
    store, clock, workspaceId: created.workspaceId,
    deps: {
      transactions, clock,
      ids: new SequentialSigningRequestIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock, policy: { retentionMs: 86_400_000 },
      },
    },
  };
}

/** A request row in whatever state and with whatever deadline a test needs. */
function seedRequest(
  h: Harness,
  over: {
    id?: SigningRequestId;
    workspaceId?: WorkspaceId;
    state?: SigningRequestState;
    expiresAt?: number | null;
  } = {},
): SigningRequestId {
  const id = over.id ?? REQUEST;
  const record: SigningRequestRecord = {
    signingRequestId: id,
    workspaceId: over.workspaceId ?? h.workspaceId,
    documentId: "doc_1" as DocumentId,
    sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as PreparationId,
    sourcePreparationRevision: 1,
    state: over.state ?? "sent",
    completionReadyAt: null,
    expiresAt: over.expiresAt ?? null,
    completedAt: null,
    terminatedAt: null,
    terminationReason: null,
    cancellationNote: null,
    documentTitle: "Office Lease",
    createdByUserId: OWNER,
    createdAt: AT,
    updatedAt: AT,
  };
  h.store.signingRequests.push(record);
  return id;
}

const stateOf = (h: Harness, id: SigningRequestId): string | undefined =>
  h.store.signingRequests.find(r => r.signingRequestId === id)?.state;

describe("setting a deadline", () => {
  it("sets and clears one on a sent request", async () => {
    const h = await harness();
    seedRequest(h);

    const set = await setSigningRequestExpiry({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      signingRequestId: REQUEST, expiresAt: AT + DAY,
    }, h.deps);
    expect(set.expiresAt).toBe(AT + DAY);

    // NULL CLEARS IT. Not "leave it alone" -- there would be no way to remove a
    // deadline at all if null meant that.
    const cleared = await setSigningRequestExpiry({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      signingRequestId: REQUEST, expiresAt: null,
    }, h.deps);
    expect(cleared.expiresAt).toBeNull();
    expect(h.store.signingRequests[0]?.expiresAt).toBeNull();
  });

  /**
   * A past deadline is a typo, not an instruction to expire immediately.
   *
   * Accepting it would have the sweep expire the request seconds later, which
   * is a defensible reading and a terrible one: the user meant a date and got
   * a dead contract.
   */
  it("refuses a deadline in the past, writing nothing", async () => {
    const h = await harness();
    seedRequest(h);

    await expect(setSigningRequestExpiry({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      signingRequestId: REQUEST, expiresAt: AT - HOUR,
    }, h.deps)).rejects.toBeInstanceOf(ExpiryNotInFutureError);

    expect(h.store.signingRequests[0]?.expiresAt).toBeNull();
  });

  it("refuses one on a request no deadline can act on", async () => {
    const h = await harness();
    for (const state of ["draft", "completed", "cancelled", "declined"] as const) {
      const id = `sr_${state}` as SigningRequestId;
      seedRequest(h, { id, state });
      await expect(setSigningRequestExpiry({
        actor: actor(OWNER), workspaceId: h.workspaceId,
        signingRequestId: id, expiresAt: AT + DAY,
      }, h.deps)).rejects.toBeInstanceOf(SigningRequestNotExpirableError);
    }
  });

  it("gives an auditor the hidden 404 rather than a deadline", async () => {
    const h = await harness();
    seedRequest(h);
    await expect(setSigningRequestExpiry({
      actor: actor(AUDITOR), workspaceId: h.workspaceId,
      signingRequestId: REQUEST, expiresAt: AT + DAY,
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.signingRequests[0]?.expiresAt).toBeNull();
  });
});

describe("the sweep", () => {
  const sweep = (h: Harness, batchSize = 50) => expireDueSigningRequests({
    transactions: h.deps.transactions, clock: h.clock, policy: { batchSize },
  });

  it("expires what is due and leaves what is not", async () => {
    const h = await harness();
    const due   = seedRequest(h, { id: "sr_due" as SigningRequestId,   expiresAt: AT - HOUR });
    const later = seedRequest(h, { id: "sr_later" as SigningRequestId, expiresAt: AT + DAY });
    const never = seedRequest(h, { id: "sr_never" as SigningRequestId, expiresAt: null });

    const result = await sweep(h);

    expect(result.expired).toBe(1);
    expect(stateOf(h, due)).toBe("expired");
    expect(stateOf(h, later)).toBe("sent");
    expect(stateOf(h, never)).toBe("sent");
  });

  it("expires a partially-completed request too", async () => {
    const h = await harness();
    const id = seedRequest(h, {
      state: "partially-completed", expiresAt: AT - HOUR,
    });
    await sweep(h);
    expect(stateOf(h, id)).toBe("expired");
  });

  /**
   * A deadline that passes after the last signature does not un-sign anything.
   *
   * `completion-ready` means every obligation is met and only the document is
   * outstanding. Expiring it would discard signatures that were given in time.
   */
  it("never expires a request past the last signature", async () => {
    const h = await harness();
    const id = seedRequest(h, {
      state: "completion-ready", expiresAt: AT - DAY,
    });
    const result = await sweep(h);
    expect(result.examined).toBe(0);
    expect(stateOf(h, id)).toBe("completion-ready");
  });

  /**
   * THE RESCUE, tested where it actually happens.
   *
   * The sweep reads the index OUTSIDE the workspace transaction, so between
   * that read and the write a request may be signed, cancelled, or have its
   * deadline extended. `expireIfDue` carries both conditions in its own
   * statement for exactly this, and that is what is exercised here -- directly,
   * because going through the sweep would prove the wrong thing: this fake
   * derives its index from the rows, so a rescued request simply stops being
   * listed and `expireIfDue` is never reached.
   */
  it("refuses to expire a request that moved on after the index was read", async () => {
    const h = await harness();
    const id = seedRequest(h, { expiresAt: AT - HOUR });

    // The read the sweep would have done.
    const due = await h.deps.transactions.runGlobal(uow =>
      uow.signingRequestExpiryIndex.listDue({ now: AT, limit: 50 }));
    expect(due.map(ref => ref.signingRequestId)).toEqual([id]);

    // The rescue: the deadline is pushed out.
    const row = h.store.signingRequests.find(r => r.signingRequestId === id);
    if (row !== undefined) {
      h.store.signingRequests[h.store.signingRequests.indexOf(row)] =
        { ...row, expiresAt: AT + DAY };
    }

    // The write the sweep would now do, on its stale reference.
    const applied = await h.deps.transactions.runForWorkspace(h.workspaceId, uow =>
      uow.signingRequests.expireIfDue({ signingRequestId: id, now: AT }));

    expect(applied, "a rescued request must not be expired").toBe(false);
    expect(stateOf(h, id)).toBe("sent");
  });

  /** The same guard, against the other way a request moves on. */
  it("refuses to expire a request cancelled after the index was read", async () => {
    const h = await harness();
    const id = seedRequest(h, { expiresAt: AT - HOUR });

    const row = h.store.signingRequests.find(r => r.signingRequestId === id);
    if (row !== undefined) {
      h.store.signingRequests[h.store.signingRequests.indexOf(row)] =
        { ...row, state: "cancelled" };
    }

    const applied = await h.deps.transactions.runForWorkspace(h.workspaceId, uow =>
      uow.signingRequests.expireIfDue({ signingRequestId: id, now: AT }));

    expect(applied).toBe(false);
    expect(stateOf(h, id)).toBe("cancelled");
  });

  it("crosses workspaces, because a deadline does not wait for a visit", async () => {
    const h = await harness();
    const mine   = seedRequest(h, { id: "sr_mine" as SigningRequestId, expiresAt: AT - HOUR });
    const theirs = seedRequest(h, {
      id: "sr_theirs" as SigningRequestId,
      workspaceId: "ws_elsewhere" as WorkspaceId,
      expiresAt: AT - HOUR,
    });

    const result = await sweep(h);

    expect(result.examined).toBe(2);
    expect(stateOf(h, mine)).toBe("expired");
    expect(stateOf(h, theirs)).toBe("expired");
  });

  it("is bounded by the batch size, oldest deadline first", async () => {
    const h = await harness();
    seedRequest(h, { id: "sr_old" as SigningRequestId,    expiresAt: AT - 3 * DAY });
    seedRequest(h, { id: "sr_middle" as SigningRequestId, expiresAt: AT - 2 * DAY });
    seedRequest(h, { id: "sr_recent" as SigningRequestId, expiresAt: AT - HOUR });

    const result = await sweep(h, 2);

    expect(result.examined).toBe(2);
    // The longest overdue go first; an arbitrary order could starve one
    // request indefinitely while the batch size held.
    expect(stateOf(h, "sr_old" as SigningRequestId)).toBe("expired");
    expect(stateOf(h, "sr_middle" as SigningRequestId)).toBe("expired");
    expect(stateOf(h, "sr_recent" as SigningRequestId)).toBe("sent");
  });

  it("finds nothing to do, and says so without failing", async () => {
    const h = await harness();
    seedRequest(h, { expiresAt: AT + DAY });
    const result = await sweep(h);
    expect(result).toEqual({ examined: 0, expired: 0, skipped: 0, failed: 0 });
  });
});
