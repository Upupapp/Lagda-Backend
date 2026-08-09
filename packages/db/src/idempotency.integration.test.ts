// Idempotency against REAL PostgreSQL, with REAL concurrency.
//
// The central claim — "two simultaneous duplicates execute the mutation once" —
// is a claim about PostgreSQL's unique index and transaction visibility. A
// single-threaded fake proves nothing about it, so every concurrency test here
// uses genuinely independent transactions on separate connections, which is
// what two API instances look like to the database.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type {
  IdempotencyKeyDigest, IdempotencyRecordId, IdempotencyScope,
  RequestFingerprint, StoredResult,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createIdempotencyRepository } from "./repositories/idempotency.js";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";

const WS_A: IdempotencyScope = { type: "workspace", workspaceId: "ws_a" as WorkspaceId };
const WS_B: IdempotencyScope = { type: "workspace", workspaceId: "ws_b" as WorkspaceId };
const USER: IdempotencyScope = { type: "user", userId: "usr_a" as UserId };

const AT = Date.parse("2026-08-09T10:00:00.000Z");
const HOUR = 3_600_000;

const digest = (seed: string): IdempotencyKeyDigest =>
  seed.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "a") as IdempotencyKeyDigest;
const finger = (seed: string): RequestFingerprint =>
  seed.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "b") as RequestFingerprint;

const KEY = digest("c");
const FP = finger("d");

const result = (status = 201): StoredResult => ({
  version: 1, statusCode: status, body: { id: "res_1" },
});

describe.skipIf(!hasIntegrationDatabase())("idempotency on PostgreSQL", () => {
  let database: LagdaDatabase;

  beforeAll(async () => { database = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => { await database.db.deleteFrom("idempotency_records").execute(); });

  const repo = () => createIdempotencyRepository(database.db);

  const claim = (over: Partial<Parameters<ReturnType<typeof repo>["claim"]>[0]> = {}) => ({
    recordId: "idem_1" as IdempotencyRecordId,
    scope: WS_A,
    operation: "signingRequest.send" as const,
    keyDigest: KEY,
    requestFingerprint: FP,
    now: AT,
    expiresAt: AT + 24 * HOUR,
    ...over,
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it("claims a new key", async () => {
    expect(await repo().claim(claim())).toEqual({ kind: "claimed" });
  });

  it("replays a completed record for the same request", async () => {
    const repository = repo();
    await repository.claim(claim());
    await repository.complete("idem_1" as IdempotencyRecordId, result(), AT + 1000);

    const second = await repository.claim(claim({ recordId: "idem_2" as IdempotencyRecordId }));
    expect(second).toEqual({ kind: "completed", result: result() });
  });

  it("CONFLICTS when the same key carries a different request", async () => {
    const repository = repo();
    await repository.claim(claim());
    await repository.complete("idem_1" as IdempotencyRecordId, result(), AT + 1000);

    const second = await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId, requestFingerprint: finger("e"),
    }));
    // Neither executes nor replays. The first request's result belongs to it.
    expect(second).toEqual({ kind: "conflict" });
  });

  it("does not collide across workspaces", async () => {
    // The reason a raw key cannot be the identity: two tenants legitimately
    // generate the same UUID.
    const repository = repo();
    expect(await repository.claim(claim())).toEqual({ kind: "claimed" });
    expect(await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId, scope: WS_B,
    }))).toEqual({ kind: "claimed" });
  });

  it("does not collide across scope types", async () => {
    // A workspace ID and a user ID could be textually equal; the type prefix
    // keeps them apart.
    const repository = repo();
    expect(await repository.claim(claim())).toEqual({ kind: "claimed" });
    expect(await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId, scope: USER,
    }))).toEqual({ kind: "claimed" });
  });

  it("does not collide across operations", async () => {
    const repository = repo();
    expect(await repository.claim(claim())).toEqual({ kind: "claimed" });
    expect(await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId,
      operation: "workspace.invitation.create",
    }))).toEqual({ kind: "claimed" });
  });

  it("cannot be looked up by key alone across scopes", async () => {
    const repository = repo();
    await repository.claim(claim());
    await repository.complete("idem_1" as IdempotencyRecordId, result(), AT + 1000);

    // Workspace B knows the raw key and still gets nothing.
    expect(await repository.find(WS_B, "signingRequest.send", KEY)).toBeNull();
  });

  // ── Real concurrency ──────────────────────────────────────────────────────

  it("lets exactly ONE of two simultaneous claims win", async () => {
    // Two independent transactions on separate connections — what two API
    // instances look like to PostgreSQL.
    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const outcomes: string[] = [];

    const first = database.db.transaction().execute(async (trx) => {
      const outcome = await createIdempotencyRepository(trx).claim(claim());
      outcomes.push(`first:${outcome.kind}`);
      // Hold the transaction open so the second must contend with it.
      await firstHolds;
      await createIdempotencyRepository(trx)
        .complete("idem_1" as IdempotencyRecordId, result(), AT + 1000);
    });

    // Give the first transaction time to insert before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = database.db.transaction().execute(async (trx) => {
      // BLOCKS here on the unique index until the first commits or rolls back.
      // That block is the serialization this whole design relies on.
      const outcome = await createIdempotencyRepository(trx).claim(
        claim({ recordId: "idem_2" as IdempotencyRecordId }));
      outcomes.push(`second:${outcome.kind}`);
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(outcomes).toContain("first:claimed");
    // The second sees the COMPLETED record, not a second claim.
    expect(outcomes).toContain("second:completed");
  }, 20_000);

  it("frees the key when the first transaction ROLLS BACK", async () => {
    // The property that makes failures retryable without a lease or a recovery
    // job: the claim row dies with the transaction.
    await expect(
      database.db.transaction().execute(async (trx) => {
        await createIdempotencyRepository(trx).claim(claim());
        throw new Error("business mutation failed");
      }),
    ).rejects.toThrow("business mutation failed");

    // No poisoned row.
    expect(await repo().find(WS_A, "signingRequest.send", KEY)).toBeNull();
    expect(await repo().claim(claim())).toEqual({ kind: "claimed" });
  });

  it("commits the claim and the business write together", async () => {
    // The atomicity guarantee, using a real second table.
    await database.db.insertInto("workspaces").values({
      workspace_id: "ws_a", name: "A", owner_user_id: "usr_a", created_at: new Date(AT),
    }).execute();

    await database.db.transaction().execute(async (trx) => {
      await createIdempotencyRepository(trx).claim(claim());
      await trx.updateTable("workspaces").set({ name: "renamed" })
        .where("workspace_id", "=", "ws_a").execute();
      await createIdempotencyRepository(trx)
        .complete("idem_1" as IdempotencyRecordId, result(), AT + 1000);
    });

    const row = await database.db.selectFrom("workspaces").selectAll()
      .where("workspace_id", "=", "ws_a").executeTakeFirst();
    expect(row?.name).toBe("renamed");
    expect((await repo().find(WS_A, "signingRequest.send", KEY))?.state).toBe("completed");

    await database.db.deleteFrom("workspaces").where("workspace_id", "=", "ws_a").execute();
  });

  it("rolls back the business write when completion fails", async () => {
    await database.db.insertInto("workspaces").values({
      workspace_id: "ws_a", name: "A", owner_user_id: "usr_a", created_at: new Date(AT),
    }).execute();

    await expect(
      database.db.transaction().execute(async (trx) => {
        await createIdempotencyRepository(trx).claim(claim());
        await trx.updateTable("workspaces").set({ name: "renamed" })
          .where("workspace_id", "=", "ws_a").execute();
        throw new Error("failed after the write");
      }),
    ).rejects.toThrow();

    const row = await database.db.selectFrom("workspaces").selectAll()
      .where("workspace_id", "=", "ws_a").executeTakeFirst();
    // Neither the mutation nor the claim survived.
    expect(row?.name).toBe("A");
    expect(await repo().find(WS_A, "signingRequest.send", KEY)).toBeNull();

    await database.db.deleteFrom("workspaces").where("workspace_id", "=", "ws_a").execute();
  });

  // ── Expiry ────────────────────────────────────────────────────────────────

  it("reclaims an expired record in place", async () => {
    const repository = repo();
    await repository.claim(claim({ expiresAt: AT + 1000 }));
    await repository.complete("idem_1" as IdempotencyRecordId, result(), AT + 500);

    // Past retention: the same key is a NEW operation, not a replay.
    const outcome = await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId,
      now: AT + 2000, expiresAt: AT + 2000 + 24 * HOUR,
      requestFingerprint: finger("f"),
    }));

    expect(outcome).toEqual({ kind: "claimed" });
    const record = await repository.find(WS_A, "signingRequest.send", KEY);
    expect(record?.state).toBe("in-progress");
    // No stale replay data survives the reclaim.
    expect(record?.result).toBeUndefined();
  });

  it("does not treat an unexpired record as reclaimable", async () => {
    const repository = repo();
    await repository.claim(claim());
    await repository.complete("idem_1" as IdempotencyRecordId, result(), AT + 500);

    expect(await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId, now: AT + HOUR,
    }))).toEqual({ kind: "completed", result: result() });
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  it("deletes only expired rows", async () => {
    const repository = repo();
    await repository.claim(claim({ expiresAt: AT + 1000 }));
    await repository.claim(claim({
      recordId: "idem_2" as IdempotencyRecordId, keyDigest: digest("9"),
      expiresAt: AT + 48 * HOUR,
    }));

    const deleted = await repository.deleteExpired(AT + 2000, 100);

    expect(deleted).toBe(1);
    // The unexpired one survives — deleting it would let a duplicate execute.
    expect(await repository.find(WS_A, "signingRequest.send", digest("9"))).not.toBeNull();
  });

  it("bounds a cleanup batch", async () => {
    const repository = repo();
    for (let i = 0; i < 5; i += 1) {
      await repository.claim(claim({
        recordId: `idem_${String(i)}` as IdempotencyRecordId,
        keyDigest: digest(String(i)), expiresAt: AT + 1000,
      }));
    }
    // A cleanup job must not lock the table for an unbounded time.
    expect(await repository.deleteExpired(AT + 2000, 2)).toBe(2);
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  it("refuses a raw key in the digest column", async () => {
    await expect(
      database.db.insertInto("idempotency_records").values({
        record_id: "idem_raw", scope_type: "workspace", scope_key: "ws:a",
        operation: "signingRequest.send",
        key_digest: "a-raw-client-supplied-key-value",
        request_fingerprint: FP, state: "in-progress",
        expires_at: new Date(AT + HOUR),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("refuses a completed record with no stored result", async () => {
    // Without this, a bug could mark a row complete with nothing to replay and
    // every retry would return nothing.
    await expect(
      database.db.insertInto("idempotency_records").values({
        record_id: "idem_bad", scope_type: "workspace", scope_key: "ws:a",
        operation: "signingRequest.send", key_digest: digest("7"),
        request_fingerprint: FP, state: "completed",
        completed_at: new Date(AT), expires_at: new Date(AT + HOUR),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("refuses an implausible status code", async () => {
    await expect(
      database.db.insertInto("idempotency_records").values({
        record_id: "idem_bad2", scope_type: "workspace", scope_key: "ws:a",
        operation: "signingRequest.send", key_digest: digest("8"),
        request_fingerprint: FP, state: "completed", response_status: 999,
        response_body: "{}", response_version: 1,
        completed_at: new Date(AT), expires_at: new Date(AT + HOUR),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("stores no request body column at all", async () => {
    // Fingerprints, never plaintext input. There is nothing to leak.
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'idempotency_records'
    `.execute(database.db);
    const columns = rows.map(r => r.column_name);
    expect(columns).not.toContain("request_body");
    expect(columns).not.toContain("idempotency_key");
    expect(columns).toContain("request_fingerprint");
  });

  it("has no row level security, deliberately", async () => {
    // Mixed scope: a workspace-only policy would have to decide what a null
    // workspace means, and "unrestricted" is the dangerous answer.
    const { rows } = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'idempotency_records'
    `.execute(database.db);
    expect(rows[0]?.relrowsecurity).toBe(false);
  });
});
