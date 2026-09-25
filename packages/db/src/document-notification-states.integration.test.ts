// Notification read/dismissed state (071) on real PostgreSQL, as the runtime
// role. The fakes model the rules; this proves the SQL keeps them: the
// INSERT ... SELECT that skips invented ids, the ON CONFLICT update that
// leaves an unmentioned half of the state alone, and tenant isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { EvidenceEventId, SigningRequestId, WorkspaceUnitOfWork } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const USER = "usr_dns" as UserId;
const OTHER = "usr_dns_other" as UserId;
const WS_A = "ws_dns_a" as WorkspaceId;
const WS_B = "ws_dns_b" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("document notification states (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    await seedUser(owner, OTHER);
    const tx = createTransactionManager(owner.db);
    for (const [id, member] of [[WS_A, "mem_dns_a"], [WS_B, "mem_dns_b"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: id, createdAt: 0 });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: 0,
        });
        await uow.evidence.append({
          evidenceEventId: `ev_${id}` as EvidenceEventId,
          signingRequestId: `sreq_${id}` as SigningRequestId,
          eventType: "transaction-sent",
          eventVersion: 1,
          actor: { type: "system" },
          occurredAt: Date.parse("2026-09-25T10:00:00Z"),
        });
      });
    }
  });

  const inA = <T>(op: (uow: WorkspaceUnitOfWork) => Promise<T>): Promise<T> =>
    createTransactionManager(app.db).runForWorkspace(WS_A, op);

  it("writes, reads back, and leaves the unmentioned half alone", async () => {
    await inA(uow => uow.notificationStates.setState(USER, ["ev_ws_dns_a"], { read: true }));
    await inA(uow => uow.notificationStates.setState(USER, ["ev_ws_dns_a"], { dismissed: true }));

    const states = await inA(uow => uow.notificationStates.listStates(USER, ["ev_ws_dns_a"]));
    expect(states.get("ev_ws_dns_a")).toEqual({ read: true, dismissed: true });

    await inA(uow => uow.notificationStates.setState(USER, ["ev_ws_dns_a"], { read: false }));
    const after = await inA(uow => uow.notificationStates.listStates(USER, ["ev_ws_dns_a"]));
    expect(after.get("ev_ws_dns_a")).toEqual({ read: false, dismissed: true });
  });

  it("skips an invented id instead of failing the real one", async () => {
    const written = await inA(uow => uow.notificationStates.setState(
      USER, ["ev_invented", "ev_ws_dns_a"], { read: true }));
    expect(written).toBe(1);
  });

  it("cannot mark another workspace's event, even by naming it", async () => {
    const written = await inA(uow => uow.notificationStates.setState(
      USER, ["ev_ws_dns_b"], { read: true }));
    expect(written).toBe(0);
  });

  it("keeps one reader's state from another reader", async () => {
    await inA(uow => uow.notificationStates.setState(USER, ["ev_ws_dns_a"], { read: true }));
    const other = await inA(uow => uow.notificationStates.listStates(OTHER, ["ev_ws_dns_a"]));
    expect(other.size).toBe(0);
  });
});
