// Profile photos (072) on real PostgreSQL, as the runtime role: bytes round
// trip unchanged, a second save REPLACES, and the database's own bounds
// refuse what the validator should already have refused.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { UserId } from "@lagda/contracts";
import type { LagdaDatabase } from "./client/index.js";
import { createUserAvatarRepository } from "./repositories/user-avatars.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const USER = "usr_avatar" as UserId;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("user avatars (runtime role)", () => {
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
  });

  const save = (bytes: Buffer, digest: string, width = 256) =>
    createUserAvatarRepository(app.db).save({
      userId: USER, bytes, width, height: width, digest, updatedAt: new Date(),
    });

  it("round-trips the bytes and reports the version", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await save(bytes, DIGEST_A);
    const repo = createUserAvatarRepository(app.db);
    expect((await repo.find(USER))?.bytes.equals(bytes)).toBe(true);
    expect(await repo.versionOf(USER)).toBe(DIGEST_A);
  });

  it("a second save replaces the first", async () => {
    await save(Buffer.from([1]), DIGEST_A);
    await save(Buffer.from([2]), DIGEST_B);
    expect(await createUserAvatarRepository(app.db).versionOf(USER)).toBe(DIGEST_B);
  });

  it("the database refuses an oversize image even if a caller skips the validator", async () => {
    await expect(save(Buffer.alloc(400 * 1024 + 1), DIGEST_A)).rejects.toThrow();
    await expect(save(Buffer.from([1]), DIGEST_A, 5000)).rejects.toThrow();
  });

  it("removes, and reports whether there was anything to remove", async () => {
    await save(Buffer.from([1]), DIGEST_A);
    const repo = createUserAvatarRepository(app.db);
    expect(await repo.remove(USER)).toBe(true);
    expect(await repo.remove(USER)).toBe(false);
    expect(await repo.find(USER)).toBeNull();
  });
});
