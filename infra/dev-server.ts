// A local API for frontend integration work — FRONTEND-01 §F support.
//
// NOT a deployment target and not a substitute for the real stack. There is no
// PostgreSQL here: this boots `createApp` with in-process dependencies so the
// frontend can exercise REAL HTTP against REAL handlers -- real routing, real
// TypeBox validation, real cookies and CSRF, the real error envelope and the
// real X-Request-Id -- while the persistence layer is absent.
//
//   node --experimental-strip-types infra/dev-server.ts [port]
//
// WHAT IS WIRED
//   /health, /ready            fully real
//   /public/verifications/:id  real route and real handler, backed by a lookup
//                              that finds nothing, so it exercises the
//                              not-found path end to end
//   /auth/register             REAL: real Argon2 hashing, real duplicate
//   /auth/sessions             refusal, real session issue, real cookies
//   /auth/sessions/current     and CSRF. Only persistence is in memory.
//   /workspaces                REAL: create, list and read, with real
//   /workspaces/{id}           idempotency and real ownership.
//
// WHAT IS NOT, and why it is not a matter of adding a line here:
//   Every other surface needs its dependency group, and the identity surface
//   alone needs seventeen use-case graphs that nothing in the repository has
//   ever constructed -- identity-routes.test.ts stubs all seventeen and says so
//   ("a stub that answered would let a mounted-but-broken route pass as a
//   mounted one"). Wiring them for real is the composition command OD-069 asked
//   for, not a dev-server detail.

import { createHash, randomBytes } from "node:crypto";
import {
  createApp, loadApiConfig, createArgon2PasswordHasher,
  createSecurityTokenGenerator, createSecurityTokenDigester,
  createIdempotencyKeyDigester,
} from "@lagda/api";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
} from "@lagda/application";
import {
  fakeNotifications, createIdempotencyRecordIds,
  FakeTransactionManager, SequentialWorkspaceIds, SequentialMemberIds,
} from "@lagda/application/test-support";
import { InMemoryIdentity } from "./identity-memory.ts";

const port = Number(process.argv[2] ?? 8787);

const config = loadApiConfig({
  NODE_ENV: "development",
  API_PORT: String(port),
  LOG_LEVEL: "info",
  // The Vite dev server and preview server.
  CORS_ORIGINS: "http://localhost:5173,http://localhost:4173",
});

const identity = new InMemoryIdentity();
const notificationStore = {
  notificationIntents: new Map(),
  notificationDeliveries: new Map(),
};

// The workspace side of the world. Same in-memory transaction manager the
// route tests use, so the graphs below are wired the way those tests wire them.
const transactions = new FakeTransactionManager();
const workspaceIds = new SequentialWorkspaceIds();
const memberIds = new SequentialMemberIds();
const hasher = createArgon2PasswordHasher();
const tokens = createSecurityTokenGenerator();
const digester = createSecurityTokenDigester();
const clock = { now: () => Date.now() };

/**
 * Sessions in a Map. Copied in shape from the route tests, which each declare
 * their own -- there is no shared one to import.
 */
function memorySessionRepository(): SessionRepository {
  const rows = new Map<string, SessionRecord>();
  return {
    findByTokenHash: (hash) =>
      Promise.resolve([...rows.values()].find((r) => r.tokenHash === hash) ?? null),
    create: (s: NewSession) => {
      rows.set(s.sessionId, { ...s, lastSeenAt: s.createdAt });
      return Promise.resolve();
    },
    touch: (id, at) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastSeenAt: at });
      return Promise.resolve();
    },
    revoke: (id, at, reason) => {
      const row = rows.get(id);
      if (row && row.revokedAt === undefined) {
        rows.set(id, { ...row, revokedAt: at, revocationReason: reason });
      }
      return Promise.resolve();
    },
    revokeAllForUser: () => Promise.resolve(0),
  };
}

const sessions = createSessionService({
  sessions: memorySessionRepository(),
  tokens, digester, clock,
  policy: {
    absoluteLifetimeMs: 7 * 24 * 3_600_000,
    idleTimeoutMs: 8 * 3_600_000,
    touchIntervalMs: 300_000,
  },
});

// A valid Argon2id hash that authenticates nobody, computed once from a secret
// nobody keeps. Login verifies against it when an account does not exist, so a
// missing account costs the same time as a wrong password.
const dummyPasswordHash = await hasher.hash(randomBytes(32).toString("hex"));

/** Throws on use. The surface needs all seventeen; three are real here. */
function unwired<T>(name: string): T {
  return new Proxy({}, {
    get: () => () => {
      throw new Error(
        `${name} is not wired in the dev API. Only register, login and ` +
        `current-user are: see infra/identity-memory.ts.`,
      );
    },
  }) as T;
}

const app = await createApp({
  config,
  dependencies: {
    databaseHealth: { isReachable: () => Promise.resolve(true) },
    sessions,
    workspaces: {
      create: () => ({
        transactions, clock, workspaceIds, memberIds,
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock,
          policy: { retentionMs: 24 * 3_600_000 },
        },
      }),
      list: () => ({ transactions }),
      workspace: () => ({ transactions }),
    },
    identity: () => ({
      register: () => ({
        users: identity.users,
        challenges: identity.verificationChallenges,
        hasher, clock,
        // SecurityTokenGenerator and VerificationTokenFactory are different
        // ports: the former mints session/CSRF tokens, the latter issues a
        // verification token WITH its digest. Built here from node:crypto,
        // the same sha256-over-a-domain-prefix shape the digester uses.
        tokens: {
          issue: () => {
            const raw = randomBytes(32).toString("base64url");
            return {
              raw,
              digest: createHash("sha256")
                .update(`lagda.verification:${raw}`)
                .digest("hex") as never,
            };
          },
        },
        newUserId: () => identity.nextUserId(),
        newChallengeId: () => `evc_${Date.now()}`,
        commit: identity.commit,
        termsVersion: "2026-01-01",
        verificationTtlMs: 24 * 3_600_000,
      }),
      login: () => ({
        users: identity.users,
        hasher, sessions, clock, dummyPasswordHash,
      }),
      currentUser: () => ({ accounts: identity.accounts }),

      // Everything below needs its own graph and none is built. They throw
      // rather than answer: a stub that answered would let a mounted-but-broken
      // route pass as a working one, which is the trap identity-routes.test.ts
      // names explicitly.
      // Redemption is real: digest the submitted token the same way
      // registration digested the issued one, find the row, consume it under
      // the row's own condition, and verify the account once.
      verifyEmail: () => ({
        digestSubmitted: (raw: string) => {
          const canonical = raw.trim();
          if (canonical.length === 0) return null;
          return createHash("sha256")
            .update(`lagda.verification:${canonical}`)
            .digest("hex") as never;
        },
        clock,
        commit: (operation) => operation({
          challenges: identity.verificationChallengesFull as never,
          users: identity.verifiableUsers as never,
          // OD-185: user context is DISCOVERED by the address lookup, so it is
          // adopted here rather than set at the top.
          adoptUser: () => Promise.resolve({
            notifications: fakeNotifications(notificationStore),
            transaction: {},
          }),
        }),
      }),
      resendVerification: () => unwired("resendVerification"),
      requestPasswordReset: () => unwired("requestPasswordReset"),
      resetPassword: () => unwired("resetPassword"),
      completeMfa: () => unwired("completeMfa"),
      beginEnrolment: () => unwired("beginEnrolment"),
      confirmEnrolment: () => unwired("confirmEnrolment"),
      disableMfa: () => unwired("disableMfa"),
      updateProfile: () => unwired("updateProfile"),
      updatePreferences: () => unwired("updatePreferences"),
      changePassword: () => unwired("changePassword"),
      listSessions: () => unwired("listSessions"),
      revokeSession: () => unwired("revokeSession"),
      revokeOtherSessions: () => unwired("revokeOtherSessions"),

      // The real delivery seam. Nothing sends mail here, so the link is
      // printed -- which is also the only way to see that registration issued a
      // real, digestable token rather than a placeholder.
      deliverVerification: ({ email, rawToken, expiresAt }) => {
        console.log(JSON.stringify({
          level: "info", msg: "verification issued (not sent)",
          email, rawToken, expiresAt,
        }));
        return Promise.resolve();
      },

      endSession: (sessionId) => sessions.revoke(sessionId),
      issueSession: (userId) => sessions.issue(userId),
      authenticatedUser: (request) => sessions.resolve(request),
    }),
    publicVerification: () => ({
      lookup: {
        // Finds nothing. That is deliberate: with no database there is no
        // record to return, and answering with an invented one would be the
        // fake success this whole command exists to avoid. The not-found path
        // is real, and it is what the frontend needs to branch on.
        findByVerificationId: () => Promise.resolve(null),
      },
    }),
  },
});

await app.listen({ port, host: "127.0.0.1" });
console.log(JSON.stringify({ level: "info", msg: "dev api listening", port }));
