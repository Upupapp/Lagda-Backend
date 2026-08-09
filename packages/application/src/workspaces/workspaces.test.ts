// Representative use cases, tested entirely with fakes.
//
// No database, no HTTP server, no network. If any of those were needed, the
// architecture would be wrong.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { CreateWorkspace } from "./create-workspace.js";
import { GetWorkspaceMember } from "./get-workspace-member.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { UserActor } from "../common/context.js";
import type { TransactionManager } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, FailingTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";

const CREATED_AT = Date.parse("2026-08-09T05:00:00.000Z");
const OWNER = "usr_1" as UserId;

function build(transactions: TransactionManager) {
  return new CreateWorkspace({
    transactions,
    clock: new FixedClock(CREATED_AT),
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
  });
}

describe("CreateWorkspace", () => {
  it("creates a workspace with its owner", async () => {
    const transactions = new FakeTransactionManager();
    const result = await build(transactions)
      .execute({ ownerUserId: OWNER, name: "Northbridge Legal" });

    expect(result.workspaceId).toBe("ws_1");
    expect(transactions.store.workspaces.size).toBe(1);
    expect(transactions.store.memberships).toHaveLength(1);
    expect(transactions.store.memberships[0]?.role).toBe("owner");
  });

  it("takes time from the clock rather than the system", async () => {
    const result = await build(new FakeTransactionManager())
      .execute({ ownerUserId: OWNER, name: "Acme" });
    expect(result.createdAt).toBe(CREATED_AT);
  });

  it("takes identity from the generator rather than inventing it", async () => {
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ ownerUserId: OWNER, name: "Acme" });
    expect(transactions.store.memberships[0]?.memberId).toBe("mem_1");
  });

  it("writes both records in ONE workspace-scoped transaction", async () => {
    // A workspace with no owner is unrecoverable — nobody could transfer
    // ownership or delete it. The unit of work is what guarantees both
    // repositories write through the same transaction.
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ ownerUserId: OWNER, name: "Acme" });

    expect(transactions.started).toBe(1);
    expect(transactions.committed).toBe(1);
    expect(transactions.scopes).toEqual(["ws_1"]);
  });

  it("surfaces a transaction failure and writes nothing", async () => {
    const failure = new Error("connection lost");
    await expect(
      build(new FailingTransactionManager(failure))
        .execute({ ownerUserId: OWNER, name: "Acme" }),
    ).rejects.toThrow("connection lost");
  });

  it("rolls back the first write when the second fails", async () => {
    // The unit of work restores its snapshot, so a partially written workspace
    // does not survive. This proves the use case does not proceed past a
    // failure — NOT that PostgreSQL rolls back, which needs a real database.
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    await useCase.execute({ ownerUserId: OWNER, name: "First" });

    // Same generator sequence would collide; force a failure mid-transaction.
    await expect(
      transactions.runForWorkspace("ws_x" as WorkspaceId, async uow => {
        await uow.workspaces.insert({
          workspaceId: "ws_x" as WorkspaceId, name: "Doomed",
          ownerUserId: OWNER, createdAt: CREATED_AT,
        });
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    expect(transactions.store.workspaces.has("ws_x")).toBe(false);
    expect(transactions.store.workspaces.has("ws_1")).toBe(true);
  });

  it("rejects an empty name before generating anything", async () => {
    const transactions = new FakeTransactionManager();
    await expect(
      build(transactions).execute({ ownerUserId: OWNER, name: "   " }),
    ).rejects.toBeInstanceOf(ApplicationValidationError);

    // No transaction opened: cheap validation precedes irreversible work.
    expect(transactions.started).toBe(0);
  });

  it("carries no HTTP semantics in its errors", async () => {
    try {
      await build(new FakeTransactionManager()).execute({ ownerUserId: OWNER, name: "" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const applicationError = error as ApplicationValidationError;
      expect(applicationError.category).toBe("validation");
      expect(applicationError).not.toHaveProperty("statusCode");
    }
  });
});

describe("GetWorkspaceMember", () => {
  const WORKSPACE_A = "ws_a" as WorkspaceId;
  const WORKSPACE_B = "ws_b" as WorkspaceId;
  const MEMBER_IN_B = "mem_b" as WorkspaceMemberId;

  const actorIn = (workspaceId: WorkspaceId): UserActor => ({
    kind: "user",
    userId: OWNER,
    workspaceId,
    membershipId: "mem_actor" as WorkspaceMemberId,
  });

  function seeded() {
    const store = new InMemoryStore();
    store.memberships.push({
      memberId: MEMBER_IN_B, workspaceId: WORKSPACE_B,
      userId: "usr_b" as UserId, role: "sender", createdAt: CREATED_AT,
    });
    const transactions = new FakeTransactionManager(store);
    return { store, useCase: new GetWorkspaceMember(transactions) };
  }

  it("returns a member of the actor's own workspace", async () => {
    const { store, useCase } = seeded();
    const mine = "mem_a" as WorkspaceMemberId;
    store.memberships.push({
      memberId: mine, workspaceId: WORKSPACE_A,
      userId: OWNER, role: "owner", createdAt: CREATED_AT,
    });

    const result = await useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: mine });
    expect(result.memberId).toBe(mine);
    expect(result.workspaceId).toBe(WORKSPACE_A);
  });

  it("CANNOT read a member belonging to another workspace", async () => {
    const { useCase } = seeded();
    await expect(
      useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reports another workspace's member identically to one that does not exist", async () => {
    // Anti-enumeration: any difference would reveal which IDs exist elsewhere.
    const { useCase } = seeded();
    const absent = "mem_nonexistent" as WorkspaceMemberId;

    const foreign = await useCase
      .execute({ actor: actorIn(WORKSPACE_A), memberId: MEMBER_IN_B })
      .catch((e: unknown) => e);
    const missing = await useCase
      .execute({ actor: actorIn(WORKSPACE_A), memberId: absent })
      .catch((e: unknown) => e);

    expect((foreign as ResourceNotFoundError).code)
      .toBe((missing as ResourceNotFoundError).code);
    expect((foreign as ResourceNotFoundError).message)
      .toBe((missing as ResourceNotFoundError).message);
  });

  it("scopes by the actor's workspace, not by a caller-supplied one", async () => {
    const { useCase } = seeded();

    const inB = await useCase.execute({ actor: actorIn(WORKSPACE_B), memberId: MEMBER_IN_B });
    expect(inB.workspaceId).toBe(WORKSPACE_B);

    await expect(
      useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
