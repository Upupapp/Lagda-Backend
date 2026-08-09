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
  FakeTransactionManager, FailingTransactionManager,
  InMemoryWorkspaceRepository, InMemoryMembershipRepository,
} from "../test-support/fakes.js";

const CREATED_AT = Date.parse("2026-08-09T05:00:00.000Z");
const OWNER = "usr_1" as UserId;

// Takes the PORT so either fake can be supplied. Tests that need to inspect a
// fake's counters keep their own reference rather than reading it back through
// a widened type.
function build(transactions: TransactionManager) {
  const workspaces = new InMemoryWorkspaceRepository();
  const memberships = new InMemoryMembershipRepository();
  const useCase = new CreateWorkspace({
    workspaces, memberships, transactions,
    clock: new FixedClock(CREATED_AT),
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
  });
  return { useCase, workspaces, memberships, transactions };
}

describe("CreateWorkspace", () => {
  it("creates a workspace with its owner", async () => {
    const { useCase, workspaces, memberships } = build(new FakeTransactionManager());

    const result = await useCase.execute({ ownerUserId: OWNER, name: "Northbridge Legal" });

    expect(result.workspaceId).toBe("ws_1");
    expect(result.name).toBe("Northbridge Legal");
    expect(workspaces.rows.size).toBe(1);
    expect(memberships.rows).toHaveLength(1);
    expect(memberships.rows[0]?.role).toBe("owner");
  });

  it("takes time from the clock rather than the system", async () => {
    // The evidence that no `Date.now()` is hidden inside the use case.
    const { useCase } = build(new FakeTransactionManager());
    const result = await useCase.execute({ ownerUserId: OWNER, name: "Acme" });
    expect(result.createdAt).toBe(CREATED_AT);
  });

  it("takes identity from the generator rather than inventing it", async () => {
    const { useCase, memberships } = build(new FakeTransactionManager());
    await useCase.execute({ ownerUserId: OWNER, name: "Acme" });
    expect(memberships.rows[0]?.memberId).toBe("mem_1");
  });

  it("writes the workspace and its owner in ONE transaction", async () => {
    // A workspace with no owner is unrecoverable — nobody could transfer
    // ownership or delete it. Both writes must share a transaction.
    const transactions = new FakeTransactionManager();
    const { useCase, workspaces, memberships } = build(transactions);

    await useCase.execute({ ownerUserId: OWNER, name: "Acme" });

    expect(transactions.started).toBe(1);
    expect(transactions.committed).toBe(1);
    expect(workspaces.writeContexts).toHaveLength(1);
    expect(memberships.writeContexts).toHaveLength(1);
    // The same transaction handle reached both repositories.
    expect(workspaces.writeContexts[0]).toBe(memberships.writeContexts[0]);
  });

  it("surfaces a transaction failure and writes nothing", async () => {
    const failure = new Error("connection lost");
    const { useCase, workspaces, memberships } = build(new FailingTransactionManager(failure));

    await expect(useCase.execute({ ownerUserId: OWNER, name: "Acme" }))
      .rejects.toThrow("connection lost");

    // The fake never runs the body, so nothing was persisted. This proves the
    // use case does not proceed past a failed transaction — NOT that PostgreSQL
    // rolls back, which needs a real database (BACKEND-08).
    expect(workspaces.rows.size).toBe(0);
    expect(memberships.rows).toHaveLength(0);
  });

  it("rejects an empty name before generating anything", async () => {
    const transactions = new FakeTransactionManager();
    const { useCase } = build(transactions);

    await expect(useCase.execute({ ownerUserId: OWNER, name: "   " }))
      .rejects.toBeInstanceOf(ApplicationValidationError);

    // No transaction was opened: cheap validation runs before irreversible work.
    expect(transactions.started).toBe(0);
  });

  it("carries no HTTP semantics in its errors", async () => {
    const { useCase } = build(new FakeTransactionManager());
    try {
      await useCase.execute({ ownerUserId: OWNER, name: "" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const applicationError = error as ApplicationValidationError;
      expect(applicationError.category).toBe("validation");
      // No status code anywhere — BACKEND-11 maps category to status.
      expect(applicationError).not.toHaveProperty("statusCode");
      expect(applicationError).not.toHaveProperty("status");
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
    const memberships = new InMemoryMembershipRepository();
    memberships.rows.push({
      memberId: MEMBER_IN_B,
      workspaceId: WORKSPACE_B,
      userId: "usr_b" as UserId,
      role: "sender",
      createdAt: CREATED_AT,
    });
    return {
      memberships,
      useCase: new GetWorkspaceMember(memberships, new FakeTransactionManager()),
    };
  }

  it("returns a member of the actor's own workspace", async () => {
    const { memberships, useCase } = seeded();
    const mine = "mem_a" as WorkspaceMemberId;
    memberships.rows.push({
      memberId: mine, workspaceId: WORKSPACE_A,
      userId: OWNER, role: "owner", createdAt: CREATED_AT,
    });

    const result = await useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: mine });
    expect(result.memberId).toBe(mine);
    expect(result.workspaceId).toBe(WORKSPACE_A);
  });

  it("CANNOT read a member belonging to another workspace", async () => {
    // The cross-tenant test. Workspace A asks for a member that exists — in
    // workspace B — and must not receive it.
    const { useCase } = seeded();

    await expect(
      useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reports another workspace's member identically to one that does not exist", async () => {
    // Anti-enumeration: if the two produced different outcomes, guessing IDs
    // would reveal which ones exist elsewhere.
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
    // The same member ID resolves in B and not in A — proof that scope comes
    // from the actor rather than from the request.
    const { useCase } = seeded();

    const inB = await useCase.execute({ actor: actorIn(WORKSPACE_B), memberId: MEMBER_IN_B });
    expect(inB.workspaceId).toBe(WORKSPACE_B);

    await expect(
      useCase.execute({ actor: actorIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
