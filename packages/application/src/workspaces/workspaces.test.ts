// Workspace lifecycle use cases, tested entirely with fakes.
//
// No database, no HTTP server, no network. If any of those were needed, the
// architecture would be wrong.
//
// What this suite proves and what it does NOT: it proves the ORCHESTRATION —
// what is validated, in what order, in how many transactions, from which
// identity. Atomicity here is the fake restoring a snapshot, which shows the use
// case does not proceed past a failure; that PostgreSQL rolls back is proved in
// workspace.integration.test.ts, and no assertion in this file may be read as
// evidence of it.

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceMemberId, IdempotencyKey,
} from "@lagda/contracts";
import { CreateWorkspace } from "./create-workspace.js";
import { GetWorkspaceMember } from "./get-workspace-member.js";
import { listMyWorkspaces } from "./list-my-workspaces.js";
import { getWorkspace, updateWorkspace } from "./get-workspace.js";
import {
  resolveWorkspaceAccess, requireWorkspaceAccess, requireCapability,
  type WorkspaceAccessContext,
} from "./workspace-access.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { TransactionManager } from "../common/ports/index.js";
import { IdempotencyConflictError } from "../idempotency/service.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, FailingTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const CREATED_AT = Date.parse("2026-08-09T05:00:00.000Z");
const OWNER = "usr_1" as UserId;
const OTHER = "usr_2" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user",
  userId,
  sessionId: "ses_fixture" as SessionId,
});

function build(transactions: TransactionManager) {
  return new CreateWorkspace({
    transactions,
    clock: new FixedClock(CREATED_AT),
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(CREATED_AT),
      policy: { retentionMs: 24 * 60 * 60 * 1000 },
    },
  });
}

describe("CreateWorkspace", () => {
  it("creates a workspace with its owner", async () => {
    const transactions = new FakeTransactionManager();
    const result = await build(transactions)
      .execute({ actor: actor(OWNER), name: "Northbridge Legal" });

    expect(result.workspaceId).toBe("ws_1");
    expect(result.role).toBe("owner");
    expect(transactions.store.workspaces.size).toBe(1);
    expect(transactions.store.memberships).toHaveLength(1);
    expect(transactions.store.memberships[0]?.role).toBe("owner");
  });

  it("takes the creator from the ACTOR, and has nowhere to put a supplied one", async () => {
    // §21. The membership's user is the authenticated caller. A request cannot
    // nominate someone else because `CreateWorkspaceInput` has no field for one
    // — this asserts the behaviour; the compiler enforces the absence.
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });
    expect(transactions.store.memberships[0]?.userId).toBe(OWNER);
  });

  it("takes time from the clock rather than the system", async () => {
    const result = await build(new FakeTransactionManager())
      .execute({ actor: actor(OWNER), name: "Acme" });
    expect(result.createdAt).toBe(CREATED_AT);
  });

  it("takes identity from the generator rather than inventing it", async () => {
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });
    expect(transactions.store.memberships[0]?.memberId).toBe("mem_1");
  });

  it("writes both records in ONE workspace-scoped transaction", async () => {
    // A workspace with no owner membership is unrecoverable — no endpoint could
    // ever reach it again. The unit of work is what guarantees both
    // repositories write through the same transaction.
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });

    expect(transactions.started).toBe(1);
    expect(transactions.committed).toBe(1);
    expect(transactions.scopes).toEqual(["ws_1"]);
  });

  it("binds the transaction to the NEW workspace, so RLS permits both rows", async () => {
    // §84. The ID is generated before the transaction opens, so tenant context
    // matches the rows about to be written. No global escape is needed to
    // create a tenant, and none is used.
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });
    expect(transactions.scopes).not.toContain("global");
  });

  it("surfaces a transaction failure and writes nothing", async () => {
    const failure = new Error("connection lost");
    await expect(
      build(new FailingTransactionManager(failure))
        .execute({ actor: actor(OWNER), name: "Acme" }),
    ).rejects.toThrow("connection lost");
  });

  it("rolls back the first write when the second fails", async () => {
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    await useCase.execute({ actor: actor(OWNER), name: "First" });

    // Same generator sequence would collide; force a failure mid-transaction.
    await expect(
      transactions.runForWorkspace("ws_x" as WorkspaceId, async uow => {
        await uow.workspaces.insert({
          workspaceId: "ws_x" as WorkspaceId, name: "Doomed", createdAt: CREATED_AT,
        });
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    expect(transactions.store.workspaces.has("ws_x")).toBe(false);
    expect(transactions.store.workspaces.has("ws_1")).toBe(true);
  });

  // ── Name validation ──────────────────────────────────────────────────────

  it("rejects an empty name before generating anything", async () => {
    const transactions = new FakeTransactionManager();
    await expect(
      build(transactions).execute({ actor: actor(OWNER), name: "   " }),
    ).rejects.toBeInstanceOf(ApplicationValidationError);

    // No transaction opened: cheap validation precedes irreversible work.
    expect(transactions.started).toBe(0);
  });

  it("trims the outside of a name and keeps the inside", async () => {
    const transactions = new FakeTransactionManager();
    const result = await build(transactions)
      .execute({ actor: actor(OWNER), name: "  Reyes  &  Co.  " });
    // Interior spacing is the customer's. Only the paste artefact goes.
    expect(result.name).toBe("Reyes  &  Co.");
  });

  it("accepts Unicode business names", async () => {
    // An ASCII allowlist would reject a large share of this product's own
    // Philippine customers, and punctuation rejection is not an XSS defence.
    for (const name of ["Sánchez & Co.", "株式会社ラグダ", "Bayanihan Legal — Ilocos"]) {
      const result = await build(new FakeTransactionManager())
        .execute({ actor: actor(OWNER), name });
      expect(result.name).toBe(name);
    }
  });

  it("rejects control characters in a name", async () => {
    await expect(
      build(new FakeTransactionManager())
        .execute({ actor: actor(OWNER), name: "Acme\u0000Corp" }),
    ).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("rejects a name beyond the bound, counted in code points", async () => {
    // 201 emoji is 402 UTF-16 units and 201 characters. Counting `.length`
    // would reject a 100-character name written in a supplementary plane.
    await expect(
      build(new FakeTransactionManager())
        .execute({ actor: actor(OWNER), name: "😀".repeat(201) }),
    ).rejects.toBeInstanceOf(ApplicationValidationError);

    const ok = await build(new FakeTransactionManager())
      .execute({ actor: actor(OWNER), name: "😀".repeat(200) });
    expect([...ok.name]).toHaveLength(200);
  });

  it("allows two users to create workspaces with the same name", async () => {
    // §8. Names are not globally unique and must not be: a constraint would
    // tell every customer which names their competitors had taken.
    const store = new InMemoryStore();
    const transactions = new FakeTransactionManager(store);
    const useCase = build(transactions);

    await useCase.execute({ actor: actor(OWNER), name: "Legal" });
    await useCase.execute({ actor: actor(OTHER), name: "Legal" });

    expect(store.workspaces.size).toBe(2);
  });

  it("carries no HTTP semantics in its errors", async () => {
    try {
      await build(new FakeTransactionManager()).execute({ actor: actor(OWNER), name: "" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const applicationError = error as ApplicationValidationError;
      expect(applicationError.category).toBe("validation");
      expect(applicationError).not.toHaveProperty("statusCode");
    }
  });

  it("names the rule and never echoes the submitted value", async () => {
    // API_CONVENTIONS §3: details never echo the input. A name is business data.
    const secret = "Project Everest acquisition";
    try {
      await build(new FakeTransactionManager())
        .execute({ actor: actor(OWNER), name: `${secret}\u0007` });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it("creates ONE workspace when the same key and request arrive twice", async () => {
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    const key = "retry-key-0001" as IdempotencyKey;

    const first = await useCase.execute({
      actor: actor(OWNER), name: "Acme", idempotencyKey: key,
    });
    const second = await useCase.execute({
      actor: actor(OWNER), name: "Acme", idempotencyKey: key,
    });

    expect(transactions.store.workspaces.size).toBe(1);
    expect(transactions.store.memberships).toHaveLength(1);
    // The replay returns the FIRST workspace's identity, not a second one.
    expect(second.workspaceId).toBe(first.workspaceId);
  });

  it("treats whitespace-only differences as the SAME request", async () => {
    // The fingerprint is taken over the VALIDATED name, so a retry that differs
    // only in a trailing space replays rather than conflicting.
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    const key = "retry-key-0002" as IdempotencyKey;

    await useCase.execute({ actor: actor(OWNER), name: "Acme", idempotencyKey: key });
    await useCase.execute({ actor: actor(OWNER), name: " Acme ", idempotencyKey: key });

    expect(transactions.store.workspaces.size).toBe(1);
  });

  it("REFUSES the same key with a different name, and creates nothing", async () => {
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    const key = "retry-key-0003" as IdempotencyKey;

    await useCase.execute({ actor: actor(OWNER), name: "Acme", idempotencyKey: key });
    await expect(
      useCase.execute({ actor: actor(OWNER), name: "Different", idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(transactions.store.workspaces.size).toBe(1);
  });

  it("scopes keys per user, so two people may use the same key", async () => {
    const transactions = new FakeTransactionManager();
    const useCase = build(transactions);
    const key = "shared-key-0004" as IdempotencyKey;

    await useCase.execute({ actor: actor(OWNER), name: "Mine", idempotencyKey: key });
    await useCase.execute({ actor: actor(OTHER), name: "Theirs", idempotencyKey: key });

    // A raw key is not globally unique — two unrelated clients can both send
    // the same UUID, and neither should block the other.
    expect(transactions.store.workspaces.size).toBe(2);
  });
});

// ── Access resolution ───────────────────────────────────────────────────────

describe("workspace access", () => {
  const WS_A = "ws_a" as WorkspaceId;
  const WS_B = "ws_b" as WorkspaceId;

  function seeded() {
    const store = new InMemoryStore();
    store.workspaces.set(WS_A, { workspaceId: WS_A, name: "A", createdAt: CREATED_AT });
    store.workspaces.set(WS_B, { workspaceId: WS_B, name: "B", createdAt: CREATED_AT });
    store.memberships.push({
      memberId: "mem_a" as WorkspaceMemberId, workspaceId: WS_A,
      userId: OWNER, role: "owner", createdAt: CREATED_AT,
    });
    store.memberships.push({
      memberId: "mem_b" as WorkspaceMemberId, workspaceId: WS_B,
      userId: OTHER, role: "owner", createdAt: CREATED_AT,
    });
    return { store, deps: { transactions: new FakeTransactionManager(store) } };
  }

  it("resolves a membership the caller actually holds", async () => {
    const { deps } = seeded();
    const access = await resolveWorkspaceAccess(OWNER, WS_A, deps);
    expect(access?.role).toBe("owner");
    expect(access?.membershipId).toBe("mem_a");
  });

  it("resolves nothing for a workspace the caller is not a member of", async () => {
    const { deps } = seeded();
    expect(await resolveWorkspaceAccess(OWNER, WS_B, deps)).toBeNull();
  });

  it("resolves nothing for a workspace that does not exist", async () => {
    const { deps } = seeded();
    expect(await resolveWorkspaceAccess(OWNER, "ws_invented" as WorkspaceId, deps)).toBeNull();
  });

  it("hides a real workspace and a fictional one IDENTICALLY", async () => {
    // The anti-enumeration property. Any difference — code, message, or which
    // error type — would confirm that WS_B exists.
    const { deps } = seeded();
    const foreign = await requireWorkspaceAccess(OWNER, WS_B, deps).catch((e: unknown) => e);
    const absent = await requireWorkspaceAccess(
      OWNER, "ws_invented" as WorkspaceId, deps).catch((e: unknown) => e);

    expect(foreign).toBeInstanceOf(ResourceNotFoundError);
    expect((foreign as ResourceNotFoundError).code).toBe((absent as ResourceNotFoundError).code);
    expect((foreign as ResourceNotFoundError).message)
      .toBe((absent as ResourceNotFoundError).message);
  });

  it("refuses a non-manager the update capability", async () => {
    const { store, deps } = seeded();
    const reader = "usr_reader" as UserId;
    store.memberships.push({
      memberId: "mem_reader" as WorkspaceMemberId, workspaceId: WS_A,
      userId: reader, role: "reviewer", createdAt: CREATED_AT,
    });

    // A member, so plain access resolves.
    expect((await requireWorkspaceAccess(reader, WS_A, deps)).role).toBe("reviewer");
    // But `reviewer` does not hold `workspace.update` — BACKEND-27's policy.
    await expect(requireCapability(reader, WS_A, "workspace.update", deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reads the role from the membership, never from anything a caller supplies", async () => {
    const { store, deps } = seeded();
    const reader = "usr_reader" as UserId;
    store.memberships.push({
      memberId: "mem_reader" as WorkspaceMemberId, workspaceId: WS_A,
      userId: reader, role: "reviewer", createdAt: CREATED_AT,
    });

    const access: WorkspaceAccessContext = await requireWorkspaceAccess(reader, WS_A, deps);
    expect(access.role).toBe("reviewer");
    // Promoting the row is the ONLY way the answer changes.
    const row = store.memberships.find(m => m.memberId === "mem_reader");
    store.memberships[store.memberships.indexOf(row!)] = { ...row!, role: "owner" };
    expect((await requireCapability(reader, WS_A, "workspace.update", deps)).role)
      .toBe("owner");
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────

describe("listMyWorkspaces", () => {
  it("returns only the caller's workspaces, and does not filter in memory", async () => {
    const store = new InMemoryStore();
    const transactions = new FakeTransactionManager(store);
    const useCase = build(transactions);

    await useCase.execute({ actor: actor(OWNER), name: "Mine A" });
    await useCase.execute({ actor: actor(OTHER), name: "Theirs" });
    await useCase.execute({ actor: actor(OWNER), name: "Mine B" });

    const mine = await listMyWorkspaces(OWNER, { transactions });
    expect(mine).toHaveLength(2);
    expect(mine.map(w => w.name).sort()).toEqual(["Mine A", "Mine B"]);
  });

  it("uses a user-scoped transaction, never a tenant or global one", async () => {
    // §30/§88. A global scan followed by an in-memory filter is a security
    // control implemented over a result set that already holds every tenant.
    const transactions = new FakeTransactionManager();
    await listMyWorkspaces(OWNER, { transactions });
    expect(transactions.scopes).toEqual([OWNER]);
  });

  it("returns an empty list rather than failing for a user with none", async () => {
    const transactions = new FakeTransactionManager();
    expect(await listMyWorkspaces(OWNER, { transactions })).toEqual([]);
  });

  it("carries the caller's own role and nothing about other members", async () => {
    const transactions = new FakeTransactionManager();
    await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });

    const [summary] = await listMyWorkspaces(OWNER, { transactions });
    expect(summary?.role).toBe("owner");
    expect(summary).not.toHaveProperty("members");
    expect(summary).not.toHaveProperty("memberCount");
    expect(summary).not.toHaveProperty("ownerUserId");
    expect(summary).not.toHaveProperty("permissions");
  });
});

// ── Get and update ──────────────────────────────────────────────────────────

describe("getWorkspace / updateWorkspace", () => {
  async function withWorkspace() {
    const transactions = new FakeTransactionManager();
    const created = await build(transactions).execute({ actor: actor(OWNER), name: "Acme" });
    return { transactions, deps: { transactions }, id: created.workspaceId };
  }

  it("returns a workspace to its member", async () => {
    const { deps, id } = await withWorkspace();
    const detail = await getWorkspace(OWNER, id, deps);
    expect(detail.name).toBe("Acme");
    expect(detail.role).toBe("owner");
  });

  it("hides a workspace from a non-member with 404 semantics", async () => {
    const { deps, id } = await withWorkspace();
    await expect(getWorkspace(OTHER, id, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("returns no field a member should not see", async () => {
    const { deps, id } = await withWorkspace();
    const detail = await getWorkspace(OWNER, id, deps);
    for (const forbidden of [
      "ownerUserId", "storagePrefix", "plan", "billingEmail", "rlsContext", "dbRole",
      "members", "apiKey",
    ]) {
      expect(detail).not.toHaveProperty(forbidden);
    }
  });

  it("lets the owner rename it, and keeps the tenant identity", async () => {
    const { deps, id } = await withWorkspace();
    const result = await updateWorkspace(OWNER, id, { name: "Acme Legal" }, deps);

    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.workspace.name).toBe("Acme Legal");
    // §5. A rename does not create a new tenant.
    expect(result.workspace.workspaceId).toBe(id);
  });

  it("refuses a non-member, without confirming the workspace exists", async () => {
    const { deps, id } = await withWorkspace();
    await expect(updateWorkspace(OTHER, id, { name: "Hijacked" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    const detail = await getWorkspace(OWNER, id, deps);
    expect(detail.name).toBe("Acme");
  });

  it("refuses a member who is not an owner", async () => {
    const { transactions, deps, id } = await withWorkspace();
    const reader = "usr_reader" as UserId;
    transactions.store.memberships.push({
      memberId: "mem_reader" as WorkspaceMemberId, workspaceId: id,
      userId: reader, role: "reviewer", createdAt: CREATED_AT,
    });

    await expect(updateWorkspace(reader, id, { name: "Nope" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    // They can still READ it — the refusal is about management, not membership.
    expect((await getWorkspace(reader, id, deps)).name).toBe("Acme");
  });

  it("reports an invalid name without touching the stored one", async () => {
    const { deps, id } = await withWorkspace();
    const result = await updateWorkspace(OWNER, id, { name: "   " }, deps);
    expect(result.outcome).toBe("invalid");
    expect((await getWorkspace(OWNER, id, deps)).name).toBe("Acme");
  });

  it("checks authorization BEFORE validating the name", async () => {
    // Order matters: validating first would let a non-member learn that their
    // input was well-formed, which is a small but real oracle about the
    // endpoint's internals for a resource they cannot see.
    const { deps, id } = await withWorkspace();
    await expect(updateWorkspace(OTHER, id, { name: "" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── The pre-existing member read, rewired to access context ─────────────────

describe("GetWorkspaceMember", () => {
  const WORKSPACE_A = "ws_a" as WorkspaceId;
  const WORKSPACE_B = "ws_b" as WorkspaceId;
  const MEMBER_IN_B = "mem_b" as WorkspaceMemberId;

  const accessIn = (workspaceId: WorkspaceId): WorkspaceAccessContext => ({
    workspaceId,
    userId: OWNER,
    membershipId: "mem_actor" as WorkspaceMemberId,
    role: "owner",
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

  it("returns a member of the caller's own workspace", async () => {
    const { store, useCase } = seeded();
    const mine = "mem_a" as WorkspaceMemberId;
    store.memberships.push({
      memberId: mine, workspaceId: WORKSPACE_A,
      userId: OWNER, role: "owner", createdAt: CREATED_AT,
    });

    const result = await useCase.execute({ access: accessIn(WORKSPACE_A), memberId: mine });
    expect(result.memberId).toBe(mine);
    expect(result.workspaceId).toBe(WORKSPACE_A);
  });

  it("CANNOT read a member belonging to another workspace", async () => {
    const { useCase } = seeded();
    await expect(
      useCase.execute({ access: accessIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reports another workspace's member identically to one that does not exist", async () => {
    const { useCase } = seeded();
    const absent = "mem_nonexistent" as WorkspaceMemberId;

    const foreign = await useCase
      .execute({ access: accessIn(WORKSPACE_A), memberId: MEMBER_IN_B })
      .catch((e: unknown) => e);
    const missing = await useCase
      .execute({ access: accessIn(WORKSPACE_A), memberId: absent })
      .catch((e: unknown) => e);

    expect((foreign as ResourceNotFoundError).code)
      .toBe((missing as ResourceNotFoundError).code);
    expect((foreign as ResourceNotFoundError).message)
      .toBe((missing as ResourceNotFoundError).message);
  });

  it("scopes by the resolved access context, not by a caller-supplied workspace", async () => {
    const { useCase } = seeded();

    const inB = await useCase.execute({ access: accessIn(WORKSPACE_B), memberId: MEMBER_IN_B });
    expect(inB.workspaceId).toBe(WORKSPACE_B);

    await expect(
      useCase.execute({ access: accessIn(WORKSPACE_A), memberId: MEMBER_IN_B }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
