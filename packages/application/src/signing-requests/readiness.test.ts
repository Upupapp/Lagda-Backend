// The review state, tested with fakes.
//
// Two claims carry the weight. The state is OPTIONAL -- send still works
// straight from a draft, and a test suite that only exercised the new path
// would let a regression break every existing sender. And it is RETRACTABLE,
// which is what makes it safe for an assembler to enter: marking a request
// ready commits nobody to anything.

import { describe, it, expect } from "vitest";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId, SigningRequestState,
} from "@lagda/contracts";
import {
  markSigningRequestReadyToSend, returnSigningRequestToDraft,
  SigningRequestNotInExpectedStateError,
} from "./readiness.js";
import type { SigningRequestDependencies } from "./signing-requests.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecord,
} from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialSigningRequestIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-12T09:00:00.000Z");
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
    store, workspaceId: created.workspaceId,
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

function seed(h: Harness, state: SigningRequestState = "draft"): SigningRequestId {
  h.store.signingRequests.push({
    signingRequestId: REQUEST,
    workspaceId: h.workspaceId,
    documentId: "doc_1" as DocumentId,
    sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as PreparationId,
    sourcePreparationRevision: 1,
    state,
    completionReadyAt: null, expiresAt: null, completedAt: null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT,
  } satisfies SigningRequestRecord);
  return REQUEST;
}

const stateOf = (h: Harness): string | undefined =>
  h.store.signingRequests.find(r => r.signingRequestId === REQUEST)?.state;

describe("marking a request ready to send", () => {
  it("moves a draft into review, and back out again", async () => {
    const h = await harness();
    seed(h);

    const ready = await markSigningRequestReadyToSend({
      actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
    }, h.deps);
    expect(ready.state).toBe("ready-to-send");
    expect(stateOf(h)).toBe("ready-to-send");

    // RETRACTABLE, which is what makes it safe to enter: nothing was minted
    // and nobody was told.
    const back = await returnSigningRequestToDraft({
      actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
    }, h.deps);
    expect(back.state).toBe("draft");
    expect(stateOf(h)).toBe("draft");
  });

  it("refuses to mark anything that is not a draft", async () => {
    for (const state of ["ready-to-send", "sent", "completed", "cancelled"] as const) {
      const h = await harness();
      seed(h, state);
      await expect(markSigningRequestReadyToSend({
        actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
      }, h.deps)).rejects.toBeInstanceOf(SigningRequestNotInExpectedStateError);
      expect(stateOf(h)).toBe(state);
    }
  });

  /**
   * A SENT request is not retractable this way.
   *
   * `cancel` is the operation for that, and unlike this one it tells
   * recipients. Silently reopening a sent request would leave counterparties
   * holding a link to something the sender believes is a draft.
   */
  it("refuses to return anything but a review-state request to draft", async () => {
    for (const state of ["draft", "sent", "partially-completed", "completed"] as const) {
      const h = await harness();
      seed(h, state);
      await expect(returnSigningRequestToDraft({
        actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
      }, h.deps)).rejects.toBeInstanceOf(SigningRequestNotInExpectedStateError);
      expect(stateOf(h)).toBe(state);
    }
  });

  it("gives an absent request the hidden 404, not a state conflict", async () => {
    const h = await harness();
    await expect(markSigningRequestReadyToSend({
      actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("gives another tenant's request the same answer as an absent one", async () => {
    const h = await harness();
    h.store.signingRequests.push({
      signingRequestId: REQUEST,
      workspaceId: "ws_elsewhere" as WorkspaceId,
      documentId: "doc_1" as DocumentId,
      sourceArtifactId: "art_1" as ArtifactId,
      sourcePreparationId: "prep_1" as PreparationId,
      sourcePreparationRevision: 1, state: "draft",
      completionReadyAt: null, expiresAt: null, completedAt: null,
      terminatedAt: null, terminationReason: null, cancellationNote: null,
      documentTitle: "Theirs", createdByUserId: OWNER,
      createdAt: AT, updatedAt: AT,
    } satisfies SigningRequestRecord);

    await expect(markSigningRequestReadyToSend({
      actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: REQUEST,
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  /**
   * The ASSEMBLER's authority, not the releaser's.
   *
   * `signing-request.create` and `signing-request.send` have been separate
   * since BACKEND-33 precisely so an assistant can build what a partner
   * releases. An auditor holds neither.
   */
  it("refuses an auditor, who may read but not assemble", async () => {
    const h = await harness();
    seed(h);
    await expect(markSigningRequestReadyToSend({
      actor: actor(AUDITOR), workspaceId: h.workspaceId, signingRequestId: REQUEST,
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(stateOf(h)).toBe("draft");
  });
});
