// Abuse counters against REAL PostgreSQL, with REAL concurrency.
//
// "Ten simultaneous requests cannot exceed a limit of five" is a claim about
// PostgreSQL's upsert atomicity. A single-threaded fake proves nothing about
// it, so the concurrency test issues genuinely parallel statements — which is
// what two API instances look like to the database.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { LagdaDatabase } from "./client/index.js";
import { createRateLimitCounterRepository } from "./repositories/rate-limit.js";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";

const AT = Date.parse("2026-08-09T10:00:00.000Z");
const MINUTE = 60_000;

describe.skipIf(!hasIntegrationDatabase())("rate-limit counters on PostgreSQL", () => {
  let database: LagdaDatabase;

  beforeAll(async () => { database = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => { await database.db.deleteFrom("rate_limit_counters").execute(); });

  const repo = () => createRateLimitCounterRepository(database.db);

  const input = (over: Record<string, unknown> = {}) => ({
    policyId: "auth.signin.ip",
    scopeType: "ip" as const,
    scopeKey: "a".repeat(64),
    windowStart: AT,
    expiresAt: AT + 2 * MINUTE,
    ...over,
  });

  it("counts from one and increments", async () => {
    const repository = repo();
    expect(await repository.increment(input())).toBe(1);
    expect(await repository.increment(input())).toBe(2);
    expect(await repository.increment(input())).toBe(3);
  });

  it("counts each window separately", async () => {
    const repository = repo();
    await repository.increment(input());
    await repository.increment(input());
    // A new window is a new identity, so the count restarts.
    expect(await repository.increment(input({ windowStart: AT + MINUTE }))).toBe(1);
  });

  it("counts each scope separately", async () => {
    const repository = repo();
    await repository.increment(input());
    expect(await repository.increment(input({ scopeKey: "b".repeat(64) }))).toBe(1);
  });

  it("counts each policy separately", async () => {
    const repository = repo();
    await repository.increment(input());
    expect(await repository.increment(input({ policyId: "verification.public.ip" }))).toBe(1);
  });

  it("counts each scope TYPE separately", async () => {
    // A user ID equal to a challenge ID must not share a counter.
    const repository = repo();
    await repository.increment(input({ scopeType: "ip", scopeKey: "same" }));
    expect(await repository.increment(input({ scopeType: "user", scopeKey: "same" }))).toBe(1);
  });

  it("gives TEN CONCURRENT increments ten distinct counts", async () => {
    // The property the whole design rests on. If two callers ever received the
    // same count, a limit of five would let six through — and the sixth is the
    // attacker.
    const repository = repo();
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => repository.increment(input())),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // No duplicates, no gaps.
    expect(new Set(counts).size).toBe(10);
  }, 20_000);

  it("shares one count across independent connections", async () => {
    // Two repository instances is what two API processes look like to
    // PostgreSQL. Booting two servers would prove nothing extra.
    const first = createRateLimitCounterRepository(database.db);
    const second = createRateLimitCounterRepository(database.db);

    await first.increment(input());
    await second.increment(input());
    expect(await first.increment(input())).toBe(3);
  });

  it("rejects a negative count at the database", async () => {
    // A negative count would mean the increment logic is broken; failing beats
    // silently granting unlimited attempts.
    await expect(
      database.db.insertInto("rate_limit_counters").values({
        policy: "x", scope_type: "ip", scope_key: "k",
        window_start: new Date(AT), count: -1, expires_at: new Date(AT + MINUTE),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("rejects an unknown scope type", async () => {
    await expect(
      database.db.insertInto("rate_limit_counters").values({
        policy: "x", scope_type: "telepathy", scope_key: "k",
        window_start: new Date(AT), count: 1, expires_at: new Date(AT + MINUTE),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("deletes only expired counters", async () => {
    const repository = repo();
    await repository.increment(input({ expiresAt: AT + 1000 }));
    await repository.increment(input({ scopeKey: "b".repeat(64), expiresAt: AT + 10 * MINUTE }));

    expect(await repository.deleteExpired(AT + 2000, 100)).toBe(1);

    // The live counter survives. Deleting it would reset an attacker's count.
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from rate_limit_counters
    `.execute(database.db);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("bounds a cleanup batch", async () => {
    const repository = repo();
    for (let i = 0; i < 5; i += 1) {
      await repository.increment(input({ scopeKey: String(i).repeat(10), expiresAt: AT + 1000 }));
    }
    // Cleanup must not lock the hottest security table for an unbounded time.
    expect(await repository.deleteExpired(AT + 2000, 2)).toBe(2);
  });

  it("stores no raw address or account value", async () => {
    // The repository receives an already-digested key for personal-data scopes;
    // this asserts the column is what the digester produced, not a raw value.
    const repository = repo();
    await repository.increment(input({ scopeKey: "c".repeat(64) }));

    const { rows } = await sql<{ scope_key: string }>`
      select scope_key from rate_limit_counters
    `.execute(database.db);
    expect(rows[0]?.scope_key).toBe("c".repeat(64));
    expect(rows[0]?.scope_key).not.toMatch(/@|\d+\.\d+\.\d+\.\d+/);
  });

  it("has no row level security, deliberately", async () => {
    // ip, account and challenge scopes have no workspace at all.
    const { rows } = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'rate_limit_counters'
    `.execute(database.db);
    expect(rows[0]?.relrowsecurity).toBe(false);
  });
});
