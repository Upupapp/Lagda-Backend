// Contact requests (086) through the REAL createApp: session + CSRF, the
// wire shapes, member vs external delivery, the /me lists and the errors.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, type UserId, type WorkspaceId, type WorkspaceMemberId } from "@lagda/contracts";
import {
  createSessionService, createTemplateRegistry, ALL_TEMPLATES, assertNormalized,
  type SessionRepository, type SessionRecord, type NewSession,
  type ContactRequestDependencies, type ContactDependencies,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialContactIds,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const WS = "ws_cr" as WorkspaceId;
const SENDER = "usr_sender" as UserId;
const COLLEAGUE = "usr_colleague" as UserId;
const REVIEWER = "usr_reviewer" as UserId;

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

interface Harness {
  readonly app: FastifyInstance;
  readonly transactions: FakeTransactionManager;
  readonly as: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
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
    policy: { absoluteLifetimeMs: 3_600_000, idleTimeoutMs: 3_600_000, touchIntervalMs: 300_000 },
  });
  const transactions = new FakeTransactionManager();
  const store = transactions.store;
  store.workspaces.set(WS, { workspaceId: WS, name: "Acme Legal", createdAt: AT });
  for (const [userId, role, email] of [
    [SENDER, "sender", "sender@example.com"],
    [COLLEAGUE, "sender", "colleague@example.com"],
    [REVIEWER, "reviewer", "reviewer@example.com"],
  ] as const) {
    store.accountEmails.set(assertNormalized(email), userId);
    store.memberships.push({
      memberId: `mem_${userId}` as WorkspaceMemberId, workspaceId: WS, userId, role, createdAt: AT,
    });
  }
  const contact = (id: string, email: string) => ({
    contactId: id as never, workspaceId: WS, name: `Name ${id}`, email,
    emailKey: email as never, phone: null, organization: null, title: null,
    createdAt: AT, updatedAt: AT, archivedAt: null,
    scope: "workspace" as const, ownerUserId: null, note: null, tagIds: [],
  });
  store.contacts.push(contact("con_colleague", "colleague@example.com"),
    contact("con_external", "maria@outside.example"));
  store.documents.push({
    documentId: "doc_1" as never, workspaceId: WS, title: "Lease", originalFilename: null,
    createdByUserId: SENDER, folderId: null, createdAt: AT, updatedAt: AT,
  }, {
    documentId: "doc_answer" as never, workspaceId: WS, title: "Answer", originalFilename: null,
    createdByUserId: COLLEAGUE, folderId: null, createdAt: AT, updatedAt: AT,
  });

  let seq = 0;
  const contactRequests = (): ContactRequestDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    ids: { nextContactRequestId: () => `cr_${++seq}` as never },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${++seq}` as never,
      nextNotificationDeliveryId: () => `ndel_${++seq}` as never,
    },
  });
  const contactIds = new SequentialContactIds();

  const app = await createApp({
    config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: {
        isReachable: () => Promise.resolve(true),
        hasCurrentSchema: () => Promise.resolve(true),
      },
      sessions,
      workspaces: {
        create: () => ({}) as never,
        list: () => ({ transactions }),
        workspace: () => ({ transactions }),
        contacts: (): ContactDependencies => ({ transactions, clock: new FixedClock(AT), ids: contactIds }),
        contactRequests,
      },
    },
  });
  open = app;
  return {
    app, transactions,
    as: async userId => {
      const issued = await sessions.issue(userId);
      return { cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`, csrf: issued.csrfToken };
    },
  };
}

async function call(
  h: Harness, userId: UserId, method: "GET" | "POST", url: string, payload?: unknown,
) {
  const { cookie, csrf } = await h.as(userId);
  return h.app.inject({
    method, url, headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

const BASE = `/workspaces/${WS}/contact-requests`;

describe("contact request routes", () => {
  it("requires a session, and CSRF on writes", async () => {
    const h = await harness();
    for (const [method, url] of [
      ["POST", BASE], ["GET", `${BASE}/cr_1`], ["POST", `${BASE}/cr_1/complete`],
      ["POST", `${BASE}/cr_1/decline`], ["POST", `${BASE}/cr_1/cancel`],
      ["GET", `/workspaces/${WS}/contacts/con_external/requests`],
      ["GET", "/me/contact-requests"], ["GET", "/me/contact-requests/sent"],
    ] as const) {
      const response = await h.app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    const { cookie } = await h.as(SENDER);
    const noCsrf = await h.app.inject({
      method: "POST", url: BASE, headers: { cookie },
      payload: { kind: "upload", contactId: "con_external", title: "x" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(h.transactions.store.contactRequests).toHaveLength(0);
  });

  it("creates an in-app request for a member, with the documented shape", async () => {
    const h = await harness();
    const response = await call(h, SENDER, "POST", BASE, {
      kind: "signed-document", contactId: "con_colleague", title: "Signed lease",
      message: "Please sign and upload", documentId: "doc_1", dueAt: "2026-10-01T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      requestId: "cr_1", workspaceId: WS, workspaceName: "Acme Legal",
      kind: "signed-document", status: "pending", title: "Signed lease",
      message: "Please sign and upload", documentId: "doc_1", documentTitle: "Lease",
      dueAt: "2026-10-01T00:00:00.000Z",
      contact: { contactId: "con_colleague", name: "Name con_colleague", email: "colleague@example.com" },
      delivery: "in-app",
      recipient: { userId: COLLEAGUE, displayName: "A colleague" },
      requestedBy: { userId: SENDER, displayName: "A colleague" },
      responseDocumentId: null, declineReason: null,
      createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
      completedAt: null, declinedAt: null, cancelledAt: null,
    });
  });

  it("emails an external contact, and refuses preparation for one with 422", async () => {
    const h = await harness();
    const emailed = await call(h, SENDER, "POST", BASE, {
      kind: "upload", contactId: "con_external", title: "Permit",
    });
    expect(emailed.statusCode).toBe(201);
    expect(emailed.json<{ delivery: string; recipient: unknown }>())
      .toMatchObject({ delivery: "email", recipient: null });

    const refused = await call(h, SENDER, "POST", BASE, {
      kind: "preparation", contactId: "con_external", title: "Prepare", documentId: "doc_1",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("contact_request_members_only");
  });

  it("refuses a sender without the capability as not found", async () => {
    const h = await harness();
    const response = await call(h, REVIEWER, "POST", BASE, {
      kind: "upload", contactId: "con_external", title: "x",
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists it under /me/contact-requests for the member, who completes it", async () => {
    const h = await harness();
    await call(h, SENDER, "POST", BASE, { kind: "upload", contactId: "con_colleague", title: "Upload" });
    const others = await call(h, COLLEAGUE, "GET", "/me/contact-requests");
    expect(others.statusCode).toBe(200);
    expect(others.json<{ items: { requestId: string; status: string }[] }>().items)
      .toMatchObject([{ requestId: "cr_1", status: "pending" }]);
    expect((await call(h, SENDER, "GET", "/me/contact-requests")).json<{ items: unknown[] }>().items)
      .toEqual([]);

    const done = await call(h, COLLEAGUE, "POST", `${BASE}/cr_1/complete`, { documentId: "doc_answer" });
    expect(done.statusCode).toBe(200);
    expect(done.json<{ status: string; responseDocumentId: string }>())
      .toMatchObject({ status: "completed", responseDocumentId: "doc_answer" });

    const again = await call(h, COLLEAGUE, "POST", `${BASE}/cr_1/complete`, { documentId: "doc_answer" });
    expect(again.statusCode).toBe(409);

    const sent = await call(h, SENDER, "GET", "/me/contact-requests/sent?status=completed");
    expect(sent.json<{ items: { requestId: string }[] }>().items.map(i => i.requestId)).toEqual(["cr_1"]);
    const onContact = await call(h, SENDER, "GET", `/workspaces/${WS}/contacts/con_colleague/requests`);
    expect(onContact.json<{ items: { status: string }[] }>().items).toMatchObject([{ status: "completed" }]);
  });

  it("declines and cancels", async () => {
    const h = await harness();
    const first = (await call(h, SENDER, "POST", BASE, { kind: "upload", contactId: "con_colleague", title: "A" }))
      .json<{ requestId: string }>().requestId;
    const second = (await call(h, SENDER, "POST", BASE, { kind: "upload", contactId: "con_colleague", title: "B" }))
      .json<{ requestId: string }>().requestId;
    const noReason = await call(h, COLLEAGUE, "POST", `${BASE}/${first}/decline`, {});
    expect(noReason.statusCode).toBe(422);
    const blank = await call(h, COLLEAGUE, "POST", `${BASE}/${first}/decline`, { reason: "" });
    expect(blank.statusCode).toBe(422);
    const declined = await call(h, COLLEAGUE, "POST", `${BASE}/${first}/decline`, { reason: "No" });
    expect(declined.json<{ status: string; declineReason: string }>())
      .toMatchObject({ status: "declined", declineReason: "No" });
    const notMine = await call(h, COLLEAGUE, "POST", `${BASE}/${second}/cancel`);
    expect(notMine.statusCode).toBe(422);
    const cancelled = await call(h, SENDER, "POST", `${BASE}/${second}/cancel`);
    expect(cancelled.json<{ status: string }>().status).toBe("cancelled");
  });

  it("puts workspaceMember on every contact", async () => {
    const h = await harness();
    const list = await call(h, SENDER, "GET", `/workspaces/${WS}/contacts`);
    const items = list.json<{ items: { contactId: string; workspaceMember: unknown }[] }>().items;
    expect(Object.fromEntries(items.map(i => [i.contactId, i.workspaceMember]))).toEqual({
      con_colleague: { userId: COLLEAGUE, displayName: COLLEAGUE },
      con_external: null,
    });
  });
});
