// The folder routes over HTTP.
//
// Fake session STORE; real session service, cookies, CSRF check, error handler.
// What is worth testing at THIS layer rather than at the use case: the schema's
// exactly-one-field rule, that `archived: false` is read as a restore and not
// as an absent key, and that a folder NAME never reaches a log line.

import { describe, it, expect, afterEach } from "vitest";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type FolderDependencies, type SessionId,
  type FolderId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerFolderRoutes } from "./folder-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const WORKSPACE = "ws_folders" as WorkspaceId;

/** A folder name that would be a serious disclosure if it reached a log. */
const SENSITIVE_NAME = "Mabini Business Services — 2026 Renewals";

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

/** A folder id generator a test can predict. */
class SequentialFolderIds {
  private next = 0;
  nextFolderId(): FolderId {
    this.next += 1;
    return `fld_${String(this.next)}` as FolderId;
  }
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
  const folderIds = new SequentialFolderIds();

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: {
    isReachable: () => Promise.resolve(true),
    hasCurrentSchema: () => Promise.resolve(true),
  },
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
        folders: (): FolderDependencies => ({
          transactions, clock: new FixedClock(AT), ids: folderIds,
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

const URL = `/workspaces/${WORKSPACE}/folders`;

describe("folder routes", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    for (const [method, url] of [
      ["GET", URL],
      ["POST", URL],
      ["PATCH", `${URL}/fld_1`],
    ] as const) {
      const response = await h.app.inject({
        method, url,
        ...(method === "GET" ? {} : { payload: { name: "X", parentFolderId: null } }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("creates a folder and returns it with a Location", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: SENSITIVE_NAME, parentFolderId: null },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body["name"]).toBe(SENSITIVE_NAME);
    expect(body["parentFolderId"]).toBeNull();
    expect(body["archivedAt"]).toBeNull();
    expect(response.headers["location"]).toBe(`${URL}/fld_1`);

    // And it is in the tree.
    const listed = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(listed.json<{ folders: unknown[] }>().folders).toHaveLength(1);
  });

  /**
   * `archived: false` is a RESTORE, not an absent key.
   *
   * The handler tests `"archived" in body`. A truthiness check would read
   * false as absent and fall through to the rename branch with no name.
   */
  it("archives and restores through the same field", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Old Matters", parentFolderId: null },
    });

    const patch = (payload: Record<string, unknown>) => h.app.inject({
      method: "PATCH", url: `${URL}/fld_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload,
    });

    const archived = await patch({ archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<Record<string, unknown>>()["archivedAt"]).not.toBeNull();

    const restored = await patch({ archived: false });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<Record<string, unknown>>()["archivedAt"]).toBeNull();
  });

  it("renames through the same route", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Typo", parentFolderId: null },
    });

    const renamed = await h.app.inject({
      method: "PATCH", url: `${URL}/fld_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Fixed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Record<string, unknown>>()["name"]).toBe("Fixed");
  });

  /**
   * EXACTLY ONE field, and no `parentFolderId` at all.
   *
   * Moving a folder re-parents a whole subtree and can push its DESCENDANTS
   * past the depth bound; that rule does not exist, so the field is refused
   * rather than accepted and ignored.
   */
  it("refuses both fields, neither, and a move", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Folder", parentFolderId: null },
    });

    for (const payload of [
      { name: "X", archived: true },
      {},
      { parentFolderId: "fld_2" },
    ]) {
      const response = await h.app.inject({
        method: "PATCH", url: `${URL}/fld_1`,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }
  });

  it("refuses archiving a folder that still holds a child folder", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    const post = (payload: Record<string, unknown>) => h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload,
    });
    await post({ name: "2026", parentFolderId: null });
    await post({ name: "Renewals", parentFolderId: "fld_1" });

    const refused = await h.app.inject({
      method: "PATCH", url: `${URL}/fld_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { archived: true },
    });
    // `conflict`, not validation: the request is well-formed and the folder
    // exists; the workspace is simply not in a state that allows it.
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("folder_not_empty");
  });

  it("lets an AUDITOR read the tree and refuses their writes", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
      payload: { name: "Client Agreements", parentFolderId: null },
    });

    const { cookie, csrf } = await h.signIn(AUDITOR);
    const read = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ folders: unknown[] }>().folders).toHaveLength(1);

    const write = await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Mine", parentFolderId: null },
    });
    // The hidden 404 every other capability refusal uses.
    expect(write.statusCode).toBe(404);
  });

  it("marks the tree no-store", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    // A folder name identifies a client and a matter exactly as a title does.
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// A BARE Fastify instance with a captured logger, for the same reason the
// document suite uses one: `createApp` builds its logger from configuration and
// takes no override, and adding one would be a production seam that exists only
// for a test.

describe("folder telemetry carries no folder name", () => {
  it("logs the id and the parent, never the NAME", async () => {
    const capture: LogCapture = createLogCapture();
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });
    const transactions = new FakeTransactionManager();
    seedWorkspace(transactions);

    registerFolderRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      folderDependencies: () => ({
        transactions, clock: new FixedClock(AT), ids: new SequentialFolderIds(),
      }),
    });
    await app.ready();

    const response = await app.inject({
      method: "POST", url: URL,
      payload: { name: SENSITIVE_NAME, parentFolderId: null },
    });
    expect(response.statusCode).toBe(201);
    await app.close();

    const created = capture.lines().filter(line => line["event"] === "folder.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.["folderId"]).toBe("fld_1");
    // The whole capture, not just the one line: a name leaking through the
    // request logger or an error would be just as much of a disclosure.
    expect(JSON.stringify(capture.lines())).not.toContain("Mabini");
  });
});
