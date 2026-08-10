// The invitation surface's HTTP contract, through the REAL `createApp`.
//
// The properties under test are the ones that only exist at the boundary:
// which routes require a session, which require CSRF, what the schemas refuse,
// and that the public preview route is public without the rest of the surface
// becoming so.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CSRF_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER, type UserId,
} from "@lagda/contracts";
import {
  createSessionService, assertNormalized,
  type SessionRepository, type SessionRecord, type NewSession,
  type InvitationDependencies, type AcceptInvitationDependencies,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies,
  type InvitationTokenFactory, type NormalizedEmail,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-08-10T12:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const OWNER_EMAIL = assertNormalized("owner@example.com");
const INVITEE_EMAIL = assertNormalized("invitee@example.com");

const config = (): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" });

function fakeSessionRepository(): SessionRepository {
  const rows = new Map<string, SessionRecord>();
  return {
    findByTokenHash: hash =>
      Promise.resolve([...rows.values()].find(r => r.tokenHash === hash) ?? null),
    create: (s: NewSession) => {
      rows.set(s.sessionId, { ...s, lastSeenAt: s.createdAt });
      return Promise.resolve();
    },
    touch: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    revokeAllForUser: () => Promise.resolve(0),
  };
}

/** Sequential and predictable, so a test can name the token it expects. */
function fakeTokens(): InvitationTokenFactory & { issued: string[] } {
  let next = 1;
  const issued: string[] = [];
  return {
    issued,
    issue() {
      const raw = `invtok_${String(next++).padStart(4, "0")}`;
      issued.push(raw);
      return { raw, digest: `digest-of-${raw}` as never };
    },
    digest: (submitted: string) =>
      submitted.startsWith("invtok_") ? (`digest-of-${submitted}` as never) : null,
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly transactions: FakeTransactionManager;
  readonly tokens: ReturnType<typeof fakeTokens>;
  readonly signIn: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
  readonly workspaceId: string;
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness(): Promise<Harness> {
  const sessions = createSessionService({
    sessions: fakeSessionRepository(),
    tokens: createSecurityTokenGenerator(),
    digester: createSecurityTokenDigester(),
    clock: { now: () => Date.now() },
    policy: {
      absoluteLifetimeMs: 7 * 24 * 3_600_000,
      idleTimeoutMs: 8 * 3_600_000,
      touchIntervalMs: 300_000,
    },
  });

  const transactions = new FakeTransactionManager();
  transactions.store.accountEmails.set(OWNER_EMAIL, OWNER);
  transactions.store.accountEmails.set(INVITEE_EMAIL, INVITEE);

  const tokens = fakeTokens();
  // ONE generator each, shared across requests — a fresh one per call would
  // hand every record the same id.
  const workspaceIds = new SequentialWorkspaceIds();
  const memberIds = new SequentialMemberIds();
  let nextInvitation = 1;
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIds(),
    clock: new FixedClock(AT),
    policy: { retentionMs: 86_400_000 },
  };

  const invitationDeps = (): InvitationDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    invitationIds: {
      nextWorkspaceInvitationId: () => `inv_${String(nextInvitation++)}` as never,
    },
    tokens,
    links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
    scheduleDelivery: () => Promise.resolve(),
    idempotency,
  });

  const acceptDeps = (): AcceptInvitationDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    tokens,
    memberIds,
    currentNormalizedEmail: (userId: UserId) => {
      for (const [email, id] of transactions.store.accountEmails) {
        if (id === userId) return Promise.resolve(email as NormalizedEmail);
      }
      return Promise.resolve(null);
    },
  });

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock: new FixedClock(AT), workspaceIds, memberIds, idempotency,
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        invitations: { management: invitationDeps, redemption: acceptDeps },
      },
    },
  });
  open = app;

  const signIn = async (userId: UserId) => {
    const issued = await sessions.issue(userId);
    return {
      cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
      csrf: issued.csrfToken,
    };
  };

  // A workspace owned by OWNER, created through the real route.
  const owner = await signIn(OWNER);
  const created = await app.inject({
    method: "POST", url: "/workspaces",
    headers: {
      cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf,
      [IDEMPOTENCY_KEY_HEADER]: "ws-setup-key-0001",
    },
    payload: { name: "Acme Legal" },
  });

  return {
    app, transactions, tokens, signIn,
    workspaceId: created.json<{ workspaceId: string }>().workspaceId,
  };
}

async function createInvite(
  h: Harness, auth: { cookie: string; csrf: string }, key: string,
  payload: Record<string, unknown> = { email: "invitee@example.com", role: "member" },
) {
  return h.app.inject({
    method: "POST", url: `/workspaces/${h.workspaceId}/invitations`,
    headers: {
      cookie: auth.cookie, [CSRF_TOKEN_HEADER]: auth.csrf,
      [IDEMPOTENCY_KEY_HEADER]: key,
    },
    payload,
  });
}

// ── Authentication and CSRF ─────────────────────────────────────────────────

describe("invitation routes — authentication and CSRF", () => {
  it("refuses every management route anonymously", async () => {
    const h = await harness();
    const base = `/workspaces/${h.workspaceId}/invitations`;
    for (const [method, url] of [
      ["POST", base],
      ["GET", base],
      ["POST", `${base}/inv_1/resend`],
      ["POST", `${base}/inv_1/revoke`],
    ] as const) {
      const response = await h.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("refuses accept and decline anonymously", async () => {
    const h = await harness();
    for (const url of ["/invitations/accept", "/invitations/decline"]) {
      const response = await h.app.inject({
        method: "POST", url, payload: { token: "invtok_0001" },
      });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("refuses a browser holding only a PRE-AUTH credential", async () => {
    // A half-finished MFA ceremony has proved a password and nothing more. The
    // pre-auth cookie has a different name and is scoped to `/auth`, so it
    // resolves no session here and the scope refuses the request before any
    // invitation is looked up.
    const h = await harness();
    const response = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: `lagda_pre_auth=${"P".repeat(43)}` },
      payload: { token: "invtok_0001" },
    });
    expect(response.statusCode).toBe(401);
    expect(h.transactions.store.memberships).toHaveLength(1);
  });

  it("refuses a create without CSRF, and writes nothing", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: `/workspaces/${h.workspaceId}/invitations`,
      headers: { cookie: owner.cookie, [IDEMPOTENCY_KEY_HEADER]: "csrf-key-000001" },
      payload: { email: "invitee@example.com", role: "member" },
    });
    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.invitations).toHaveLength(0);
  });

  it("refuses accept without CSRF, before any membership mutation", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "accept-csrf-00001");
    const invitee = await h.signIn(INVITEE);

    const response = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: invitee.cookie },
      payload: { token: h.tokens.issued[0] ?? "" },
    });

    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.memberships).toHaveLength(1);
  });

  it("keeps the PREVIEW route public", async () => {
    // The recipient may have no account at all, so the page has to work before
    // there is anything to authenticate.
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "preview-key-00001");

    const response = await h.app.inject({
      method: "POST", url: "/invitations/preview",
      payload: { token: h.tokens.issued[0] ?? "" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ workspaceName: string }>().workspaceName).toBe("Acme Legal");
  });

  it("makes the preview public WITHOUT making the rest of the surface public", async () => {
    const h = await harness();
    expect((await h.app.inject({
      method: "GET", url: `/workspaces/${h.workspaceId}/invitations`,
    })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

// ── Schema refusals ─────────────────────────────────────────────────────────

describe("invitation routes — what the schemas refuse", () => {
  it("REFUSES an invitation that would grant OWNER", async () => {
    // The literal is not in the union, so this fails validation before any
    // handler runs. Ownership is unexpressible, not merely rejected.
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const response = await createInvite(h, owner, "owner-key-0000001", {
      email: "invitee@example.com", role: "owner",
    });
    expect(response.statusCode).toBe(422);
    expect(h.transactions.store.invitations).toHaveLength(0);
  });

  it("REFUSES an unknown role", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const response = await createInvite(h, owner, "role-key-00000001", {
      email: "invitee@example.com", role: "superuser",
    });
    expect(response.statusCode).toBe(422);
  });

  it("REFUSES every privileged field a client might add", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const payloads = [
      { email: "a@example.com", role: "member", inviterUserId: INVITEE },
      { email: "a@example.com", role: "member", workspaceId: "ws_elsewhere" },
      { email: "a@example.com", role: "member", token: "invtok_0001" },
      { email: "a@example.com", role: "member", accepted: true },
      { email: "a@example.com", role: "member", acceptedAt: 1 },
      { email: "a@example.com", role: "member", membershipId: "mem_x" },
      { email: "a@example.com", role: "member", invitationId: "inv_x" },
      { email: "a@example.com", role: "member", expiresAt: 1 },
      { email: "a@example.com", role: "member", owner: true },
    ];
    for (const [index, payload] of payloads.entries()) {
      const response = await createInvite(
        h, owner, `field-key-${String(index).padStart(6, "0")}`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }
  });

  it("REFUSES a role on the accept body — the invitation is authoritative", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "tamper-key-000001");
    const invitee = await h.signIn(INVITEE);

    const response = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: invitee.cookie, [CSRF_TOKEN_HEADER]: invitee.csrf },
      payload: { token: h.tokens.issued[0] ?? "", role: "owner" },
    });

    expect(response.statusCode).toBe(422);
    expect(h.transactions.store.memberships).toHaveLength(1);
  });

  it("REFUSES a workspaceId on the accept body", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "wstamper-key-0001");
    const invitee = await h.signIn(INVITEE);

    const response = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: invitee.cookie, [CSRF_TOKEN_HEADER]: invitee.csrf },
      payload: { token: h.tokens.issued[0] ?? "", workspaceId: "ws_elsewhere" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("REFUSES a body on resend — it cannot retarget an invitation", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const created = await createInvite(h, owner, "resend-key-000001");
    const invitationId = created.json<{ invitationId: string }>().invitationId;

    const response = await h.app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/invitations/${invitationId}/resend`,
      headers: {
        cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf,
        [IDEMPOTENCY_KEY_HEADER]: "resend-key-000002",
      },
      payload: { email: "someone-else@example.com" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("requires an Idempotency-Key on create", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: `/workspaces/${h.workspaceId}/invitations`,
      headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
      payload: { email: "invitee@example.com", role: "member" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("idempotency_key_required");
  });
});

// ── Behaviour through HTTP ──────────────────────────────────────────────────

describe("invitation routes — behaviour", () => {
  it("creates, lists, accepts, and the workspace appears in the new member's list", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);

    const created = await createInvite(h, owner, "flow-key-00000001");
    expect(created.statusCode).toBe(201);
    expect(created.json<{ state: string }>().state).toBe("pending");

    const listed = await h.app.inject({
      method: "GET", url: `/workspaces/${h.workspaceId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    expect(listed.json<{ invitations: unknown[] }>().invitations).toHaveLength(1);

    const invitee = await h.signIn(INVITEE);
    // Before acceptance the invitee belongs to nothing.
    expect((await h.app.inject({
      method: "GET", url: "/workspaces", headers: { cookie: invitee.cookie },
    })).json<{ workspaces: unknown[] }>().workspaces).toHaveLength(0);

    const accepted = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: invitee.cookie, [CSRF_TOKEN_HEADER]: invitee.csrf },
      payload: { token: h.tokens.issued[0] ?? "" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ joined: boolean }>().joined).toBe(true);

    // SAME session cookie, and the workspace is now reachable. No re-login, no
    // token rotation — membership is authoritative.
    const after = await h.app.inject({
      method: "GET", url: "/workspaces", headers: { cookie: invitee.cookie },
    });
    expect(after.json<{ workspaces: { name: string }[] }>().workspaces).toHaveLength(1);
    expect(after.json<{ workspaces: { name: string }[] }>().workspaces[0]?.name)
      .toBe("Acme Legal");
  });

  it("refuses the WRONG signed-in account with a distinct code", async () => {
    // A forwarded link is useless: possession is not enough, the account has to
    // be the invited one. The code is distinct so the UI can say "switch
    // accounts" rather than "your valid link does not work".
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "mismatch-key-00001");

    const response = await h.app.inject({
      method: "POST", url: "/invitations/accept",
      headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
      payload: { token: h.tokens.issued[0] ?? "" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("invitation_account_mismatch");
  });

  it("answers an unknown and a revoked token IDENTICALLY on the public path", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const created = await createInvite(h, owner, "oracle-key-000001");
    const invitationId = created.json<{ invitationId: string }>().invitationId;
    const revokedToken = h.tokens.issued[0] ?? "";

    await h.app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/invitations/${invitationId}/revoke`,
      headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
      payload: {},
    });

    const unknown = await h.app.inject({
      method: "POST", url: "/invitations/preview",
      payload: { token: "invtok_9999" },
    });
    const revoked = await h.app.inject({
      method: "POST", url: "/invitations/preview",
      payload: { token: revokedToken },
    });

    expect(unknown.statusCode).toBe(revoked.statusCode);
    expect(unknown.json<{ error: { code: string } }>().error.code)
      .toBe(revoked.json<{ error: { code: string } }>().error.code);
    expect(unknown.json<{ error: { message: string } }>().error.message)
      .toBe(revoked.json<{ error: { message: string } }>().error.message);
  });

  it("declines without creating a membership", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "decline-key-00001");
    const invitee = await h.signIn(INVITEE);

    const response = await h.app.inject({
      method: "POST", url: "/invitations/decline",
      headers: { cookie: invitee.cookie, [CSRF_TOKEN_HEADER]: invitee.csrf },
      payload: { token: h.tokens.issued[0] ?? "" },
    });

    expect(response.statusCode).toBe(200);
    expect(h.transactions.store.memberships).toHaveLength(1);
  });

  it("never returns the raw credential from any route", async () => {
    // The token belongs in the delivery path. A create response carrying it
    // would put a tenant credential into a browser that is not the invitee's,
    // and into whatever logs that browser's network tab feeds (§97, §98).
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const created = await createInvite(h, owner, "secret-key-000001");
    const raw = h.tokens.issued[0] ?? "";

    expect(created.body).not.toContain(raw);
    expect(created.body).not.toContain("digest-of-");

    const listed = await h.app.inject({
      method: "GET", url: `/workspaces/${h.workspaceId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    expect(listed.body).not.toContain(raw);
    expect(listed.body).not.toContain("digest");
  });

  it("is never cacheable", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const listed = await h.app.inject({
      method: "GET", url: `/workspaces/${h.workspaceId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    expect(listed.headers["cache-control"]).toBe("no-store");
  });

  it("exposes NO route that accepts a token from a query string", async () => {
    // §51, §293. A mail security scanner prefetches every link in a message;
    // if a GET could consume an invitation, the scanner would join the
    // workspace before the human read the email.
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await createInvite(h, owner, "getproof-key-0001");
    const token = h.tokens.issued[0] ?? "";

    for (const url of [
      `/invitations/accept?token=${token}`,
      `/invitations/preview?token=${token}`,
      `/invitations/${token}`,
      `/invitations/${token}/accept`,
    ]) {
      const response = await h.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
    // And the invitation is untouched.
    expect(h.transactions.store.memberships).toHaveLength(1);
  });

  it("exposes no member-management or role-editing route", async () => {
    // BACKEND-27's surface, deliberately absent.
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const base = `/workspaces/${h.workspaceId}`;
    for (const [method, url] of [
      ["GET", `${base}/members`],
      ["POST", `${base}/members`],
      ["POST", `${base}/roles`],
      ["POST", `${base}/transfer-ownership`],
      ["GET", "/invitations"],
    ] as const) {
      const response = await h.app.inject({
        method, url,
        headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
        payload: {},
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
