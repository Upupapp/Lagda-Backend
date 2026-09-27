// Document sharing (087) through the REAL createApp: session + CSRF, the wire
// shapes of every surface, status codes and error codes.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CSRF_TOKEN_HEADER, type DocumentId, type UserId, type VerificationId, type WorkspaceId,
  type WorkspaceMemberId,
} from "@lagda/contracts";
import {
  createSessionService, createTemplateRegistry, ALL_TEMPLATES,
  type SessionRepository, type SessionRecord, type NewSession,
  type DocumentSharingDependencies, type SharingAccount,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, createInMemoryObjectStorage,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const WS = "ws_share" as WorkspaceId;
const VID = "LAGDA-VER-2026-A7bK9mQ2xZ" as VerificationId;
const SENDER = "usr_sender" as UserId;
const JUAN = "usr_juan" as UserId;
const ANA = "usr_ana" as UserId;
const PDF = new TextEncoder().encode("%PDF-1.7 sealed");

const ACCOUNTS: Record<string, SharingAccount> = {
  [SENDER]: { email: "sender@example.com", normalizedEmail: "sender@example.com", emailVerified: true, displayName: "Sam" },
  [JUAN]: { email: "juan@example.com", normalizedEmail: "juan@example.com", emailVerified: true, displayName: "Juan" },
  [ANA]: { email: "ana@example.com", normalizedEmail: "ana@example.com", emailVerified: false, displayName: "Ana" },
};

function fakeSessionRepository(): SessionRepository {
  const rows = new Map<string, SessionRecord>();
  return {
    findByTokenHash: hash => Promise.resolve([...rows.values()].find(r => r.tokenHash === hash) ?? null),
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
  store.workspaces.set(WS, { workspaceId: WS, name: "Reyes Legal", createdAt: AT });
  store.memberships.push({
    memberId: "mem_sender" as WorkspaceMemberId, workspaceId: WS, userId: SENDER, role: "sender", createdAt: AT,
  });
  store.verifiedAccounts.set("juan@example.com", { userId: JUAN, displayName: "Juan" });
  store.documents.push({
    documentId: "doc_done" as DocumentId, workspaceId: WS, title: "Office Lease", originalFilename: null,
    createdByUserId: SENDER, folderId: null, createdAt: AT, updatedAt: AT,
  });
  store.completedDocuments.push({
    record: {
      workspaceId: WS, documentId: "doc_done" as DocumentId, signingRequestId: "txn_1", verificationId: VID,
      documentTitle: "Office Lease", completedAt: AT - 1000, ownerUserId: SENDER, participantCount: 1,
    },
    participantEmails: ["maria@example.com"],
    projection: {
      documentTitle: "Office Lease", completedAt: AT - 1000, sealedDigest: "b".repeat(64),
      participants: [{ requestRecipientId: "srr_m", name: "Maria", email: "maria@example.com",
        recipientType: "signer", routingOrder: 1, orderIndex: 0 }],
      events: [{ eventType: "signature-completed", recipientId: "srr_m", occurredAt: AT - 2000 }],
    },
    documentRef: { storageReference: "ws_share/doc_done/sealed.pdf", mediaType: "application/pdf", sizeBytes: PDF.byteLength },
  });
  await transactions.runForWorkspace(WS, uow =>
    uow.branding.saveLogo({ bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 4, digest: "c".repeat(64) }, AT));
  const storage = createInMemoryObjectStorage();
  await storage.putObject({
    ref: { zone: "artifacts", key: "ws_share/doc_done/sealed.pdf" as never },
    content: { kind: "bytes", bytes: PDF }, mediaType: "application/pdf",
  });

  let seq = 0;
  const documentSharing = (): DocumentSharingDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    ids: {
      nextDocumentShareId: () => `dsh_${++seq}` as never,
      nextDocumentAccessRequestId: () => `dar_${++seq}` as never,
    },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${++seq}` as never,
      nextNotificationDeliveryId: () => `ndel_${++seq}` as never,
    },
    storage,
    currentAccount: userId => Promise.resolve(ACCOUNTS[userId] ?? null),
  });

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
        documentSharing,
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function call(h: Harness, userId: UserId, method: Method, url: string, payload?: unknown) {
  const { cookie, csrf } = await h.as(userId);
  return h.app.inject({
    method, url, headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

const SHARES = `/workspaces/${WS}/documents/doc_done/shares`;
const ISO = new Date(AT).toISOString();

describe("document sharing routes", () => {
  it("requires a session everywhere, and CSRF on writes", async () => {
    const h = await harness();
    for (const [method, url] of [
      ["GET", SHARES], ["POST", SHARES], ["PATCH", `${SHARES}/dsh_1`], ["DELETE", `${SHARES}/dsh_1`],
      ["GET", `/workspaces/${WS}/access-requests`], ["POST", `/workspaces/${WS}/access-requests/dar_1/approve`],
      ["DELETE", `/workspaces/${WS}/access-requests/dar_1`], ["GET", `/workspaces/${WS}/shared-by-me`],
      ["GET", "/me/shared-documents"], ["POST", "/me/shared-documents/dsh_1/accept"],
      ["GET", "/me/shared-documents/dsh_1/document"], ["GET", "/me/shared-documents/dsh_1/branding/logo"],
      ["POST", `/verifications/${VID}/access-requests`], ["GET", `/verifications/${VID}/my-access`],
    ] as const) {
      const response = await h.app.inject({
        method, url, ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    const { cookie } = await h.as(SENDER);
    const noCsrf = await h.app.inject({
      method: "POST", url: SHARES, headers: { cookie }, payload: { email: "juan@example.com" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(h.transactions.store.documentShares).toHaveLength(0);
  });

  it("owner: create, list, edit the address, remove — with the documented shapes", async () => {
    const h = await harness();
    const created = await call(h, SENDER, "POST", SHARES, { email: "Juan@Example.com", fullName: "Juan Cruz" });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toEqual({
      shareId: "dsh_1", documentId: "doc_done", verificationId: VID, email: "Juan@Example.com",
      fullName: "Juan Cruz", status: "pending", recipient: null,
      sharedBy: { userId: SENDER, displayName: "A LAGDA user" },
      removedBy: null, replacesShareId: null, recipientDeleted: false,
      createdAt: ISO, updatedAt: ISO, respondedAt: null, removedAt: null,
    });

    const listed = await call(h, SENDER, "GET", SHARES);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      document: {
        documentId: "doc_done", verificationId: VID, documentTitle: "Office Lease",
        completedAt: new Date(AT - 1000).toISOString(), participantCount: 1,
      },
      shares: [{ shareId: "dsh_1" }],
    });

    const moved = await call(h, SENDER, "PATCH", `${SHARES}/dsh_1`, { email: "other@example.com" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      share: { email: "other@example.com", status: "pending", replacesShareId: "dsh_1" },
      previous: { shareId: "dsh_1", status: "removed", removedBy: "email-changed" },
    });
    const newId = moved.json<{ share: { shareId: string } }>().share.shareId;

    const removed = await call(h, SENDER, "DELETE", `${SHARES}/${newId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ status: "removed", removedBy: "owner" });
    const again = await call(h, SENDER, "DELETE", `${SHARES}/${newId}`);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("sharing_state_conflict");
  });

  it("owner errors: participant 409, invalid email 422, unknown field 422, not a manager 404", async () => {
    const h = await harness();
    const participant = await call(h, SENDER, "POST", SHARES, { email: "maria@example.com" });
    expect(participant.statusCode).toBe(409);
    expect(participant.json<{ error: { code: string } }>().error.code).toBe("document_share_recipient_has_access");
    const invalid = await call(h, SENDER, "POST", SHARES, { email: "nope" });
    expect(invalid.statusCode).toBe(422);
    const outsider = await call(h, JUAN, "POST", SHARES, { email: "x@example.com" });
    expect(outsider.statusCode).toBe(404);
    const extra = await call(h, SENDER, "POST", SHARES, { email: "x@example.com", role: "owner" });
    // Unknown fields are refused by the schema, never ignored.
    expect(extra.statusCode).toBe(422);
  });

  it("recipient: list with branding + logo url, accept, open the PDF and details, remove access", async () => {
    const h = await harness();
    await call(h, SENDER, "POST", SHARES, { email: "juan@example.com" });

    const pending = await call(h, JUAN, "GET", "/me/shared-documents?status=pending");
    expect(pending.statusCode).toBe(200);
    const [item] = pending.json<{ items: Record<string, unknown>[] }>().items;
    expect(item).toMatchObject({
      id: "dsh_1", kind: "share", status: "pending", verificationId: VID, documentTitle: "Office Lease",
      completedAt: new Date(AT - 1000).toISOString(), progress: { participants: 1, completed: 1 },
      branding: {
        displayName: "Reyes Legal", primaryColor: null,
        logo: { version: "c".repeat(64), width: 4, height: 4,
          url: `/me/shared-documents/dsh_1/branding/logo?v=${"c".repeat(64)}` },
      },
      actions: ["accept", "reject"],
    });
    const logo = await call(h, JUAN, "GET", "/me/shared-documents/dsh_1/branding/logo");
    expect(logo.statusCode).toBe(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["cache-control"]).toBe("private, max-age=300");

    // Not accepted yet: nothing opens.
    expect((await call(h, JUAN, "GET", "/me/shared-documents/dsh_1/document")).statusCode).toBe(404);

    const accepted = await call(h, JUAN, "POST", "/me/shared-documents/dsh_1/accept");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "accepted", actions: ["open", "remove-access"] });

    const pdf = await call(h, JUAN, "GET", "/me/shared-documents/dsh_1/document");
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["cache-control"]).toBe("no-store");
    expect(pdf.rawPayload.toString()).toBe("%PDF-1.7 sealed");

    const details = await call(h, JUAN, "GET", "/me/shared-documents/dsh_1/details");
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      details: { documentTitle: "Office Lease", participants: [{ maskedEmail: "m•••@example.com", status: "signed" }] },
    });

    // Another account cannot reach it at all.
    expect((await call(h, ANA, "GET", "/me/shared-documents/dsh_1")).statusCode).toBe(404);

    const removed = await call(h, JUAN, "POST", "/me/shared-documents/dsh_1/remove-access");
    expect(removed.statusCode).toBe(204);
    expect((await call(h, JUAN, "GET", "/me/shared-documents/dsh_1/document")).statusCode).toBe(404);
  });

  it("recipient: reject, withdraw, reject, delete (204)", async () => {
    const h = await harness();
    await call(h, SENDER, "POST", SHARES, { email: "juan@example.com" });
    expect((await call(h, JUAN, "POST", "/me/shared-documents/dsh_1/reject")).json()).toMatchObject({ status: "rejected" });
    expect((await call(h, JUAN, "POST", "/me/shared-documents/dsh_1/withdraw-rejection")).json())
      .toMatchObject({ status: "pending" });
    await call(h, JUAN, "POST", "/me/shared-documents/dsh_1/reject");
    const deleted = await call(h, JUAN, "DELETE", "/me/shared-documents/dsh_1");
    expect(deleted.statusCode).toBe(204);
    const rejected = await call(h, JUAN, "GET", "/me/shared-documents?status=rejected");
    expect(rejected.json()).toEqual({ items: [] });
  });

  it("requester: my-access, request (201), duplicate (409), unverified (403); owner decides", async () => {
    const h = await harness();
    const before = await call(h, JUAN, "GET", `/verifications/${VID}/my-access`);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      verificationId: VID, relation: "none", shareId: null, requestId: null, canRequestAccess: true,
    });

    const asked = await call(h, JUAN, "POST", `/verifications/${VID}/access-requests`, { note: "Tenant" });
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toEqual({
      requestId: "dar_1", verificationId: VID, documentTitle: "Office Lease", status: "pending",
      note: "Tenant", createdAt: ISO,
    });
    const duplicate = await call(h, JUAN, "POST", `/verifications/${VID}/access-requests`, {});
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("document_access_request_pending");
    const unverified = await call(h, ANA, "POST", `/verifications/${VID}/access-requests`, {});
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json<{ error: { code: string } }>().error.code).toBe("account_email_unverified");
    const unknown = await call(h, JUAN, "POST", "/verifications/LAGDA-VER-2026-Zz9Yy8Xx7W/access-requests", {});
    expect(unknown.statusCode).toBe(404);

    const list = await call(h, SENDER, "GET", `/workspaces/${WS}/access-requests?status=pending`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{
        requestId: "dar_1", status: "pending", note: "Tenant",
        requester: { userId: JUAN, displayName: "Juan", email: "juan@example.com" },
        document: { verificationId: VID },
      }],
    });

    const approved = await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", decidedAt: ISO });
    expect((await call(h, JUAN, "GET", `/verifications/${VID}/my-access`)).json())
      .toMatchObject({ relation: "shared-accepted", requestId: "dar_1" });
    expect((await call(h, JUAN, "GET", "/me/shared-documents")).json())
      .toMatchObject({ items: [{ id: "dar_1", kind: "access-request", status: "accepted" }] });

    const byMe = await call(h, SENDER, "GET", `/workspaces/${WS}/shared-by-me`);
    expect(byMe.json()).toMatchObject({ items: [{ approvedRequests: 1, acceptedShares: 0 }] });

    const removed = await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/remove`);
    expect(removed.json()).toMatchObject({ status: "removed" });
  });

  it("owner: reject, withdraw-rejection, reject, delete (204)", async () => {
    const h = await harness();
    await call(h, JUAN, "POST", `/verifications/${VID}/access-requests`, {});
    expect((await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/reject`)).json())
      .toMatchObject({ status: "rejected" });
    expect((await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/withdraw-rejection`)).json())
      .toMatchObject({ status: "pending", decidedBy: null });
    await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/reject`);
    const deleted = await call(h, SENDER, "DELETE", `/workspaces/${WS}/access-requests/dar_1`);
    expect(deleted.statusCode).toBe(204);
    expect((await call(h, SENDER, "GET", `/workspaces/${WS}/access-requests`)).json()).toEqual({ items: [] });
    const gone = await call(h, SENDER, "POST", `/workspaces/${WS}/access-requests/dar_1/approve`);
    expect(gone.statusCode).toBe(404);
  });

  it("registers no route without the dependency", async () => {
    const sessions = createSessionService({
      sessions: fakeSessionRepository(), tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(), clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 3_600_000, idleTimeoutMs: 3_600_000, touchIntervalMs: 300_000 },
    });
    const transactions = new FakeTransactionManager();
    const app = await createApp({
      config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true), hasCurrentSchema: () => Promise.resolve(true) },
        sessions,
        workspaces: { create: () => ({}) as never, list: () => ({ transactions }), workspace: () => ({ transactions }) },
      },
    });
    open = app;
    const issued = await sessions.issue(JUAN);
    const response = await app.inject({
      method: "GET", url: "/me/shared-documents",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
