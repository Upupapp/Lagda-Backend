// Session persistence against REAL PostgreSQL.
//
// Every claim about uniqueness, constraints and privileges is a claim about the
// database, and only the database can be asked.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId } from "@lagda/contracts";
import type {
  NewSession, SessionId, TokenDigest,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createSessionRepository } from "./repositories/session.js";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";
import { truncateAccounts } from "./testing/harness.js";

const USER_A = "usr_a" as UserId;
const USER_B = "usr_b" as UserId;
const AT = Date.parse("2026-08-09T10:00:00.000Z");

const hash = (seed: string): TokenDigest =>
  seed.padEnd(64, "0").slice(0, 64).toLowerCase().replace(/[^a-f0-9]/g, "a") as TokenDigest;

const session = (over: Partial<NewSession> = {}): NewSession => ({
  sessionId: "ses_1" as SessionId,
  userId: USER_A,
  tokenHash: hash("aa1"),
  csrfTokenHash: hash("bb2"),
  createdAt: AT,
  expiresAt: AT + 7 * 24 * 3_600_000,
  ...over,
});

describe.skipIf(!hasIntegrationDatabase())("session persistence on PostgreSQL", () => {
  let database: LagdaDatabase;
  let repository: ReturnType<typeof createSessionRepository>;

  beforeAll(async () => {
    database = await createTestDatabase();
    repository = createSessionRepository(database.db);
  }, 60_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await truncateAccounts(database);

    // Sessions now carry a REAL foreign key to `users` (migration 008). Before
    // it existed these tests invented user ids freely; the constraint made that
    // impossible, which is the constraint working. Each user is created here so
    // the tests assert session behaviour rather than fighting referential
    // integrity.
    for (const userId of [USER_A, USER_B]) {
      await database.db.insertInto("users").values({
        user_id: userId,
        email: `${userId}@example.com`,
        normalized_email: `${userId}@example.com`,
        // A syntactically valid Argon2id string: the column has a CHECK
        // constraint requiring one, and this fixture is never verified against.
        password_hash: "$argon2id$v=19$m=19456,p=1,t=2$c2FsdHNhbHQ$aGFzaGhhc2g",
        display_name: userId,
        organization: null,
        intended_use: null,
        email_verified_at: null,
        terms_version: "2026-01-01",
        terms_accepted_at: new Date(0),
        created_at: new Date(0),
      }).execute();
    }
  });

  it("round-trips a session", async () => {
    await repository.create(session());
    const found = await repository.findByTokenHash(hash("aa1"));

    expect(found?.userId).toBe(USER_A);
    expect(found?.createdAt).toBe(AT);
    expect(found?.revokedAt).toBeUndefined();
    // last_seen_at is initialised to created_at, so the idle window starts now.
    expect(found?.lastSeenAt).toBe(AT);
  });

  it("returns null for an unknown digest", async () => {
    expect(await repository.findByTokenHash(hash("ff9"))).toBeNull();
  });

  it("refuses a duplicate token digest", async () => {
    // Cryptographic collision is improbable; a broken generator returning a
    // constant is not, and this is what catches it.
    await repository.create(session());
    await expect(
      repository.create(session({ sessionId: "ses_2" as SessionId })),
    ).rejects.toBeDefined();
  });

  it("REFUSES a raw token in the hash column", async () => {
    // The tripwire for the mistake that matters most. A base64url token is not
    // 64 lowercase hex characters, so the CHECK constraint rejects it.
    await expect(
      database.db.insertInto("user_sessions").values({
        session_id: "ses_raw", user_id: USER_A,
        token_hash: "ZmFrZS1yYXctdG9rZW4tdmFsdWUtaGVyZQ",
        csrf_token_hash: hash("cc3"),
        expires_at: new Date(AT + 1000),
      }).execute(),
    ).rejects.toBeDefined();
  });

  it("refuses a revocation without a reason", async () => {
    await repository.create(session());
    await expect(
      database.db.updateTable("user_sessions")
        .set({ revoked_at: new Date(AT) })
        .where("session_id", "=", "ses_1").execute(),
    ).rejects.toBeDefined();
  });

  it("refuses an unknown revocation reason", async () => {
    await repository.create(session());
    await expect(
      database.db.updateTable("user_sessions")
        .set({ revoked_at: new Date(AT), revocation_reason: "because" })
        .where("session_id", "=", "ses_1").execute(),
    ).rejects.toBeDefined();
  });

  it("revokes a session with its reason", async () => {
    await repository.create(session());
    await repository.revoke("ses_1" as SessionId, AT + 60_000, "logout");

    const found = await repository.findByTokenHash(hash("aa1"));
    expect(found?.revokedAt).toBe(AT + 60_000);
    expect(found?.revocationReason).toBe("logout");
  });

  it("does NOT overwrite an existing revocation", async () => {
    // A session killed by a password reset must not later read as an ordinary
    // logout — that would rewrite security history.
    await repository.create(session());
    await repository.revoke("ses_1" as SessionId, AT + 1000, "password-change");
    await repository.revoke("ses_1" as SessionId, AT + 2000, "logout");

    const found = await repository.findByTokenHash(hash("aa1"));
    expect(found?.revocationReason).toBe("password-change");
    expect(found?.revokedAt).toBe(AT + 1000);
  });

  it("keeps several sessions per user independent", async () => {
    await repository.create(session());
    await repository.create(session({
      sessionId: "ses_2" as SessionId, tokenHash: hash("dd4"), csrfTokenHash: hash("ee5"),
    }));

    await repository.revoke("ses_1" as SessionId, AT + 1000, "logout");

    expect((await repository.findByTokenHash(hash("aa1")))?.revokedAt).toBe(AT + 1000);
    // Revoking one device must not sign the user out everywhere.
    expect((await repository.findByTokenHash(hash("dd4")))?.revokedAt).toBeUndefined();
  });

  it("revokes every active session for one user only", async () => {
    await repository.create(session());
    await repository.create(session({
      sessionId: "ses_2" as SessionId, tokenHash: hash("dd4"), csrfTokenHash: hash("ee5"),
    }));
    await repository.create(session({
      sessionId: "ses_3" as SessionId, userId: USER_B,
      tokenHash: hash("ff6"), csrfTokenHash: hash("aa7"),
    }));

    const revoked = await repository.revokeAllForUser(USER_A, AT + 5000, "password-change");

    expect(revoked).toBe(2);
    // User B is untouched.
    expect((await repository.findByTokenHash(hash("ff6")))?.revokedAt).toBeUndefined();
  });

  it("counts only sessions that were still active", async () => {
    await repository.create(session());
    await repository.revoke("ses_1" as SessionId, AT + 1000, "logout");
    expect(await repository.revokeAllForUser(USER_A, AT + 5000, "security-action")).toBe(0);
  });

  it("slides last_seen_at without touching expiry", async () => {
    await repository.create(session());
    await repository.touch("ses_1" as SessionId, AT + 600_000);

    const found = await repository.findByTokenHash(hash("aa1"));
    expect(found?.lastSeenAt).toBe(AT + 600_000);
    expect(found?.expiresAt).toBe(AT + 7 * 24 * 3_600_000);
  });

  it("grants the runtime role what sessions need and nothing more", async () => {
    // UPDATE and DELETE are granted here, unlike the evidence tables: sessions
    // legitimately change, and expired rows must eventually be cleaned up.
    const { rows } = await sql<{ privilege_type: string }>`
      select privilege_type from information_schema.table_privileges
      where grantee = 'lagda_app' and table_name = 'user_sessions'
      order by privilege_type
    `.execute(database.db);

    expect(rows.map(r => r.privilege_type).sort())
      .toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("has NO row level security, deliberately", async () => {
    // Authentication happens before any workspace is known, so a tenant policy
    // could never be satisfied at the moment it is needed.
    const { rows } = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'user_sessions'
    `.execute(database.db);
    expect(rows[0]?.relrowsecurity).toBe(false);
  });

  it("has no workspace column", async () => {
    // A session identifies a user, never a workspace. If this ever fails,
    // someone has bound authentication to a tenant.
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'user_sessions'
    `.execute(database.db);
    expect(rows.map(r => r.column_name)).not.toContain("workspace_id");
  });

  it("indexes the token digest for lookup", () => {
    // Asserted STRUCTURALLY, not by reading a query plan. PostgreSQL prefers a
    // sequential scan on a tiny table regardless of indexes, so a plan
    // assertion on an empty test table proves nothing and fails for the wrong
    // reason — which is exactly what the first version of this test did.
    return sql<{ indexdef: string }>`
      select indexdef from pg_indexes where tablename = 'user_sessions'
    `.execute(database.db).then(({ rows }) => {
      const definitions = rows.map(r => r.indexdef).join(" ").toLowerCase();
      // Every authenticated request does this lookup.
      expect(definitions).toContain("token_hash");
      // Revoke-all-for-user and a future account-security screen.
      expect(definitions).toContain("user_id");
      // Cleanup of expired rows (BACKEND-16).
      expect(definitions).toContain("expires_at");
    });
  });
});
