// The preparation surface's HTTP contract, through the REAL `createApp`.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type PreparationDependencies,
  type SessionId, type ArtifactId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { DocumentId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerPreparationRoutes } from "./preparation-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const WORKSPACE = "ws_prep" as WorkspaceId;
const DOC = "doc_prep" as DocumentId;

/** A label that would be a real disclosure if it reached a log. */
const SENSITIVE_LABEL = "Mabini Holdings guarantor signature";

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

function seed(transactions: FakeTransactionManager): void {
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
  transactions.store.documents.push({
    documentId: DOC, workspaceId: WORKSPACE, title: "Office Lease",
    originalFilename: "lease.pdf", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT,
  });
  transactions.store.artifacts.push({
    artifactId: "art_original" as ArtifactId,
    workspaceId: WORKSPACE, documentId: DOC, artifactType: "original",
    storageReference: "ws/doc/art" as never,
    mediaType: "application/pdf", sizeBytes: 204_800,
    digestAlgorithm: "sha-256", digest: "d".repeat(64) as never,
    pageCount: 5, rotatedPageCount: 0, createdAt: AT,
  });
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
  seed(transactions);
  const preparationIds = new SequentialPreparationIds();

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock: new FixedClock(AT),
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
        preparation: (): PreparationDependencies => ({
          transactions, clock: new FixedClock(AT), ids: preparationIds,
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

const URL = `/workspaces/${WORKSPACE}/documents/${DOC}/preparation`;

const field = (over: Record<string, unknown> = {}) => ({
  type: "signature",
  pageNumber: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  required: true,
  label: SENSITIVE_LABEL,
  layer: 0,
  ...over,
});

async function save(h: Harness, body: Record<string, unknown>) {
  const { cookie, csrf } = await h.signIn(OWNER);
  return h.app.inject({
    method: "PUT", url: URL,
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    payload: body,
  });
}

// ── The scope's protections ─────────────────────────────────────────────────

describe("preparation routes — the scope's protections", () => {
  it("refuses both routes anonymously", async () => {
    const h = await harness();
    for (const [method, payload] of [
      ["GET", undefined],
      ["PUT", { expectedRevision: 0, fields: [] }],
    ] as const) {
      const response = await h.app.inject({
        method, url: URL, ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, method).toBe(401);
    }
    expect(h.transactions.store.preparations).toHaveLength(0);
  });

  it("refuses a save with a session but no CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "PUT", url: URL, headers: { cookie },
      payload: { expectedRevision: 0, fields: [] },
    });
    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.preparations).toHaveLength(0);
  });

  it("marks both responses no-store", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── Contract ────────────────────────────────────────────────────────────────

describe("GET preparation", () => {
  it("returns an empty editable layout with the page count", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      revision: 0, state: "editable", fields: [], pageCount: 5,
    });
  });

  it("exposes no artifact, storage or digest field", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const body = (await h.app.inject({ method: "GET", url: URL, headers: { cookie } }))
      .json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      "createdAt", "documentId", "fields", "pageCount", "preparationId",
      "revision", "state", "updatedAt",
    ]);
  });
});

describe("PUT preparation", () => {
  it("saves a layout and advances the revision", async () => {
    const h = await harness();
    const response = await save(h, { expectedRevision: 0, fields: [field()] });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ revision: number; fields: { fieldId: string }[] }>();
    expect(body.revision).toBeGreaterThan(0);
    expect(body.fields).toHaveLength(1);
    expect(body.fields[0]?.fieldId).toMatch(/^pf_/);
  });

  it("REJECTS a signer's answer rather than ignoring it", async () => {
    // Preparation records the REQUEST, never the response.
    const h = await harness();
    for (const extra of [
      { value: "Juan Dela Cruz" },
      { signatureValue: "data:image/png;base64,AAA" },
      { signedAt: "2026-08-10T00:00:00Z" },
    ]) {
      const response = await save(h, {
        expectedRevision: 0, fields: [field(extra)],
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(422);
    }
    expect(h.transactions.store.preparations).toHaveLength(0);
  });

  it("REJECTS attempts to repoint, lock or move the preparation", async () => {
    const h = await harness();
    for (const body of [
      { expectedRevision: 0, fields: [], sourceArtifactId: "art_other" },
      { expectedRevision: 0, fields: [], state: "locked" },
      { expectedRevision: 0, fields: [], lockedAt: "2026-08-10T00:00:00Z" },
      { expectedRevision: 0, fields: [], workspaceId: "ws_other" },
      { expectedRevision: 0, fields: [], preparationId: "prep_chosen" },
      { expectedRevision: 0, fields: [], revision: 99 },
    ]) {
      const response = await save(h, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it("REJECTS an unimplemented field type", async () => {
    const h = await harness();
    for (const type of ["radio-group", "multiline-text", "sender-text", "dropdown"]) {
      const response = await save(h, { expectedRevision: 0, fields: [field({ type })] });
      expect(response.statusCode, type).toBe(422);
    }
  });

  it("REJECTS page 0 and out-of-page geometry at the schema", async () => {
    const h = await harness();
    expect((await save(h, {
      expectedRevision: 0, fields: [field({ pageNumber: 0 })],
    })).statusCode).toBe(422);
    expect((await save(h, {
      expectedRevision: 0,
      fields: [field({ rect: { x: 1.5, y: 0.2, width: 0.3, height: 0.05 } })],
    })).statusCode).toBe(422);
  });

  it("REJECTS a layout beyond the field ceiling", async () => {
    const h = await harness();
    const response = await save(h, {
      expectedRevision: 0,
      fields: Array.from({ length: 501 }, () => field()),
    });
    expect(response.statusCode).toBe(422);
  });

  it("returns 409 for a stale revision", async () => {
    const h = await harness();
    const first = await save(h, { expectedRevision: 0, fields: [field()] });
    const revision = first.json<{ revision: number }>().revision;
    await save(h, { expectedRevision: revision, fields: [field({ layer: 1 })] });

    const stale = await save(h, { expectedRevision: revision, fields: [field()] });
    expect(stale.statusCode).toBe(409);
  });
});

// ── Authorization over HTTP ─────────────────────────────────────────────────

describe("capability enforcement over HTTP", () => {
  it("lets an AUDITOR read the layout and refuses their save with 404", async () => {
    const h = await harness();
    await save(h, { expectedRevision: 0, fields: [field()] });

    const { cookie, csrf } = await h.signIn(AUDITOR);
    const read = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ fields: unknown[] }>().fields).toHaveLength(1);

    const write = await h.app.inject({
      method: "PUT", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { expectedRevision: 2, fields: [] },
    });
    // The hidden 404, never a 403 that explains the policy.
    expect(write.statusCode).toBe(404);
  });

  it("gives a non-member 404", async () => {
    const h = await harness();
    const { cookie } = await h.signIn("usr_outsider" as UserId);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// A bare instance with a captured logger, for the same reason the contact and
// document suites use one: `createApp` builds its logger from configuration.

describe("preparation telemetry carries no layout", () => {
  async function logged(): Promise<{ app: FastifyInstance; capture: LogCapture }> {
    const capture = createLogCapture();
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });
    const transactions = new FakeTransactionManager();
    seed(transactions);

    registerPreparationRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      preparationDependencies: () => ({
        transactions, clock: new FixedClock(AT), ids: new SequentialPreparationIds(),
      }),
    });
    await app.ready();
    return { app, capture };
  }

  it("logs counts, never coordinates or labels", async () => {
    const { app, capture } = await logged();
    const response = await app.inject({
      method: "PUT", url: URL,
      payload: {
        expectedRevision: 0,
        fields: [field(), field({ pageNumber: 3, layer: 1, label: "Tenant initials" })],
      },
    });
    expect(response.statusCode).toBe(200);
    await app.close();

    const events = capture.lines()
      .filter(line => line["event"] === "document.preparation.saved");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("fixture");

    expect(event["fieldCount"]).toBe(2);
    expect(event["pagesUsed"]).toBe(2);

    // A layout says where every signature goes and its labels name the
    // parties. The whole serialized line, so a nested field is caught.
    const line = JSON.stringify(event);
    for (const secret of ["Mabini", "guarantor", "Tenant initials", "0.1", "rect"]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("does not log reads", async () => {
    // An editor polls this route; a line per poll would be noise that also
    // records how often a document is being worked on.
    const { app, capture } = await logged();
    await app.inject({ method: "GET", url: URL });
    await app.close();
    const events = capture.lines()
      .map(line => line["event"])
      .filter((event): event is string => typeof event === "string");
    expect(events.filter(event => event.startsWith("document.preparation")))
      .toHaveLength(0);
  });
});
