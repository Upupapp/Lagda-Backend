// Verify Document access by emailed code (083), through the REAL createApp.
//
// What matters: the code request never says whether an address is a
// participant; nothing unlocks on an email alone; the document and details
// need a grant; the member route lives behind the session; and every route
// is wired to its fail-closed limits.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService, createTemplateRegistry, ALL_TEMPLATES,
  type SessionRepository, type SessionRecord, type NewSession,
  type VerificationAccessDependencies, type VerificationAccessStore,
  type VerificationParticipantTarget, type RateLimitCheck, type AbuseLimiter,
} from "@lagda/application";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createVerificationAccessCrypto } from "../security/verification-access-token.js";

const ID = "LAGDA-VER-2026-A7bK9mQ2xZ";
const EMAIL = "maria@example.com";
const KEY = Buffer.alloc(32, 7).toString("base64");
const bytes = new TextEncoder().encode("%PDF-1.7 fixture");

const TARGET: VerificationParticipantTarget = {
  workspaceId: "ws_1" as never, signingRequestId: "txn_1", requestRecipientId: "srr_1",
  recipientName: "Maria Santos", destination: EMAIL, recipientType: "approver",
  documentTitle: "Office Lease",
};

// ── A store that remembers what the routes asked of it ───────────────────────

interface State {
  participant: boolean;
  code: { challengeId: string; digest: string } | null;
  grants: Map<string, string>;
  issued: number;
  memberGrants: number;
}
let state: State;
let crypto = createVerificationAccessCrypto(KEY, "v1");
let sentCode = "";

const store: VerificationAccessStore = {
  async issueChallenge(input, notify) {
    state.issued++;
    if (!state.participant || input.verificationId !== ID || input.normalizedEmail !== EMAIL) return false;
    state.code = { challengeId: input.challengeId, digest: input.codeDigest };
    await notify(TARGET, { createIfAbsent: () => Promise.resolve({}) } as never, null);
    return true;
  },
  redeemChallenge(input) {
    if (state.code === null || !state.participant || input.normalizedEmail !== EMAIL) {
      return Promise.resolve({ outcome: "denied" as const });
    }
    if (!input.matches(state.code.challengeId, state.code.digest)) {
      return Promise.resolve({ outcome: "denied" as const });
    }
    state.code = null;
    state.grants.set(input.grant.tokenDigest, input.verificationId);
    return Promise.resolve({ outcome: "granted" as const, target: TARGET });
  },
  issueMemberGrant(input) {
    if (!state.participant || input.normalizedEmail !== EMAIL) return Promise.resolve(null);
    state.memberGrants++;
    state.grants.set(input.grant.tokenDigest, input.verificationId);
    return Promise.resolve(TARGET);
  },
  findDetails(input) {
    if (state.grants.get(input.tokenDigest) !== input.verificationId) return Promise.resolve(null);
    return Promise.resolve({
      target: TARGET, expiresAt: input.now + 1_800_000,
      documentTitle: "Office Lease", completedAt: 1, sealedDigest: "b".repeat(64),
      participants: [{ requestRecipientId: "srr_1", name: "Maria Santos", email: EMAIL,
        recipientType: "approver", routingOrder: 1, orderIndex: 0 }],
      events: [{ eventType: "approval-completed", recipientId: "srr_1", occurredAt: 1 }],
    });
  },
  findDocumentRef(input) {
    if (state.grants.get(input.tokenDigest) !== input.verificationId) return Promise.resolve(null);
    return Promise.resolve({ storageReference: "ws/doc/art.pdf", mediaType: "application/pdf",
      sizeBytes: bytes.byteLength });
  },
};

let verifiedAccount = true;
let getObjectCalls = 0;
const deps = (): VerificationAccessDependencies => ({
  store,
  // Records the code the (fake) email would carry.
  crypto: { ...crypto, newCode: () => { sentCode = crypto.newCode(); return sentCode; } },
  clock: { now: () => Date.now() },
  templates: createTemplateRegistry(ALL_TEMPLATES),
  ids: {
    nextNotificationIntentId: () => "nint_1" as never,
    nextNotificationDeliveryId: () => "ndel_1" as never,
  },
  storage: {
    getObject: () => {
      getObjectCalls++;
      return Promise.resolve({
        ref: { zone: "artifacts" as const, key: "k" as never },
        sizeBytes: bytes.byteLength, mediaType: "application/pdf",
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () { yield bytes; })(),
      });
    },
  } as never,
  currentAccount: () => Promise.resolve({ normalizedEmail: EMAIL, emailVerified: verifiedAccount }),
});

// ── The app ──────────────────────────────────────────────────────────────────

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

let checks: RateLimitCheck[] = [];
let deny: string | null = null;
const limiter: AbuseLimiter = {
  check(batch) {
    checks.push(...batch);
    const hit = batch.find(c => c.policy.id === deny);
    return Promise.resolve(hit === undefined
      ? { allowed: true, remaining: 1, resetAt: 0 }
      : { allowed: false, retryAfterSeconds: 60, resetAt: 0, policyId: hit.policy.id });
  },
};

const sessions = createSessionService({
  sessions: fakeSessionRepository(),
  tokens: createSecurityTokenGenerator(),
  digester: createSecurityTokenDigester(),
  clock: { now: () => Date.now() },
  policy: { absoluteLifetimeMs: 3_600_000, idleTimeoutMs: 3_600_000, touchIntervalMs: 300_000 },
});

let app: FastifyInstance;

async function buildApp(withAccess = true): Promise<FastifyInstance> {
  return createApp({
    config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: {
        isReachable: () => Promise.resolve(true),
        hasCurrentSchema: () => Promise.resolve(true),
      },
      sessions,
      limiter,
      workspaces: {
        create: () => ({}) as never,
        list: () => ({}) as never,
        workspace: () => ({}) as never,
      },
      ...(withAccess ? { publicParticipantAccess: deps } : {}),
    },
  });
}

beforeEach(async () => {
  state = { participant: true, code: null, grants: new Map(), issued: 0, memberGrants: 0 };
  crypto = createVerificationAccessCrypto(KEY, "v1");
  verifiedAccount = true;
  getObjectCalls = 0;
  checks = [];
  deny = null;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

const post = (path: string, payload: unknown) => app.inject({
  method: "POST", url: `/public/verifications/${ID}/${path}`, payload: payload as never,
});

async function unlock(): Promise<string> {
  await post("access-code", { email: EMAIL });
  const granted = await post("access", { email: EMAIL, code: sentCode });
  expect(granted.statusCode).toBe(200);
  return granted.json<{ accessToken: string }>().accessToken;
}

describe("POST /public/verifications/:id/access-code", () => {
  it("answers 202 identically for a participant and a stranger", async () => {
    const participant = await post("access-code", { email: EMAIL });
    const stranger = await post("access-code", { email: "stranger@example.com" });
    state.participant = false;
    const none = await post("access-code", { email: EMAIL });
    const garbage = await app.inject({
      method: "POST", url: "/public/verifications/garbage/access-code", payload: { email: EMAIL },
    });
    for (const response of [participant, stranger, none, garbage]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ sent: true, expiresInSeconds: 600 });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("is limited per IP and per (verification, email), before any lookup", async () => {
    await post("access-code", { email: EMAIL });
    expect(checks.map(c => [c.policy.id, c.scope.type])).toEqual([
      ["public-verification.access-code.ip", "ip"],
      ["public-verification.access-code.participant", "account"],
    ]);
    expect(checks.every(c => c.policy.failureMode === "fail-closed")).toBe(true);

    deny = "public-verification.access-code.participant";
    const limited = await post("access-code", { email: EMAIL });
    expect(limited.statusCode).toBe(429);
    expect(state.issued).toBe(1);
  });

  it("rejects a body carrying anything but the email", async () => {
    const response = await post("access-code", { email: EMAIL, code: "123456" });
    expect(response.statusCode).toBe(422);
  });
});

describe("POST /public/verifications/:id/access", () => {
  it("grants on the emailed code, with a token and details", async () => {
    await post("access-code", { email: EMAIL });
    const response = await post("access", { email: EMAIL, code: sentCode });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      outcome: "granted", documentTitle: "Office Lease", recipientType: "approver",
      details: {
        sealedDigest: "b".repeat(64),
        participants: [{ name: "Maria Santos", maskedEmail: "m•••@example.com",
          status: "approved", actedAt: 1, routingOrder: 1, recipientType: "approver" }],
        events: [{ type: "approval-completed", label: "Recipient approved", at: 1 }],
      },
    });
    expect(body["accessToken"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(typeof body["expiresAt"]).toBe("number");
  });

  it("denies a wrong code with the generic 401", async () => {
    await post("access-code", { email: EMAIL });
    const wrong = sentCode === "000000" ? "000001" : "000000";
    const response = await post("access", { email: EMAIL, code: wrong });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: {
      code: "verification_access_denied",
      message: "That reference, email and code do not unlock a completed LAGDA document.",
    } });
  });

  it("no longer unlocks on an email alone", async () => {
    const response = await post("access", { email: EMAIL });
    expect(response.statusCode).toBe(422);
  });

  it("is IP limited", async () => {
    await post("access", { email: EMAIL, code: "123456" });
    expect(checks.map(c => c.policy.id)).toContain("public-verification.access.ip");
  });
});

describe("POST /public/verifications/:id/document and /details", () => {
  it("streams the sealed PDF for a live grant", async () => {
    const accessToken = await unlock();
    const response = await post("document", { accessToken });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload.length).toBe(bytes.byteLength);
  });

  it("refreshes the details for a live grant", async () => {
    const accessToken = await unlock();
    const response = await post("details", { accessToken });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ details: { documentTitle: string } }>().details.documentTitle)
      .toBe("Office Lease");
  });

  it("refuses the email-only body that used to unlock the PDF", async () => {
    const response = await post("document", { email: EMAIL });
    expect(response.statusCode).toBe(422);
    expect(getObjectCalls).toBe(0);
  });

  it("denies an unknown token, and one for another verification ID", async () => {
    const accessToken = await unlock();
    const unknown = await post("document", { accessToken: "A".repeat(43) });
    const other = await app.inject({
      method: "POST", url: "/public/verifications/LAGDA-VER-2026-Zz9Yy8Xx7W/document",
      payload: { accessToken },
    });
    const details = await post("details", { accessToken: "nope" });
    expect(unknown.statusCode).toBe(401);
    expect(other.statusCode).toBe(401);
    expect(details.statusCode).toBe(401);
    expect(getObjectCalls).toBe(0);
  });

  it("are IP limited", async () => {
    await post("document", { accessToken: "x" });
    await post("details", { accessToken: "x" });
    expect(checks.filter(c => c.policy.id === "public-verification.document.ip")).toHaveLength(2);
  });
});

describe("POST /verifications/:id/member-access", () => {
  const member = async () => {
    const issued = await sessions.issue("usr_1" as UserId);
    return app.inject({
      method: "POST", url: `/verifications/${ID}/member-access`,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
        [CSRF_TOKEN_HEADER]: issued.csrfToken,
      },
    });
  };

  it("grants a verified participant account without a code", async () => {
    const response = await member();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "granted", documentTitle: "Office Lease" });
    expect(state.memberGrants).toBe(1);
    expect(checks.map(c => c.policy.id)).toContain("verification.member-access.user");
  });

  it("denies an unverified account with the generic 401", async () => {
    verifiedAccount = false;
    const response = await member();
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("verification_access_denied");
  });

  it("denies a verified account that is not a participant", async () => {
    state.participant = false;
    expect((await member()).statusCode).toBe(401);
  });

  it("sits behind the session: no cookie never reaches the use case", async () => {
    const response = await app.inject({ method: "POST", url: `/verifications/${ID}/member-access` });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).not.toBe("verification_access_denied");
    expect(state.memberGrants).toBe(0);
  });
});

describe("composition", () => {
  it("none of these routes exist without publicParticipantAccess configured", async () => {
    const bare = await buildApp(false);
    for (const path of ["access-code", "access", "details", "document"]) {
      const response = await bare.inject({
        method: "POST", url: `/public/verifications/${ID}/${path}`, payload: { email: EMAIL },
      });
      expect(response.statusCode).toBe(404);
    }
    await bare.close();
  });
});
