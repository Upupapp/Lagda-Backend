// Workspace invitations against REAL PostgreSQL, as the REAL RUNTIME ROLE.
//
// What only this file can prove: the credential RLS policy, the partial unique
// index, the conditional-update concurrency control, and that acceptance is one
// transaction. The unit suite exercises orchestration against fakes and cannot
// speak to any of it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  UserId, WorkspaceId, WorkspaceInvitationId,
} from "@lagda/contracts";
import { INVITATION_TTL_MS } from "@lagda/contracts";
import {
  CreateWorkspace, createWorkspaceInvitation, resendWorkspaceInvitation,
  revokeWorkspaceInvitation, acceptWorkspaceInvitation,
  getWorkspaceInvitationPreview, listMyWorkspaces,
  InvitationInvalidError, InvitationAccountMismatchError,
  AlreadyWorkspaceMemberError, InvitationAlreadyPendingError,
  assertNormalized,
  type InvitationDependencies, type AcceptInvitationDependencies,
  type AuthenticatedActor, type SessionId,
  type InvitationTokenFactory, type WorkspaceInvitationIdGenerator,
} from "@lagda/application";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawGlobalTransaction,
  type LagdaDatabase,
} from "@lagda/db";
import { createInvitationTokenFactory } from "@lagda/api";

const AT = Date.parse("2026-08-10T11:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const STRANGER = "usr_stranger" as UserId;

const OWNER_EMAIL = "owner@example.com";
const INVITEE_EMAIL = "invitee@example.com";
const STRANGER_EMAIL = "stranger@example.com";

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace invitations on PostgreSQL", () => {
  let owner: LagdaDatabase;
  /** The role the application actually runs as. Subject to RLS. */
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);
    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  let workspaceId: WorkspaceId;
  let tokens: InvitationTokenFactory;
  let issued: string[];
  let delivered: string[];
  let invitationIds: WorkspaceInvitationIdGenerator;
  /**
   * A DISTINCT id space from the one that created the workspace.
   *
   * Both are sequential fakes, so sharing a prefix would collide on the
   * membership primary key — which is a fixture problem masquerading as an
   * acceptance defect. Production ids are random and this does not arise.
   */
  let memberIds: { nextWorkspaceMemberId: () => never };

  /** The REAL token factory — 256-bit base64url, SHA-256 digest. */
  function realTokens(): InvitationTokenFactory {
    const factory = createInvitationTokenFactory();
    return {
      issue() {
        const result = factory.issue();
        issued.push(result.raw);
        return result;
      },
      digest: (submitted: string) => factory.digest(submitted),
    };
  }

  const deps = (over: Partial<InvitationDependencies> = {}): InvitationDependencies => ({
    transactions: createTransactionManager(app.db),
    clock: new FixedClock(AT),
    invitationIds,
    tokens,
    links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
    scheduleDelivery: (input) => {
      delivered.push(input.invitationId);
      return Promise.resolve();
    },
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT),
      policy: { retentionMs: 86_400_000 },
    },
    ...over,
  });

  const acceptDeps = (
    over: Partial<AcceptInvitationDependencies> = {},
  ): AcceptInvitationDependencies => ({
    transactions: createTransactionManager(app.db),
    clock: new FixedClock(AT),
    tokens,
    memberIds,
    // Reads the CURRENT canonical address from the account, exactly as
    // production does — not from a fixture map.
    currentNormalizedEmail: async (userId: UserId) => {
      const row = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("users").select("normalized_email")
          .where("user_id", "=", userId).executeTakeFirst());
      return row === undefined ? null : assertNormalized(row.normalized_email);
    },
    ...over,
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER, { email: OWNER_EMAIL });
    await seedUser(owner, INVITEE, { email: INVITEE_EMAIL });
    await seedUser(owner, STRANGER, { email: STRANGER_EMAIL });

    issued = [];
    delivered = [];
    tokens = realTokens();
    let nextInvitation = 1;
    invitationIds = {
      nextWorkspaceInvitationId: () =>
        `inv_${String(nextInvitation++)}` as WorkspaceInvitationId,
    };
    let nextMember = 1;
    memberIds = {
      nextWorkspaceMemberId: () => `mem_accept_${String(nextMember++)}` as never,
    };

    const created = await new CreateWorkspace({
      transactions: createTransactionManager(app.db),
      clock: new FixedClock(AT),
      workspaceIds: new SequentialWorkspaceIds(),
      memberIds: new SequentialMemberIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT),
        policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(OWNER), name: "Acme Legal" });
    workspaceId = created.workspaceId;
  });

  const invite = (email = INVITEE_EMAIL, role: "member" | "sender" = "member") =>
    createWorkspaceInvitation(
      { actor: actor(OWNER), workspaceId, email, role }, deps());

  const rows = () => withRawGlobalTransaction(owner, trx =>
    trx.selectFrom("workspace_invitations").selectAll().execute());

  // ── The precondition ──────────────────────────────────────────────────────

  it("runs as a role that is NOT superuser and cannot bypass RLS", async () => {
    const result = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'lagda_app'
    `.execute(owner.db);
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  // ── Credential storage ────────────────────────────────────────────────────

  describe("the credential", () => {
    it("stores a DIGEST and never the raw token", async () => {
      await invite();
      const raw = issued[0] ?? "";
      const stored = await rows();

      expect(stored).toHaveLength(1);
      expect(stored[0]?.token_digest).toMatch(/^[a-f0-9]{64}$/);
      // The raw token appears NOWHERE in the row. A database dump contains no
      // usable invitation credential.
      expect(JSON.stringify(stored[0])).not.toContain(raw);
    });

    it("carries 256 bits of entropy in a URL-safe encoding", async () => {
      await invite();
      const raw = issued[0] ?? "";
      expect(raw).toHaveLength(43);
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("refuses a second invitation with the same digest", async () => {
      // The unique index. Two invitations sharing a digest would make "which
      // invitation does this token address" ambiguous.
      await invite();
      const digest = (await rows())[0]?.token_digest ?? "";
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_invitations").values({
          invitation_id: "inv_clash", workspace_id: workspaceId,
          invitee_email: "other@example.com",
          invitee_normalized_email: "other@example.com",
          requested_role: "member", invited_by_user_id: OWNER,
          token_digest: digest,
          created_at: new Date(AT), expires_at: new Date(AT + 1000),
          accepted_at: null, accepted_by_user_id: null,
          revoked_at: null, declined_at: null, superseded_at: null,
        }).execute())).rejects.toThrow();
    });
  });

  // ── Constraints ───────────────────────────────────────────────────────────

  describe("constraints", () => {
    it("refuses an invitation that would grant OWNER", async () => {
      // Structural at the schema AND at the database. The route union cannot
      // express it; this proves the second layer independently.
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_invitations").values({
          invitation_id: "inv_owner", workspace_id: workspaceId,
          invitee_email: INVITEE_EMAIL, invitee_normalized_email: INVITEE_EMAIL,
          requested_role: "owner", invited_by_user_id: OWNER,
          token_digest: "b".repeat(64),
          created_at: new Date(AT), expires_at: new Date(AT + 1000),
          accepted_at: null, accepted_by_user_id: null,
          revoked_at: null, declined_at: null, superseded_at: null,
        }).execute())).rejects.toThrow();
    });

    it("refuses an un-normalized identity key", async () => {
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_invitations").values({
          invitation_id: "inv_case", workspace_id: workspaceId,
          invitee_email: "Mixed@Example.com",
          invitee_normalized_email: "Mixed@Example.com",
          requested_role: "member", invited_by_user_id: OWNER,
          token_digest: "c".repeat(64),
          created_at: new Date(AT), expires_at: new Date(AT + 1000),
          accepted_at: null, accepted_by_user_id: null,
          revoked_at: null, declined_at: null, superseded_at: null,
        }).execute())).rejects.toThrow();
    });

    it("refuses an acceptance timestamp with no accepter", async () => {
      await invite();
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.updateTable("workspace_invitations")
          .set({ accepted_at: new Date(AT) })
          .where("invitation_id", "=", "inv_1").execute())).rejects.toThrow();
    });

    it("permits at most ONE live invitation per workspace and address", async () => {
      await invite();
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_invitations").values({
          invitation_id: "inv_dupe", workspace_id: workspaceId,
          invitee_email: INVITEE_EMAIL, invitee_normalized_email: INVITEE_EMAIL,
          requested_role: "sender", invited_by_user_id: OWNER,
          token_digest: "d".repeat(64),
          created_at: new Date(AT), expires_at: new Date(AT + 1000),
          accepted_at: null, accepted_by_user_id: null,
          revoked_at: null, declined_at: null, superseded_at: null,
        }).execute())).rejects.toThrow();
    });

    it("frees the slot once the first is revoked", async () => {
      const first = await invite();
      await revokeWorkspaceInvitation(
        actor(OWNER), workspaceId, first.invitationId, deps());
      const second = await invite();
      expect(second.state).toBe("pending");
      expect(await rows()).toHaveLength(2);
    });

    it("refuses an invitation naming an account that does not exist", async () => {
      await expect(withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_invitations").values({
          invitation_id: "inv_ghost", workspace_id: workspaceId,
          invitee_email: INVITEE_EMAIL, invitee_normalized_email: INVITEE_EMAIL,
          requested_role: "member", invited_by_user_id: "usr_ghost",
          token_digest: "e".repeat(64),
          created_at: new Date(AT), expires_at: new Date(AT + 1000),
          accepted_at: null, accepted_by_user_id: null,
          revoked_at: null, declined_at: null, superseded_at: null,
        }).execute())).rejects.toThrow();
    });

    it("gives the runtime role no way to DELETE an invitation", async () => {
      // Revocation sets a timestamp. Invitation history is security history —
      // who was offered a tenant and whether they took it — and no statement
      // available to the application erases it.
      await invite();
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`
          .execute(trx);
        await trx.deleteFrom("workspace_invitations").execute();
      })).rejects.toThrow();
    });
  });

  // ── The credential RLS path ───────────────────────────────────────────────

  describe("credential lookup under RLS", () => {
    it("resolves exactly ONE invitation from its digest", async () => {
      await invite();
      const preview = await getWorkspaceInvitationPreview(issued[0] ?? "", acceptDeps());
      expect(preview.workspaceName).toBe("Acme Legal");
      expect(preview.role).toBe("member");
    });

    it("sees NOTHING with a digest context that matches no row", async () => {
      await invite();
      const seen = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.invitation_digest', ${"f".repeat(64)}, true)`
          .execute(trx);
        return trx.selectFrom("workspace_invitations").selectAll().execute();
      });
      expect(seen).toHaveLength(0);
    });

    it("CANNOT list invitations from the credential scope", async () => {
      // The whole security argument for the narrow path: equality on a UNIQUE
      // column matches at most one row, so this cannot enumerate a workspace
      // however the query is written.
      await invite();
      await invite("second@example.com");
      const digest = (await rows())[0]?.token_digest ?? "";

      const seen = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.invitation_digest', ${digest}, true)`
          .execute(trx);
        // No predicate at all — the query production cannot write.
        return trx.selectFrom("workspace_invitations").selectAll().execute();
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.token_digest).toBe(digest);
    });

    it("CANNOT write from the credential scope", async () => {
      // The policy is FOR SELECT. Tenant context is what permits a write, and
      // the credential scope has none until `enterWorkspace` establishes it.
      await invite();
      const digest = (await rows())[0]?.token_digest ?? "";

      const affected = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.invitation_digest', ${digest}, true)`
          .execute(trx);
        const result = await trx.updateTable("workspace_invitations")
          .set({ revoked_at: new Date(AT) }).executeTakeFirst();
        return Number(result.numUpdatedRows);
      });
      expect(affected).toBe(0);
    });

    it("sees nothing with NO context at all", async () => {
      await invite();
      const seen = await app.db.transaction().execute(trx =>
        trx.selectFrom("workspace_invitations").selectAll().execute());
      expect(seen).toHaveLength(0);
    });

    it("does not leak the digest context into the next pooled transaction", async () => {
      await invite();
      await getWorkspaceInvitationPreview(issued[0] ?? "", acceptDeps());
      const leaked = await app.db.transaction().execute(trx =>
        trx.selectFrom("workspace_invitations").selectAll().execute());
      expect(leaked).toHaveLength(0);
    });
  });

  // ── Tenant isolation on the management path ───────────────────────────────

  describe("management tenant isolation", () => {
    it("hides another workspace's invitations", async () => {
      await invite();
      const other = await new CreateWorkspace({
        transactions: createTransactionManager(app.db),
        clock: new FixedClock(AT),
        workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_other_owner" as never },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(STRANGER), name: "Other" });

      const seen = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${other.workspaceId}, true)`
          .execute(trx);
        return trx.selectFrom("workspace_invitations").selectAll().execute();
      });
      expect(seen).toHaveLength(0);
    });

    it("refuses a cross-tenant create", async () => {
      await expect(createWorkspaceInvitation({
        actor: actor(STRANGER), workspaceId, email: "x@example.com", role: "member",
      }, deps())).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    });
  });

  // ── Acceptance ────────────────────────────────────────────────────────────

  describe("acceptance", () => {
    it("creates the membership and consumes the invitation ATOMICALLY", async () => {
      await invite(INVITEE_EMAIL, "sender");
      const result = await acceptWorkspaceInvitation(
        actor(INVITEE), issued[0] ?? "", acceptDeps());

      expect(result.joined).toBe(true);
      const state = await withRawGlobalTransaction(owner, async trx => ({
        invitation: await trx.selectFrom("workspace_invitations").selectAll()
          .executeTakeFirst(),
        memberships: await trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", INVITEE).execute(),
      }));

      expect(state.invitation?.accepted_at).not.toBeNull();
      expect(state.invitation?.accepted_by_user_id).toBe(INVITEE);
      expect(state.memberships).toHaveLength(1);
      expect(state.memberships[0]?.role).toBe("sender");
    });

    it("leaves NEITHER change when the membership insert fails", async () => {
      // One transaction. The failure is real — a duplicate member id violates
      // the primary key inside the same transaction that consumed the
      // invitation.
      await invite();
      const collidingId = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").select("member_id")
          .executeTakeFirstOrThrow());

      await expect(acceptWorkspaceInvitation(
        actor(INVITEE), issued[0] ?? "",
        acceptDeps({
          memberIds: { nextWorkspaceMemberId: () => collidingId.member_id as never },
        }),
      )).rejects.toThrow();

      const after = await withRawGlobalTransaction(owner, async trx => ({
        invitation: await trx.selectFrom("workspace_invitations").selectAll()
          .executeTakeFirst(),
        memberships: await trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", INVITEE).execute(),
      }));

      // The invitation is still live — the consumption rolled back with the
      // insert, so the invitee can try again.
      expect(after.invitation?.accepted_at).toBeNull();
      expect(after.memberships).toHaveLength(0);
    });

    it("CONCURRENT acceptance of one token creates exactly one membership", async () => {
      // The conditional UPDATE is the serialization point: of two acceptances,
      // exactly one matches a live row.
      await invite();
      const token = issued[0] ?? "";

      const outcomes = await Promise.allSettled([
        acceptWorkspaceInvitation(actor(INVITEE), token, acceptDeps()),
        acceptWorkspaceInvitation(actor(INVITEE), token, acceptDeps()),
      ]);

      const memberships = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", INVITEE).execute());

      expect(memberships).toHaveLength(1);
      expect(outcomes.some(o => o.status === "fulfilled")).toBe(true);
    });

    it("refuses a signed-in account that is not the invitee", async () => {
      await invite();
      await expect(acceptWorkspaceInvitation(
        actor(STRANGER), issued[0] ?? "", acceptDeps()))
        .rejects.toBeInstanceOf(InvitationAccountMismatchError);

      const memberships = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", STRANGER).execute());
      expect(memberships).toHaveLength(0);
    });

    it("does not verify the invitee's email as a side effect", async () => {
      // §67. An invitation is an authorization offer, not an authentication
      // ceremony. Accepting one proves nothing about the mailbox to the
      // ACCOUNT system.
      await invite();
      await acceptWorkspaceInvitation(actor(INVITEE), issued[0] ?? "", acceptDeps());
      const account = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("users").selectAll()
          .where("user_id", "=", INVITEE).executeTakeFirst());
      expect(account?.email_verified_at).toBeNull();
    });

    it("makes the workspace immediately visible to the new member", async () => {
      await invite();
      expect(await listMyWorkspaces(
        INVITEE, { transactions: createTransactionManager(app.db) })).toHaveLength(0);

      await acceptWorkspaceInvitation(actor(INVITEE), issued[0] ?? "", acceptDeps());

      const mine = await listMyWorkspaces(
        INVITEE, { transactions: createTransactionManager(app.db) });
      expect(mine).toHaveLength(1);
      expect(mine[0]?.name).toBe("Acme Legal");
      // No session was reissued. Membership is authoritative, so the same
      // credential now reaches a workspace it could not reach a moment ago.
    });

    it("converges when the membership already exists", async () => {
      await invite();
      await withRawGlobalTransaction(owner, trx =>
        trx.insertInto("workspace_memberships").values({
          member_id: "mem_prior", workspace_id: workspaceId,
          user_id: INVITEE, role: "member", created_at: new Date(AT),
        }).execute());

      const result = await acceptWorkspaceInvitation(
        actor(INVITEE), issued[0] ?? "", acceptDeps());

      expect(result.joined).toBe(false);
      const memberships = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", INVITEE).execute());
      expect(memberships).toHaveLength(1);
      // The invitation is closed, so no live credential dangles for access that
      // already exists.
      const invitation = (await rows())[0];
      expect(invitation?.accepted_at).not.toBeNull();
    });
  });

  // ── Resend ────────────────────────────────────────────────────────────────

  describe("resend", () => {
    it("rotates the credential in place: old dead, new live, one row", async () => {
      const created = await invite();
      const oldToken = issued[0] ?? "";

      await resendWorkspaceInvitation({
        actor: actor(OWNER), workspaceId, invitationId: created.invitationId,
      }, deps());
      const newToken = issued[1] ?? "";

      await expect(getWorkspaceInvitationPreview(oldToken, acceptDeps()))
        .rejects.toBeInstanceOf(InvitationInvalidError);
      await expect(getWorkspaceInvitationPreview(newToken, acceptDeps()))
        .resolves.toMatchObject({ workspaceName: "Acme Legal" });
      expect(await rows()).toHaveLength(1);
    });

    it("PRESERVES the old credential when scheduling fails", async () => {
      const created = await invite();
      const oldToken = issued[0] ?? "";

      await expect(resendWorkspaceInvitation({
        actor: actor(OWNER), workspaceId, invitationId: created.invitationId,
      }, deps({
        scheduleDelivery: () => Promise.reject(new Error("queue unavailable")),
      }))).rejects.toThrow("queue unavailable");

      // The rotation rolled back with the failed scheduling. The invitee's
      // existing link still works — nobody is stranded.
      await expect(getWorkspaceInvitationPreview(oldToken, acceptDeps()))
        .resolves.toMatchObject({ workspaceName: "Acme Legal" });
    });

    it("extends expiry with the fresh credential", async () => {
      const created = await invite();
      const later = AT + 1000;
      await resendWorkspaceInvitation({
        actor: actor(OWNER), workspaceId, invitationId: created.invitationId,
      }, deps({ clock: { now: () => later } }));

      const row = (await rows())[0];
      expect(row?.expires_at.getTime()).toBe(later + INVITATION_TTL_MS);
    });
  });

  // ── Create-path guards ────────────────────────────────────────────────────

  describe("create guards", () => {
    it("refuses to invite someone who is already a member", async () => {
      await expect(invite(OWNER_EMAIL))
        .rejects.toBeInstanceOf(AlreadyWorkspaceMemberError);
      expect(await rows()).toHaveLength(0);
      expect(delivered).toHaveLength(0);
    });

    it("matches an existing member by CANONICAL address", async () => {
      // The owner registered as `owner@example.com`; inviting the mixed-case
      // form is the same mailbox and must be refused.
      await expect(invite("Owner@EXAMPLE.com"))
        .rejects.toBeInstanceOf(AlreadyWorkspaceMemberError);
    });

    it("refuses a duplicate pending invitation rather than resending", async () => {
      await invite();
      await expect(invite()).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
      expect(delivered).toHaveLength(1);
    });

    it("invites an address with no LAGDA account at all", async () => {
      // The pre-registration case. No user row, no placeholder membership.
      const summary = await invite("nobody@example.com");
      expect(summary.state).toBe("pending");
      const memberships = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(memberships).toHaveLength(1); // only the owner
    });
  });
});
