// The contact surface's HTTP contract, through the REAL `createApp`.
//
// Same construction as the workspace suite: a fake session STORE, but the real
// session service, the real cookies, the real CSRF check, the real error
// handler and the real encapsulation. So the assertions below about 401s and
// CSRF are about the app that runs in production, not about a hook a test
// attached to a bare Fastify instance.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type ContactDependencies, type SessionId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialContactIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerContactRoutes } from "./contact-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const WORKSPACE = "ws_contacts" as WorkspaceId;

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

interface Harness {
  readonly app: FastifyInstance;
  readonly transactions: FakeTransactionManager;
  readonly signIn: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
}

async function build(): Promise<Harness> {
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
  // The workspace and its memberships, seeded directly. This suite is about the
  // HTTP contract; workspace creation has its own.
  transactions.store.workspaces.set(WORKSPACE, {
    workspaceId: WORKSPACE, name: "Acme Legal", createdAt: AT,
  });
  transactions.store.memberships.push(
    {
      memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: OWNER, role: "owner", createdAt: AT,
    },
    {
      memberId: "mem_reviewer" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: REVIEWER, role: "reviewer", createdAt: AT,
    },
  );

  // ONE generator for the whole app. A fresh one per request would hand every
  // contact the id `con_1`, and the suite would silently test a single
  // overwritten row.
  const contactIds = new SequentialContactIds();

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions,
          clock: new FixedClock(AT),
          workspaceIds: new SequentialWorkspaceIds(),
          memberIds: new SequentialMemberIds(),
          idempotency: {
            digester: createIdempotencyKeyDigester(),
            ids: createIdempotencyRecordIds(),
            clock: new FixedClock(AT),
            policy: { retentionMs: 24 * 3_600_000 },
          },
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        contacts: (): ContactDependencies => ({
          transactions, clock: new FixedClock(AT), ids: contactIds,
        }),
      },
    },
  });

  return {
    app, transactions,
    signIn: async (userId: UserId) => {
      const issued = await sessions.issue(userId);
      return {
        cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
        csrf: issued.csrfToken,
      };
    },
  };
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness(): Promise<Harness> {
  const built = await build();
  open = built.app;
  return built;
}

const BODY = {
  name: "Maria Santos",
  email: "maria.santos@ayalaland.com.ph",
  phone: "+63 917 123 4567",
  organization: "Ayala Land",
  title: "General Counsel",
};

const URL = `/workspaces/${WORKSPACE}/contacts`;

async function createOne(h: Harness, body: Record<string, unknown> = BODY) {
  const { cookie, csrf } = await h.signIn(OWNER);
  return h.app.inject({
    method: "POST", url: URL,
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    payload: body,
  });
}

// ── Authentication and CSRF ─────────────────────────────────────────────────

describe("contact routes — the scope's protections", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    const routes = [
      ["GET", URL],
      ["POST", URL],
      ["GET", `${URL}/con_1`],
      ["PUT", `${URL}/con_1`],
      ["POST", `${URL}/con_1/archive`],
      ["POST", `${URL}/con_1/restore`],
    ] as const;

    for (const [method, url] of routes) {
      const response = await h.app.inject({
        method, url,
        ...(method === "POST" || method === "PUT" ? { payload: BODY } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    // And nothing was written by any of them.
    expect(h.transactions.store.contacts).toHaveLength(0);
  });

  it("refuses a mutation with a session but no CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);

    for (const [method, url] of [
      ["POST", URL],
      ["PUT", `${URL}/con_1`],
      ["POST", `${URL}/con_1/archive`],
    ] as const) {
      const response = await h.app.inject({
        method, url, headers: { cookie }, payload: BODY,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(h.transactions.store.contacts).toHaveLength(0);
  });

  it("marks every response no-store", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── The contract ────────────────────────────────────────────────────────────

describe("POST /contacts", () => {
  it("creates with 201, a Location header and ISO timestamps", async () => {
    const h = await harness();
    const response = await createOne(h);

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      contact: Record<string, unknown>;
      duplicates: unknown[];
    }>();

    expect(body.contact["contactId"]).toBe("con_1");
    expect(body.contact["name"]).toBe(BODY.name);
    expect(body.contact["state"]).toBe("active");
    // ISO-8601 on the wire; epoch milliseconds inside the domain.
    expect(body.contact["createdAt"]).toBe(new Date(AT).toISOString());
    expect(body.contact["archivedAt"]).toBeNull();
    expect(body.duplicates).toEqual([]);
    expect(response.headers["location"]).toBe(`${URL}/con_1`);
  });

  it("never returns the comparison key or the workspace id", async () => {
    const h = await harness();
    const body = (await createOne(h)).json<{ contact: Record<string, unknown> }>();
    expect(Object.keys(body.contact).sort()).toEqual([
      "archivedAt", "contactId", "createdAt", "email", "name",
      "organization", "phone", "state", "title", "updatedAt",
    ]);
  });

  it("rejects an unknown property rather than ignoring it", async () => {
    const h = await harness();
    // `additionalProperties: false`. A client that sent `workspaceId` or
    // `userId` is trying to say something the contract does not permit, and
    // silently dropping it would let them believe it took effect.
    for (const extra of [
      { ...BODY, workspaceId: "ws_other" },
      { ...BODY, userId: "usr_victim" },
      { ...BODY, state: "archived" },
      { ...BODY, contactId: "con_chosen" },
    ]) {
      const response = await createOne(h, extra);
      expect(response.statusCode).toBe(422);
    }
    expect(h.transactions.store.contacts).toHaveLength(0);
  });

  it("rejects an over-long field at the schema, before the domain", async () => {
    const h = await harness();
    const response = await createOne(h, { ...BODY, name: "x".repeat(500) });
    expect(response.statusCode).toBe(422);
  });

  it("returns 201 WITH a duplicate warning, not a conflict", async () => {
    const h = await harness();
    await createOne(h, { name: "Legal Desk", email: "legal@example.com" });
    const second = await createOne(h, { name: "Legal Team", email: "legal@example.com" });

    // The contact WAS created. LAGDA warns; it does not refuse.
    expect(second.statusCode).toBe(201);
    const body = second.json<{ duplicates: { contactId: string; name: string }[] }>();
    expect(body.duplicates).toHaveLength(1);
    expect(body.duplicates[0]?.name).toBe("Legal Desk");
    expect(h.transactions.store.contacts).toHaveLength(2);
  });
});

describe("GET /contacts", () => {
  it("paginates with the canonical envelope", async () => {
    const h = await harness();
    await createOne(h, { name: "Ana", email: "ana@x.com" });
    await createOne(h, { name: "Ben", email: "ben@x.com" });

    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}?sort=name&direction=asc&page=1&perPage=1`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { name: string }[]; total: number; page: number;
      perPage: number; hasNextPage: boolean;
    }>();
    expect(body.items.map(i => i.name)).toEqual(["Ana"]);
    expect(body).toMatchObject({ total: 2, page: 1, perPage: 1, hasNextPage: true });
  });

  it("rejects perPage beyond the maximum", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}?perPage=1000000`, headers: { cookie },
    });
    // A valid integer and an invalid request. Bounded at the schema so no
    // handler can be the one that forgets.
    expect(response.statusCode).toBe(422);
  });

  it("rejects an unknown sort field", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}?sort=password`, headers: { cookie },
    });
    expect(response.statusCode).toBe(422);
  });

  it("returns an empty page past the end with 200", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}?page=99`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe("archive and restore", () => {
  it("archives and restores through POST sub-resources", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie, csrf } = await h.signIn(OWNER);
    const headers = { cookie, [CSRF_TOKEN_HEADER]: csrf };

    const archived = await h.app.inject({
      method: "POST", url: `${URL}/con_1/archive`, headers,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ state: string }>().state).toBe("archived");
    // The row survives.
    expect(h.transactions.store.contacts).toHaveLength(1);

    const restored = await h.app.inject({
      method: "POST", url: `${URL}/con_1/restore`, headers,
    });
    expect(restored.json<{ state: string; archivedAt: null }>())
      .toMatchObject({ state: "active", archivedAt: null });
  });

  it("exposes no DELETE route", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "DELETE", url: `${URL}/con_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(404);
    expect(h.transactions.store.contacts).toHaveLength(1);
  });
});

// ── Authorization, at the HTTP boundary ─────────────────────────────────────

describe("capability enforcement over HTTP", () => {
  it("gives a REVIEWER 404 on read and write alike", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie, csrf } = await h.signIn(REVIEWER);

    const listed = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    // 404, not 403. A 403 would confirm the workspace exists and would explain
    // the role policy to a caller who does not hold it.
    expect(listed.statusCode).toBe(404);

    const created = await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Sneaky", email: "sneaky@x.com" },
    });
    expect(created.statusCode).toBe(404);
    expect(h.transactions.store.contacts).toHaveLength(1);
  });

  it("gives a non-member the same 404", async () => {
    const h = await harness();
    const { cookie } = await h.signIn("usr_outsider" as UserId);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// A BARE Fastify instance with a captured logger, not `createApp`.
//
// `createApp` builds its logger from configuration and takes no override, and
// adding one would be a production seam that exists only for a test. What these
// two cases assert is the SHAPE OF THE LOG PAYLOAD the route emits, and that
// does not depend on the session hook, the CSRF check or the error handler —
// all of which are asserted through the real app above.
//
// The route's authorization still runs: `authenticatedUser` resolves the same
// owner, and the use case reads their membership from the same fake store.

describe("contact telemetry carries no personal data", () => {
  async function logged(): Promise<{
    app: FastifyInstance; capture: LogCapture;
  }> {
    const capture = createLogCapture();
    // `logger: { stream }` rather than `loggerInstance: pino(...)`. Both write
    // to the captured stream; the second makes the logger type CONCRETE, and
    // the resulting `FastifyInstance` then does not satisfy the default-generic
    // one `registerContactRoutes` accepts.
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });

    const transactions = new FakeTransactionManager();
    transactions.store.workspaces.set(WORKSPACE, {
      workspaceId: WORKSPACE, name: "Acme Legal", createdAt: AT,
    });
    transactions.store.memberships.push({
      memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: OWNER, role: "owner", createdAt: AT,
    });

    registerContactRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      contactDependencies: () => ({
        transactions, clock: new FixedClock(AT), ids: new SequentialContactIds(),
      }),
    });
    await app.ready();
    return { app, capture };
  }

  it("logs the id and the duplicate COUNT, never the contact's details", async () => {
    const { app, capture } = await logged();
    app.log.info({ marker: "start" }, "start");
    const response = await app.inject({ method: "POST", url: URL, payload: BODY });
    expect(response.statusCode).toBe(201);
    await app.close();

    const events = capture.lines().filter(line => line["event"] === "contact.created");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("fixture");

    expect(event["contactId"]).toBe("con_1");
    expect(event["duplicateCount"]).toBe(0);

    // The WHOLE serialized line, so a field nested at any depth is caught.
    const line = JSON.stringify(event);
    for (const secret of [
      "maria.santos", "Maria Santos", "917 123 4567", "Ayala Land",
      "General Counsel",
    ]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("keeps a DUPLICATE's details out of the log too", async () => {
    const { app, capture } = await logged();
    await app.inject({
      method: "POST", url: URL,
      payload: { name: "Legal Desk", email: "legal@example.com" },
    });
    await app.inject({
      method: "POST", url: URL,
      payload: { name: "Legal Team", email: "legal@example.com" },
    });
    await app.close();

    const events = capture.lines().filter(line => line["event"] === "contact.created");
    const second = events[1];
    if (second === undefined) throw new Error("fixture");
    // A count, not the matching records. Answering "is the warning firing in
    // production" must not put a second person's details in a log to do it.
    expect(second["duplicateCount"]).toBe(1);
    expect(JSON.stringify(second)).not.toContain("Legal Desk");
  });
});
