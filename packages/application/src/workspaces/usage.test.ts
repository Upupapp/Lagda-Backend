// The usage summary: any member reads it, a stranger cannot tell the
// workspace exists, the period is the current UTC month, and the counts are
// the repository's own, for the caller's own workspace.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  fakeUsage,
} from "../test-support/fakes.js";
import { createIdempotencyKeyDigester, createIdempotencyRecordIds } from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "./create-workspace.js";
import { getWorkspaceUsage, currentUtcMonth } from "./usage.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

const AT = Date.parse("2026-09-26T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const MEMBER = "usr_member" as UserId;
const STRANGER = "usr_stranger" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: `ses_${userId}` as SessionId });

let store: InMemoryStore;
let deps: { transactions: FakeTransactionManager; clock: FixedClock };
let workspaceId: WorkspaceId;

beforeEach(async () => {
  fakeUsage.counts.clear();
  fakeUsage.queries.length = 0;
  store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  deps = { transactions, clock: new FixedClock(AT) };
  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT), workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });
  workspaceId = created.workspaceId;
  store.memberships.push(
    { memberId: "mem_member" as never, workspaceId, userId: MEMBER, role: "member", createdAt: AT },
  );
});

describe("the period", () => {
  it("is the current calendar month in UTC", () => {
    expect(currentUtcMonth(AT)).toEqual({
      start: Date.parse("2026-09-01T00:00:00.000Z"),
      endExclusive: Date.parse("2026-10-01T00:00:00.000Z"),
    });
  });

  it("rolls over the year in December", () => {
    expect(currentUtcMonth(Date.parse("2026-12-31T23:59:59.999Z"))).toEqual({
      start: Date.parse("2026-12-01T00:00:00.000Z"),
      endExclusive: Date.parse("2027-01-01T00:00:00.000Z"),
    });
  });

  it("follows UTC, not the host's zone, at a month boundary", () => {
    // 07:30 in Manila on 1 October is still 30 September in UTC.
    expect(currentUtcMonth(Date.parse("2026-09-30T23:30:00.000Z")).start)
      .toBe(Date.parse("2026-09-01T00:00:00.000Z"));
  });
});

describe("reading usage", () => {
  it("any member reads it, with an inclusive period end and the repository's counts", async () => {
    fakeUsage.counts.set(workspaceId, {
      documents: { total: 4, uploadedThisMonth: 2 },
      signingRequests: { sentThisMonth: 3, sentTotal: 5, inProgress: 2, completedThisMonth: 1, completedTotal: 2 },
      members: 2, templates: 1, contacts: 7, storageBytes: 12_345,
    });
    const view = await getWorkspaceUsage(actor(MEMBER), workspaceId, deps);
    expect(view).toEqual({
      period: {
        start: Date.parse("2026-09-01T00:00:00.000Z"),
        end: Date.parse("2026-10-01T00:00:00.000Z") - 1,
      },
      documents: { total: 4, uploadedThisMonth: 2 },
      signingRequests: { sentThisMonth: 3, sentTotal: 5, inProgress: 2, completedThisMonth: 1, completedTotal: 2 },
      members: 2, templates: 1, contacts: 7,
      verificationsThisMonth: 0,
      storageBytes: 12_345,
    });
    expect(fakeUsage.queries).toEqual([{
      workspaceId,
      query: {
        periodStart: Date.parse("2026-09-01T00:00:00.000Z"),
        periodEndExclusive: Date.parse("2026-10-01T00:00:00.000Z"),
        callerUserId: MEMBER,
      },
    }]);
  });

  it("hides the workspace from a non-member and counts nothing", async () => {
    await expect(getWorkspaceUsage(actor(STRANGER), workspaceId, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(fakeUsage.queries).toHaveLength(0);
  });
});
