// The document surface's HTTP contract, through the REAL `createApp`.
//
// Fake session STORE; real session service, cookies, CSRF check, error handler
// and encapsulation.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type DocumentDependencies, type SessionId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialDocumentIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerDocumentRoutes } from "./document-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const WORKSPACE = "ws_documents" as WorkspaceId;

/** A title that would be a serious disclosure if it reached a log. */
const SENSITIVE_TITLE = "Retainer Agreement — Mabini Business Services";

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

function seedWorkspace(transactions: FakeTransactionManager): void {
  transactions.store.workspaces.set(WORKSPACE, {
    workspaceId: WORKSPACE, name: "Acme Legal", createdAt: AT,
  });
  transactions.store.memberships.push(
    {
      memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: OWNER, role: "owner", createdAt: AT,
    },
    {
      memberId: "mem_auditor" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: AUDITOR, role: "auditor", createdAt: AT,
    },
  );
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
  seedWorkspace(transactions);
  // ONE generator for the whole app, so every document does not get `doc_1`.
  const documentIds = new SequentialDocumentIds();

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
        documents: (): DocumentDependencies => ({
          transactions, clock: new FixedClock(AT), ids: documentIds,
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

const URL = `/workspaces/${WORKSPACE}/documents`;

async function createOne(h: Harness, body: Record<string, unknown> = { title: SENSITIVE_TITLE }) {
  const { cookie, csrf } = await h.signIn(OWNER);
  return h.app.inject({
    method: "POST", url: URL,
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    payload: body,
  });
}

// ── The scope's protections ─────────────────────────────────────────────────

describe("document routes — the scope's protections", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    for (const [method, url] of [
      ["GET", URL],
      ["POST", URL],
      ["GET", `${URL}/doc_1`],
      ["PATCH", `${URL}/doc_1`],
    ] as const) {
      const response = await h.app.inject({
        method, url,
        ...(method === "POST" || method === "PATCH" ? { payload: { title: "X" } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(h.transactions.store.documents).toHaveLength(0);
  });

  it("refuses a mutation with a session but no CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    for (const [method, url] of [
      ["POST", URL],
      ["PATCH", `${URL}/doc_1`],
    ] as const) {
      const response = await h.app.inject({
        method, url, headers: { cookie }, payload: { title: "X" },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(h.transactions.store.documents).toHaveLength(0);
  });

  it("marks every response no-store", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── Contract ────────────────────────────────────────────────────────────────

describe("POST /documents", () => {
  it("creates with 201, a Location header, ISO timestamps and NO source", async () => {
    const h = await harness();
    const response = await createOne(h);

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body["documentId"]).toBe("doc_1");
    expect(body["title"]).toBe(SENSITIVE_TITLE);
    expect(body["createdAt"]).toBe(new Date(AT).toISOString());
    // The normal outcome: metadata exists, bytes do not yet.
    expect(body["source"]).toBeNull();
    expect(body["originalFilename"]).toBeNull();
    expect(response.headers["location"]).toBe(`${URL}/doc_1`);
  });

  it("exposes no artifact, storage or digest field", async () => {
    const h = await harness();
    const body = (await createOne(h)).json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      "createdAt", "createdByUserId", "documentId", "originalFilename",
      "source", "title", "updatedAt",
    ]);
  });

  it("REJECTS untrusted artifact metadata rather than ignoring it", async () => {
    const h = await harness();
    // Every one of these is a client trying to assert something about bytes.
    for (const extra of [
      { title: "X", artifactId: "art_1" },
      { title: "X", storageKey: "s3://bucket/key" },
      { title: "X", sha256: "a".repeat(64) },
      { title: "X", sizeBytes: 1 },
      { title: "X", pageCount: 999 },
      { title: "X", malwareScanStatus: "clean" },
      { title: "X", workspaceId: "ws_other" },
      { title: "X", documentId: "doc_chosen" },
      { title: "X", createdByUserId: "usr_victim" },
      { title: "X", status: "completed" },
    ]) {
      const response = await createOne(h, extra);
      expect(response.statusCode, JSON.stringify(extra)).toBe(422);
    }
    expect(h.transactions.store.documents).toHaveLength(0);
  });

  it("rejects a blank or over-long title at the schema", async () => {
    const h = await harness();
    expect((await createOne(h, { title: "" })).statusCode).toBe(422);
    expect((await createOne(h, { title: "x".repeat(400) })).statusCode).toBe(422);
  });
});

describe("GET and PATCH", () => {
  it("reads back what was created", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}/doc_1`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ title: string }>().title).toBe(SENSITIVE_TITLE);
  });

  it("renames, changing only the title and updatedAt", async () => {
    const h = await harness();
    const created = (await createOne(h)).json<Record<string, unknown>>();
    const { cookie, csrf } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "PATCH", url: `${URL}/doc_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { title: "Office Lease" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["title"]).toBe("Office Lease");
    expect(body["documentId"]).toBe(created["documentId"]);
    expect(body["createdAt"]).toBe(created["createdAt"]);
    expect(body["createdByUserId"]).toBe(created["createdByUserId"]);
  });

  it("paginates with the canonical envelope", async () => {
    const h = await harness();
    await createOne(h, { title: "Alpha" });
    await createOne(h, { title: "Bravo" });

    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}?sort=title&direction=asc&page=1&perPage=1`,
      headers: { cookie },
    });
    const body = response.json<{ items: { title: string }[]; total: number }>();
    expect(body.items.map(i => i.title)).toEqual(["Alpha"]);
    expect(body).toMatchObject({ total: 2, page: 1, perPage: 1, hasNextPage: true });
  });

  it("rejects an unknown sort field and an oversized perPage", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    for (const query of ["sort=status", "sort=expiry", "perPage=1000000"]) {
      const response = await h.app.inject({
        method: "GET", url: `${URL}?${query}`, headers: { cookie },
      });
      // `status` and `expiry` are the product's TRANSACTION sort fields. A
      // document has neither, so the closed whitelist refuses them.
      expect(response.statusCode, query).toBe(422);
    }
  });

  it("exposes no DELETE route", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "DELETE", url: `${URL}/doc_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(404);
    expect(h.transactions.store.documents).toHaveLength(1);
  });
});

// ── Authorization over HTTP ─────────────────────────────────────────────────

describe("capability enforcement over HTTP", () => {
  it("lets an AUDITOR read and refuses their writes with 404", async () => {
    const h = await harness();
    await createOne(h);
    const { cookie, csrf } = await h.signIn(AUDITOR);

    const listed = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ total: number }>().total).toBe(1);

    // 404, not 403 — the hidden-resource policy, so the response never explains
    // the role policy to a caller who does not hold the capability.
    const created = await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { title: "Sneaky" },
    });
    expect(created.statusCode).toBe(404);

    const renamed = await h.app.inject({
      method: "PATCH", url: `${URL}/doc_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { title: "Sneaky" },
    });
    expect(renamed.statusCode).toBe(404);
    expect(h.transactions.store.documents).toHaveLength(1);
  });

  it("gives a non-member 404 on read", async () => {
    const h = await harness();
    const { cookie } = await h.signIn("usr_outsider" as UserId);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// A BARE Fastify instance with a captured logger, for the same reason the
// contact suite uses one: `createApp` builds its logger from configuration and
// takes no override, and adding one would be a production seam that exists only
// for a test. What is asserted here is the shape of the log payload.

describe("document telemetry carries no title or filename", () => {
  async function logged(): Promise<{ app: FastifyInstance; capture: LogCapture }> {
    const capture = createLogCapture();
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });
    const transactions = new FakeTransactionManager();
    seedWorkspace(transactions);

    registerDocumentRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      documentDependencies: () => ({
        transactions, clock: new FixedClock(AT), ids: new SequentialDocumentIds(),
      }),
    });
    await app.ready();
    return { app, capture };
  }

  it("logs ids and a title LENGTH, never the title itself", async () => {
    const { app, capture } = await logged();
    const response = await app.inject({
      method: "POST", url: URL, payload: { title: SENSITIVE_TITLE },
    });
    expect(response.statusCode).toBe(201);
    await app.close();

    const events = capture.lines().filter(line => line["event"] === "document.created");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("fixture");

    expect(event["documentId"]).toBe("doc_1");
    expect(event["titleLength"]).toBe([...SENSITIVE_TITLE].length);

    // The WHOLE serialized line. A legal matter name identifies the client, the
    // counterparty and often the transaction.
    const line = JSON.stringify(event);
    for (const secret of ["Retainer", "Mabini", "Business Services"]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("keeps the new title out of a rename log", async () => {
    const { app, capture } = await logged();
    await app.inject({ method: "POST", url: URL, payload: { title: "Draft" } });
    await app.inject({
      method: "PATCH", url: `${URL}/doc_1`, payload: { title: SENSITIVE_TITLE },
    });
    await app.close();

    const renamed = capture.lines().filter(line => line["event"] === "document.renamed");
    expect(renamed).toHaveLength(1);
    expect(JSON.stringify(renamed[0])).not.toContain("Mabini");
  });
});
