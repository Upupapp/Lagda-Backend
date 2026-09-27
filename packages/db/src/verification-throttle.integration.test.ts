// 085. The Verify Document throttle on REAL PostgreSQL, as the runtime role:
// cooldown, rolling pair and verification caps, the exhausted-streak lockout,
// digest-only keys, concurrency, grants and the migration's down/up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { VerificationId } from "@lagda/contracts";
import { VERIFICATION_THROTTLE_RULES, type VerificationAccessThrottle } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createHash } from "node:crypto";
import { createVerificationAccessThrottle } from "./repositories/verification-throttle.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase,
} from "./testing/harness.js";

const T0 = Date.parse("2026-09-27T08:00:00.000Z");
const ID = "LAGDA-VER-2026-AAAAAAAAAA" as VerificationId;
const OTHER = "LAGDA-VER-2026-BBBBBBBBBB" as VerificationId;
const EMAIL = "maria@example.com";
const rules = VERIFICATION_THROTTLE_RULES;

/** Stand-ins for the API crypto's digests: any 64-hex value per pair. */
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const keysOf = (id: string, email: string) => ({
  pairKey: hex(`pair:${id}|${email}`), verificationKey: hex(`verification:${id}`),
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("verification throttle (085, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
  let throttle: VerificationAccessThrottle;

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
    throttle = createVerificationAccessThrottle(app.db);
  });

  const reserve = (now: number, email = EMAIL, id = ID) =>
    throttle.reserveCodeRequest({ keys: keysOf(id, email), now, rules });
  const wrong = (now: number, email = EMAIL) =>
    throttle.recordRedemption({ keys: keysOf(ID, email), now, success: false, rules });

  it("allows one code per pair per minute and says when the cooldown lifts", async () => {
    expect(await reserve(T0)).toEqual({ outcome: "allowed" });
    expect(await reserve(T0 + 30_000)).toEqual({
      outcome: "limited", reason: "cooldown", retryAt: T0 + 60_000,
    });
    // A refused request is not a row: the cooldown does not slide.
    expect(await reserve(T0 + 60_000)).toEqual({ outcome: "allowed" });
    // Another pair is independent.
    expect(await reserve(T0 + 60_000, "other@example.com")).toEqual({ outcome: "allowed" });
  });

  it("caps a pair at 10 per rolling 24 hours", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await reserve(T0 + i * 60_000)).outcome).toBe("allowed");
    }
    expect(await reserve(T0 + 10 * 60_000)).toEqual({
      outcome: "limited", reason: "pair-daily", retryAt: T0 + 86_400_000,
    });
    expect((await reserve(T0 + 86_400_000 + 1)).outcome).toBe("allowed");
  });

  it("caps a verification ID at 30 per rolling hour across emails", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await reserve(T0 + i, `p${i}@example.com`)).outcome).toBe("allowed");
    }
    expect(await reserve(T0 + 100, "late@example.com")).toEqual({
      outcome: "limited", reason: "verification-hourly", retryAt: T0 + 3_600_000,
    });
    expect((await reserve(T0 + 100, "late@example.com", OTHER)).outcome).toBe("allowed");
    expect((await reserve(T0 + 3_600_001, "late@example.com")).outcome).toBe("allowed");
  });

  it("locks the pair for an hour after 3 consecutive exhausted challenge windows", async () => {
    let now = T0;
    for (let round = 0; round < 3; round++) {
      expect((await reserve(now)).outcome).toBe("allowed");
      for (let i = 0; i < 7; i++) await wrong(now);
      now += 60_000;
    }
    expect(await reserve(now)).toEqual({
      outcome: "limited", reason: "lockout", retryAt: T0 + 120_000 + 3_600_000,
    });
    expect((await reserve(T0 + 120_000 + 3_600_000)).outcome).toBe("allowed");
    const { pairKey } = keysOf(ID, EMAIL);
    const row = await owner.db.selectFrom("verification_access_pair_states")
      .selectAll().where("pair_key", "=", pairKey).executeTakeFirstOrThrow();
    // The streak restarted when the lockout was set; the new window is fresh.
    expect(row.exhausted_streak).toBe(0);
    expect(row.attempts).toBe(0);
  });

  it("a success clears the streak", async () => {
    let now = T0;
    for (let round = 0; round < 2; round++) {
      await reserve(now);
      for (let i = 0; i < 5; i++) await wrong(now);
      now += 60_000;
    }
    await throttle.recordRedemption({ keys: keysOf(ID, EMAIL), now, success: true, rules });
    await reserve(now);
    for (let i = 0; i < 5; i++) await wrong(now);
    expect((await reserve(now + 60_000)).outcome).toBe("allowed");
  });

  it("serializes concurrent requests for one pair: exactly one beats the cooldown", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(T0)));
    expect(results.filter(r => r.outcome === "allowed")).toHaveLength(1);
  });

  it("stores only the digests it is handed, and the runtime role cannot truncate", async () => {
    await reserve(T0);
    await wrong(T0);
    const rows = await owner.db.selectFrom("verification_access_code_requests").selectAll().execute();
    const states = await owner.db.selectFrom("verification_access_pair_states").selectAll().execute();
    const dump = JSON.stringify({ rows, states });
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain(ID);
    for (const table of ["verification_access_code_requests", "verification_access_pair_states"]) {
      await expect(sql`truncate ${sql.table(table)}`.execute(app.db)).rejects.toThrow(/permission denied/u);
    }
  });

  it("purges rows past every window as it goes", async () => {
    await reserve(T0);
    await reserve(T0 + 86_400_000 + 5, "fresh@example.com");
    const left = await owner.db.selectFrom("verification_access_code_requests").selectAll().execute();
    expect(left).toHaveLength(1);
  });

  it("goes down when empty and back up", async () => {
    const reverted: string[] = [];
    while (!reverted.includes("085_verification_access_throttle")) {
      const down = await migrateDown(owner.db);
      expect(down.error).toBeUndefined();
      expect(down.applied).toHaveLength(1);
      reverted.push(...down.applied);
    }
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
       where tablename in ('verification_access_code_requests', 'verification_access_pair_states')
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
