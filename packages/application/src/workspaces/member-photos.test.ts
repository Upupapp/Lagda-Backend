// Fellow members' photos: a member of a workspace sees the photos of its
// current members — nobody else's, and nobody outside sees any. And the
// activity log says who did each thing, so a reader can say "You".

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
} from "../test-support/fakes.js";
import { createIdempotencyKeyDigester, createIdempotencyRecordIds } from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "./create-workspace.js";
import { removeWorkspaceMember } from "./members.js";
import { listWorkspaceActivity } from "./activity.js";
import { listWorkspacePeople, canSeeMemberPhoto } from "./member-photos.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

const AT = Date.parse("2026-10-01T08:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ANA = "usr_ana" as UserId;
const OUTSIDER = "usr_outsider" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: `ses_${userId}` as SessionId });

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let workspaceId: WorkspaceId;

beforeEach(async () => {
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  store.accountEmails.set("owner@acme.test", OWNER);
  store.accountEmails.set("ana@acme.test", ANA);
  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT), workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });
  workspaceId = created.workspaceId;
  store.memberships.push({ memberId: "mem_ana" as never, workspaceId, userId: ANA, role: "member", createdAt: AT });
});

describe("fellow members' photos", () => {
  it("a member gets every current member", async () => {
    expect([...await listWorkspacePeople(ANA, workspaceId, { transactions })].sort()).toEqual([ANA, OWNER].sort());
  });

  it("someone outside gets the hidden 404", async () => {
    await expect(listWorkspacePeople(OUTSIDER, workspaceId, { transactions })).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await canSeeMemberPhoto(OUTSIDER, workspaceId, OWNER, { transactions })).toBe(false);
  });

  it("a member sees a fellow member's photo, not a non-member's", async () => {
    expect(await canSeeMemberPhoto(ANA, workspaceId, OWNER, { transactions })).toBe(true);
    expect(await canSeeMemberPhoto(ANA, workspaceId, OUTSIDER, { transactions })).toBe(false);
  });

  it("a removed member's photo is no longer served through the workspace", async () => {
    await removeWorkspaceMember(actor(OWNER), workspaceId, "mem_ana" as never, { transactions, clock: new FixedClock(AT) });
    expect(await canSeeMemberPhoto(OWNER, workspaceId, ANA, { transactions })).toBe(false);
  });
});

describe("the activity log says who did it", () => {
  it("each entry carries the actor's user id", async () => {
    const page = await listWorkspaceActivity(actor(OWNER), workspaceId, {}, { transactions });
    expect(page.events[0]).toMatchObject({ action: "workspace.created", actorUserId: OWNER });
  });
});
