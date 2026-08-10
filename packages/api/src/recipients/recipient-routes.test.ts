// The recipient surface's HTTP contract, through the REAL `createApp`.
//
// What this file proves that the use-case suite cannot: the routes sit inside
// the authenticated scope (so they get session validation and CSRF because of
// WHERE they are registered), the schemas refuse the fields a caller must not
// supply, and the log lines carry no participant's name or address.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type RecipientDependencies,
  type SessionId, type ArtifactId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type {
  ContactId, DocumentId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerRecipientRoutes } from "./recipient-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const WORKSPACE = "ws_rcp" as WorkspaceId;
const DOC = "doc_rcp" as DocumentId;
const CONTACT = "con_maria" as ContactId;

/** Details that would be a real disclosure if they reached a log. */
const SENSITIVE_NAME = "Maria Santos-Reyes";
const SENSITIVE_EMAIL = "maria.santos@ayalaland.com.ph";

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
  transactions.store.contacts.push({
    contactId: CONTACT, workspaceId: WORKSPACE,
    name: SENSITIVE_NAME, email: SENSITIVE_EMAIL,
    emailKey: SENSITIVE_EMAIL as never,
    phone: null, organization: "Ayala Land", title: "General Counsel",
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });
}

/** Both generators behind one object, as the composition root wires them. */
function generators() {
  const recipients = new SequentialRecipientIds();
  const preparations = new SequentialPreparationIds();
  return {
    nextRecipientId: () => recipients.nextRecipientId(),
    nextPreparationId: () => preparations.nextPreparationId(),
    nextPreparationFieldId: () => preparations.nextPreparationFieldId(),
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
  seed(transactions);
  const ids = generators();

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
        recipients: (): RecipientDependencies => ({
          transactions, clock: new FixedClock(AT), ids,
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

const URL = `/workspaces/${WORKSPACE}/documents/${DOC}/recipients`;

const manual = (over: Record<string, unknown> = {}) => ({
  source: "manual",
  name: SENSITIVE_NAME,
  email: SENSITIVE_EMAIL,
  type: "signer",
  ...over,
});

async function add(h: Harness, payload: Record<string, unknown>) {
  const { cookie, csrf } = await h.signIn(OWNER);
  return h.app.inject({
    method: "POST", url: URL,
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    payload,
  });
}

// ── The scope's protections ─────────────────────────────────────────────────

describe("recipient routes — the scope's protections", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    for (const [method, url, payload] of [
      ["GET", URL, undefined],
      ["POST", URL, manual()],
      ["PATCH", `${URL}/rcp_1`, { name: "X" }],
      ["DELETE", `${URL}/rcp_1`, undefined],
      ["PUT", `${URL}/order`, { recipientIds: [] }],
    ] as const) {
      const response = await h.app.inject({
        method, url, ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, method).toBe(401);
    }
    expect(h.transactions.store.recipients).toHaveLength(0);
  });

  it("refuses a mutation without a CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: URL, headers: { cookie }, payload: manual(),
    });
    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.recipients).toHaveLength(0);
  });

  it("does not cache a recipient list", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("gives a non-member 404", async () => {
    const h = await harness();
    const { cookie } = await h.signIn("usr_outsider" as UserId);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it("gives an auditor 404 on a mutation and 200 on a read", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(AUDITOR);
    expect((await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf }, payload: manual(),
    })).statusCode).toBe(404);
    expect((await h.app.inject({
      method: "GET", url: URL, headers: { cookie },
    })).statusCode).toBe(200);
  });
});

// ── The wire contract ───────────────────────────────────────────────────────

describe("the request schema", () => {
  it("creates a recipient and returns 201", async () => {
    const h = await harness();
    const response = await add(h, manual());
    expect(response.statusCode).toBe(201);
    const body = response.json<{ recipientId: string; orderIndex: number }>();
    expect(body.recipientId).not.toBe("");
    expect(body.orderIndex).toBe(0);
  });

  it("refuses a name or email alongside a contact id", async () => {
    // The union's whole purpose: a caller cannot send a contact id and a
    // contradicting name and leave the server choosing which it believes.
    const h = await harness();
    const response = await add(h, {
      source: "contact", contactId: CONTACT, type: "signer", name: "Someone Else",
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a client-chosen recipient id", async () => {
    const h = await harness();
    expect((await add(h, manual({ recipientId: "rcp_mine" }))).statusCode).toBe(422);
  });

  it("refuses a client-claimed provenance", async () => {
    const h = await harness();
    expect((await add(h, manual({ sourceContactId: CONTACT }))).statusCode).toBe(422);
  });

  it("refuses a client-chosen order index", async () => {
    const h = await harness();
    expect((await add(h, manual({ orderIndex: 7 }))).statusCode).toBe(422);
  });

  it("refuses every authentication and ceremony claim", async () => {
    const h = await harness();
    for (const forbidden of [
      { userId: "usr_someone" },
      { emailVerified: true },
      { verifiedAt: "2026-08-10T00:00:00.000Z" },
      { accessToken: "tok" },
      { signedAt: "2026-08-10T00:00:00.000Z" },
      { emailSentAt: "2026-08-10T00:00:00.000Z" },
    ]) {
      const response = await add(h, manual({ ...forbidden, email: "x@y.com" }));
      expect(response.statusCode, JSON.stringify(forbidden)).toBe(422);
    }
    expect(h.transactions.store.recipients).toHaveLength(0);
  });

  it("refuses an unknown recipient type", async () => {
    const h = await harness();
    // `witness` is plausible and the product does not have it (§31).
    expect((await add(h, manual({ type: "witness" }))).statusCode).toBe(422);
  });

  it("refuses a routing order below 1", async () => {
    const h = await harness();
    expect((await add(h, manual({ routingOrder: 0 }))).statusCode).toBe(422);
  });

  it("refuses an order list longer than the ceiling", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "PUT", url: `${URL}/order`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { recipientIds: Array.from({ length: 51 }, (_, i) => `rcp_${String(i)}`) },
    });
    expect(response.statusCode).toBe(422);
  });

  it("returns 409 on a duplicate address", async () => {
    const h = await harness();
    expect((await add(h, manual())).statusCode).toBe(201);
    expect((await add(h, manual({ name: "Another Person" }))).statusCode).toBe(409);
  });

  it("returns 204 with no body on removal", async () => {
    const h = await harness();
    const created = await add(h, manual());
    const { recipientId } = created.json<{ recipientId: string }>();
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "DELETE", url: `${URL}/${recipientId}`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("routes /order to the reorder handler, not to a recipient named order", async () => {
    const h = await harness();
    const created = await add(h, manual());
    const { recipientId } = created.json<{ recipientId: string }>();
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "PUT", url: `${URL}/order`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { recipientIds: [recipientId] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ recipients: unknown[] }>().recipients).toHaveLength(1);
  });

  it("exposes no comparison key and no identity claim in the response", async () => {
    const h = await harness();
    const response = await add(h, manual());
    const body = response.body;
    for (const absent of [
      "emailKey", "normalizedEmail", "userId", "emailVerified",
      "accessToken", "signedAt", "workspaceId", "preparationId",
    ]) {
      expect(body, `exposes ${absent}`).not.toContain(absent);
    }
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// A bare instance with a captured logger, for the same reason the preparation
// suite uses one: `createApp` builds its logger from configuration.

describe("recipient telemetry carries no participant details", () => {
  async function logged(): Promise<{ app: FastifyInstance; capture: LogCapture }> {
    const capture = createLogCapture();
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });
    const transactions = new FakeTransactionManager();
    seed(transactions);
    const ids = generators();

    registerRecipientRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      recipientDependencies: () => ({
        transactions, clock: new FixedClock(AT), ids,
      }),
    });
    await app.ready();
    return { app, capture };
  }

  it("logs the type and provenance flag, never the name or address", async () => {
    const { app, capture } = await logged();
    const response = await app.inject({
      method: "POST", url: URL,
      payload: { source: "contact", contactId: CONTACT, type: "approver" },
    });
    expect(response.statusCode).toBe(201);
    await app.close();

    const events = capture.lines().filter(l => l["event"] === "document.recipient.added");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("fixture");

    expect(event["recipientType"]).toBe("approver");
    // A boolean, not the contact id — which identifies the person as surely as
    // the address would.
    expect(event["fromContact"]).toBe(true);

    // The whole serialized line, so a nested field is caught.
    const line = JSON.stringify(event);
    for (const secret of [
      SENSITIVE_NAME, SENSITIVE_EMAIL, "ayalaland", "Ayala Land", CONTACT,
    ]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("logs which fields an edit changed, never their values", async () => {
    const { app, capture } = await logged();
    const created = await app.inject({
      method: "POST", url: URL,
      payload: { source: "manual", name: "Juan dela Cruz", email: "juan@x.com", type: "signer" },
    });
    const { recipientId } = created.json<{ recipientId: string }>();

    await app.inject({
      method: "PATCH", url: `${URL}/${recipientId}`,
      payload: { name: SENSITIVE_NAME, email: SENSITIVE_EMAIL },
    });
    await app.close();

    const events = capture.lines().filter(l => l["event"] === "document.recipient.updated");
    expect(events).toHaveLength(1);
    const line = JSON.stringify(events[0]);
    expect(events[0]?.["changedFields"]).toEqual(["email", "name"]);
    for (const secret of [SENSITIVE_NAME, SENSITIVE_EMAIL]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("logs a count on reorder, not the ids", async () => {
    const { app, capture } = await logged();
    const created = await app.inject({
      method: "POST", url: URL,
      payload: { source: "manual", name: "Juan dela Cruz", email: "juan@x.com", type: "signer" },
    });
    const { recipientId } = created.json<{ recipientId: string }>();

    await app.inject({
      method: "PUT", url: `${URL}/order`, payload: { recipientIds: [recipientId] },
    });
    await app.close();

    const events = capture.lines().filter(l => l["event"] === "document.recipient.reordered");
    expect(events).toHaveLength(1);
    expect(events[0]?.["recipientCount"]).toBe(1);
    // An id is a stable pseudonymous handle per party; a log that carries them
    // across every reorder builds a participation graph.
    expect(JSON.stringify(events[0])).not.toContain(recipientId);
  });

  it("does not log reads", async () => {
    const { app, capture } = await logged();
    await app.inject({ method: "GET", url: URL });
    await app.close();
    expect(capture.lines().map(l => l["event"]))
      .not.toContain("document.recipient.listed");
  });
});
