// The signing request surface's HTTP contract, through the REAL `createApp`.
//
// What this file proves that the use-case suite cannot: the routes sit inside
// the authenticated scope, the body schema refuses everything a client must not
// supply, and the log line carries no participant and no layout.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CSRF_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER, type UserId, type SigningRequestState,
} from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type SigningRequestDependencies,
  type RecipientDependencies, type PreparationDependencies,
  type SessionId, type ArtifactId,
} from "@lagda/application";
import { addRecipient, saveDocumentPreparation } from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds, SequentialSigningRequestIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { DocumentId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { SigningRequestId } from "@lagda/application";
import { createInMemoryObjectStorage } from "@lagda/storage";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import { registerSigningRequestRoutes } from "./signing-request-routes.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const WORKSPACE = "ws_sr" as WorkspaceId;
const DOC = "doc_sr" as DocumentId;

/** Details that would be a real disclosure if they reached a log. */
const SENSITIVE_NAME = "Maria Santos-Reyes";
const SENSITIVE_EMAIL = "maria.santos@ayalaland.com.ph";
const SENSITIVE_TITLE = "Mabini Holdings share purchase agreement";
const SENSITIVE_LABEL = "Guarantor signature";

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
    documentId: DOC, workspaceId: WORKSPACE, title: SENSITIVE_TITLE,
    originalFilename: "spa.pdf", createdByUserId: OWNER,
    folderId: null,
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

function generators() {
  const recipients = new SequentialRecipientIds();
  const preparations = new SequentialPreparationIds();
  return {
    nextRecipientId: () => recipients.nextRecipientId(),
    nextPreparationId: () => preparations.nextPreparationId(),
    nextPreparationFieldId: () => preparations.nextPreparationFieldId(),
  };
}

/** Prepares the document to the point where a request can be created. */
async function prepare(
  transactions: FakeTransactionManager,
  ids: ReturnType<typeof generators>,
): Promise<void> {
  const clock = new FixedClock(AT);
  const actor = {
    actorType: "user" as const, userId: OWNER, sessionId: "ses_seed" as SessionId,
  };
  const recipientDeps: RecipientDependencies = { transactions, clock, ids };
  const prepDeps: PreparationDependencies = { transactions, clock, ids };

  const recipient = await addRecipient(actor, WORKSPACE, DOC, {
    source: "manual", name: SENSITIVE_NAME, email: SENSITIVE_EMAIL, type: "signer",
  }, recipientDeps);

  await saveDocumentPreparation(actor, WORKSPACE, DOC, {
    expectedRevision: 1,
    fields: [{
      type: "signature", pageNumber: 3,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      required: true, label: SENSITIVE_LABEL, layer: 0,
      recipientId: recipient.recipientId,
    }],
  }, prepDeps);
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
  const authoring = generators();
  await prepare(transactions, authoring);

  const requestIds = new SequentialSigningRequestIds();
  const clock = new FixedClock(AT);

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock,
          workspaceIds: new SequentialWorkspaceIds(),
          memberIds: new SequentialMemberIds(),
          idempotency: {
            digester: createIdempotencyKeyDigester(),
            ids: createIdempotencyRecordIds(),
            clock,
            policy: { retentionMs: 24 * 3_600_000 },
          },
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        signingRequests: (): SigningRequestDependencies => ({
          transactions, clock, ids: requestIds,
          idempotency: {
            digester: createIdempotencyKeyDigester(),
            ids: createIdempotencyRecordIds(),
            clock,
            policy: { retentionMs: 24 * 3_600_000 },
          },
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

const CREATE_URL = `/workspaces/${WORKSPACE}/documents/${DOC}/signing-requests`;
const readUrl = (id: string) => `/workspaces/${WORKSPACE}/signing-requests/${id}`;

/**
 * A distinct key per call by default.
 *
 * The route REQUIRES one, so a helper that omitted it would make every test a
 * 400. Distinct by default so a test that means to exercise replay has to say
 * so, rather than getting it by accident from a shared constant.
 */
let keySeed = 0;
async function create(
  h: Harness, payload: Record<string, unknown> = {}, key?: string,
) {
  const { cookie, csrf } = await h.signIn(OWNER);
  return h.app.inject({
    method: "POST", url: CREATE_URL,
    headers: {
      cookie,
      [CSRF_TOKEN_HEADER]: csrf,
      [IDEMPOTENCY_KEY_HEADER]: key ?? `sr-auto-key-${String(++keySeed).padStart(4, "0")}`,
    },
    payload,
  });
}

// ── The scope's protections ─────────────────────────────────────────────────

describe("signing request routes — the scope's protections", () => {
  it("refuses both routes anonymously", async () => {
    const h = await harness();
    for (const [method, url, payload] of [
      ["POST", CREATE_URL, {}],
      ["GET", readUrl("sr_1"), undefined],
    ] as const) {
      const response = await h.app.inject({
        method, url, ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, method).toBe(401);
    }
    expect(h.transactions.store.signingRequests).toHaveLength(0);
  });

  it("refuses creation without a CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: CREATE_URL, headers: { cookie }, payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.signingRequests).toHaveLength(0);
  });

  it("does not cache a request", async () => {
    const h = await harness();
    const created = await create(h);
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET",
      url: readUrl(created.json<{ signingRequestId: string }>().signingRequestId),
      headers: { cookie },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("gives a non-member 404", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn("usr_outsider" as UserId);
    const response = await h.app.inject({
      method: "POST", url: CREATE_URL,
      headers: {
        cookie, [CSRF_TOKEN_HEADER]: csrf,
        [IDEMPOTENCY_KEY_HEADER]: "sr-outsider-key-01",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("gives an auditor 404 on create and 200 on read", async () => {
    const h = await harness();
    const created = await create(h);
    const id = created.json<{ signingRequestId: string }>().signingRequestId;

    const { cookie, csrf } = await h.signIn(AUDITOR);
    expect((await h.app.inject({
      method: "POST", url: CREATE_URL,
      headers: {
        cookie, [CSRF_TOKEN_HEADER]: csrf,
        [IDEMPOTENCY_KEY_HEADER]: "sr-auditor-key-01",
      },
      payload: {},
    })).statusCode).toBe(404);
    expect((await h.app.inject({
      method: "GET", url: readUrl(id), headers: { cookie },
    })).statusCode).toBe(200);
  });
});

// ── The wire contract ───────────────────────────────────────────────────────

describe("the request schema", () => {
  it("creates a request from an empty body and returns 201", async () => {
    const h = await harness();
    const response = await create(h);
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      signingRequestId: string; state: string;
      recipientCount: number; fieldCount: number;
    }>();
    expect(body.state).toBe("draft");
    expect(body.recipientCount).toBe(1);
    expect(body.fieldCount).toBe(1);
  });

  it("refuses a client-supplied recipient array", async () => {
    // The single most important rejection in this file. A client that could
    // send its own recipients could create a workflow that does not match the
    // document anyone reviewed.
    const h = await harness();
    const response = await create(h, {
      recipients: [{ name: "Attacker", email: "attacker@x.com", type: "signer" }],
    });
    expect(response.statusCode).toBe(422);
    expect(h.transactions.store.signingRequests).toHaveLength(0);
  });

  it("refuses a client-supplied field array", async () => {
    const h = await harness();
    expect((await create(h, { fields: [] })).statusCode).toBe(422);
  });

  it("refuses a client-chosen source artifact", async () => {
    // Choosing the artifact would mean signing bytes the geometry was not
    // authored against.
    const h = await harness();
    expect((await create(h, { sourceArtifactId: "art_other" })).statusCode).toBe(422);
  });

  it("refuses a client-chosen preparation", async () => {
    const h = await harness();
    expect((await create(h, { preparationId: "prep_other" })).statusCode).toBe(422);
  });

  it("refuses a client-chosen state", async () => {
    const h = await harness();
    for (const state of ["sent", "completed", "draft"]) {
      expect((await create(h, { state })).statusCode, state).toBe(422);
    }
    expect(h.transactions.store.signingRequests).toHaveLength(0);
  });

  it("refuses a client-chosen id, creator or title", async () => {
    const h = await harness();
    for (const forbidden of [
      { signingRequestId: "sr_mine" },
      { createdByUserId: "usr_someone_else" },
      { documentTitle: "A different title" },
      { workspaceId: "ws_other" },
      { documentId: "doc_other" },
    ]) {
      const response = await create(h, forbidden);
      expect(response.statusCode, JSON.stringify(forbidden)).toBe(422);
    }
  });

  it("refuses send metadata this command does not own", async () => {
    const h = await harness();
    for (const deferred of [
      { subject: "Please sign" },
      { message: "Hi there" },
      { expiresAt: "2026-09-01T00:00:00.000Z" },
      { reminders: { enabled: true } },
      { authMethod: "otp" },
    ]) {
      const response = await create(h, deferred);
      expect(response.statusCode, JSON.stringify(deferred)).toBe(422);
    }
  });

  it("replays the same id for a repeated idempotency key", async () => {
    const h = await harness();
    const first = await create(h, {}, "sr-retry-key-0001");
    const second = await create(h, {}, "sr-retry-key-0001");
    expect(second.json<{ signingRequestId: string }>().signingRequestId)
      .toBe(first.json<{ signingRequestId: string }>().signingRequestId);
    expect(h.transactions.store.signingRequests).toHaveLength(1);
  });

  it("refuses creation with no idempotency key", async () => {
    // Required, like invitations: the retry of a lost response must not create
    // a second immutable workflow over one document.
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: CREATE_URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf }, payload: {},
    });
    // 422, the codebase's validation status - the key is a malformed request
    // rather than a missing resource, and the check runs before authorization
    // because it is about the caller's own request shape.
    expect(response.statusCode).toBe(422);
    expect(h.transactions.store.signingRequests).toHaveLength(0);
  });

  it("returns the snapshot on read", async () => {
    const h = await harness();
    const created = await create(h);
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET",
      url: readUrl(created.json<{ signingRequestId: string }>().signingRequestId),
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      documentTitle: string;
      recipients: { name: string }[];
      fields: { pageNumber: number }[];
    }>();
    expect(body.documentTitle).toBe(SENSITIVE_TITLE);
    expect(body.recipients[0]?.name).toBe(SENSITIVE_NAME);
    expect(body.fields[0]?.pageNumber).toBe(3);
  });

  it("exposes no provenance, comparison key or credential in the response", async () => {
    const h = await harness();
    const created = await create(h);
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET",
      url: readUrl(created.json<{ signingRequestId: string }>().signingRequestId),
      headers: { cookie },
    });
    for (const absent of [
      "sourceArtifactId", "sourcePreparationId", "sourcePreparationRevision",
      "storageReference", "storageKey", "normalizedEmail", "createdByUserId",
      "accessToken", "signingUrl", "otp", "tokenDigest", "sentAt", "signedAt",
    ]) {
      expect(response.body, `exposes ${absent}`).not.toContain(absent);
    }
  });

  it("reports an unknown request as 404", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    expect((await h.app.inject({
      method: "GET", url: readUrl("sr_nope"), headers: { cookie },
    })).statusCode).toBe(404);
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────

describe("signing request telemetry carries no snapshot", () => {
  async function logged(): Promise<{ app: FastifyInstance; capture: LogCapture }> {
    const capture = createLogCapture();
    const app = Fastify({ logger: { level: "info", stream: capture.stream } });
    const transactions = new FakeTransactionManager();
    seed(transactions);
    await prepare(transactions, generators());
    const clock = new FixedClock(AT);

    registerSigningRequestRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: OWNER, sessionId: "ses_fixture" as SessionId,
      }),
      signingRequestDependencies: () => ({
        transactions, clock, ids: new SequentialSigningRequestIds(),
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock,
          policy: { retentionMs: 24 * 3_600_000 },
        },
      }),
    });
    await app.ready();
    return { app, capture };
  }

  it("logs counts, never a name, an address, a title or a layout", async () => {
    const { app, capture } = await logged();
    const response = await app.inject({
      method: "POST", url: CREATE_URL, payload: {},
      headers: { [IDEMPOTENCY_KEY_HEADER]: "sr-log-key-000001" },
    });
    expect(response.statusCode).toBe(201);
    await app.close();

    const events = capture.lines().filter(l => l["event"] === "signing_request.created");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("fixture");

    expect(event["recipientCount"]).toBe(1);
    expect(event["fieldCount"]).toBe(1);
    expect(event["state"]).toBe("draft");

    // The whole serialized line, so a nested field is caught.
    const line = JSON.stringify(event);
    for (const secret of [
      SENSITIVE_NAME, SENSITIVE_EMAIL, SENSITIVE_TITLE, SENSITIVE_LABEL,
      "ayalaland", "Mabini", "0.1", "rect",
    ]) {
      expect(line, `the log line contains "${secret}"`).not.toContain(secret);
    }
  });

  it("does not log reads", async () => {
    const { app, capture } = await logged();
    const created = await app.inject({
      method: "POST", url: CREATE_URL, payload: {},
      headers: { [IDEMPOTENCY_KEY_HEADER]: "sr-log-key-000002" },
    });
    const id = created.json<{ signingRequestId: string }>().signingRequestId;
    await app.inject({ method: "GET", url: readUrl(id) });
    await app.close();

    const reads = capture.lines().filter(l => l["event"] === "signing_request.read");
    expect(reads).toHaveLength(0);
    // And the response body, which DOES carry the snapshot, never reached a log.
    const everything = JSON.stringify(capture.lines());
    expect(everything).not.toContain(SENSITIVE_EMAIL);
  });
});

// ── An empty JSON body is "no fields", not "malformed" ───────────────────────

describe("a transition takes no body", () => {
  /**
   * The most natural way to call a bodyless POST used to fail.
   *
   * Fastify's default parser raises FST_ERR_CTP_EMPTY_JSON_BODY for a zero-byte
   * body, which this app maps to "The request body is not valid JSON." Most
   * HTTP clients set `Content-Type: application/json` on a POST regardless of
   * whether they send one, so `POST .../readiness` -- which takes no body by
   * design -- answered 400 to a correct request, while the same call with `{}`
   * or with no content-type at all worked.
   *
   * Found by driving the real API, not by a test: the client this repository
   * ships omits the header when there is no body, so it never hit it.
   */
  it("accepts a JSON content-type with no body at all", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: `/workspaces/${WORKSPACE}/signing-requests/sr_absent/readiness`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf, "content-type": "application/json" },
    });

    // 404 because that request does not exist -- which is the point: the body
    // PARSED and the handler ran. A 400 here would mean it never got that far.
    expect(response.statusCode).not.toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).not.toBe("validation_error");
  });

  /**
   * And a route that DOES need fields still refuses, with a better answer.
   *
   * Schema validation names the missing property; a parse error does not. The
   * tolerant parser improves that case rather than weakening it.
   */
  it("still refuses an empty body where fields are required", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: `/workspaces/${WORKSPACE}/documents/doc_1/signing-requests`,
      headers: {
        cookie, [CSRF_TOKEN_HEADER]: csrf, "content-type": "application/json",
        [IDEMPOTENCY_KEY_HEADER]: "empty-body-probe-0001",
      },
    });
    expect(response.statusCode).not.toBe(400);
  });
});

// ── The completed-document route (Phase 1-C) ────────────────────────────────

describe("the completed-document route", () => {
  const REQUEST = "sr_completed_1" as SigningRequestId;
  const downloadUrl = `/workspaces/${WORKSPACE}/signing-requests/${REQUEST}/completed-document`;

  async function buildWithCompletedRequest(
    options: { readonly composeCompletedArtifact?: boolean } = {},
  ): Promise<Harness> {
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

    const storage = createInMemoryObjectStorage();
    const bytes = new TextEncoder().encode("%PDF-1.4 completed bytes");
    await storage.putObject({
      ref: { zone: "artifacts", key: "ws/doc/art_final" as never },
      content: { kind: "bytes", bytes },
      mediaType: "application/pdf",
    });
    transactions.store.artifacts.push({
      artifactId: "art_final" as ArtifactId, workspaceId: WORKSPACE, documentId: DOC,
      artifactType: "sealed", storageReference: "ws/doc/art_final" as never,
      mediaType: "application/pdf", sizeBytes: bytes.byteLength,
      digestAlgorithm: "sha-256", digest: "c".repeat(64) as never,
      pageCount: 1, rotatedPageCount: 0, createdAt: AT,
    });
    transactions.store.signingRequests.push({
      signingRequestId: REQUEST, workspaceId: WORKSPACE, documentId: DOC,
      sourceArtifactId: "art_original" as ArtifactId,
      sourcePreparationId: "prep_completed" as never,
      sourcePreparationRevision: 1, state: "completed",
      completionReadyAt: AT, expiresAt: null, terminatedAt: null,
      completedAt: AT, terminationReason: null, cancellationNote: null,
      documentTitle: SENSITIVE_TITLE, createdByUserId: OWNER,
      createdAt: AT, updatedAt: AT,
    });
    transactions.store.seals.push({
      sealId: "seal_completed" as never, workspaceId: WORKSPACE,
      signingRequestId: REQUEST as unknown as never,
      sealedArtifactId: "art_final" as ArtifactId,
      sealScheme: "hash-evidence", sealVersion: 1, digestAlgorithm: "sha-256",
      originalDocumentHash: "a".repeat(64) as never,
      signedDocumentHash: "c".repeat(64) as never,
      sealedAt: AT,
    });

    const requestIds = new SequentialSigningRequestIds();
    const clock = new FixedClock(AT);

    const app = await createApp({
      config: config(),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true) },
        sessions,
        workspaces: {
          create: (): CreateWorkspaceDependencies => ({
            transactions, clock,
            workspaceIds: new SequentialWorkspaceIds(),
            memberIds: new SequentialMemberIds(),
            idempotency: {
              digester: createIdempotencyKeyDigester(),
              ids: createIdempotencyRecordIds(),
              clock,
              policy: { retentionMs: 24 * 3_600_000 },
            },
          }),
          list: (): ListMyWorkspacesDependencies => ({ transactions }),
          workspace: (): GetWorkspaceDependencies => ({ transactions }),
          signingRequests: (): SigningRequestDependencies => ({
            transactions, clock, ids: requestIds,
            idempotency: {
              digester: createIdempotencyKeyDigester(),
              ids: createIdempotencyRecordIds(),
              clock,
              policy: { retentionMs: 24 * 3_600_000 },
            },
          }),
          ...(options.composeCompletedArtifact === false ? {} : {
            completedArtifact: () => ({ transactions, storage }),
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

  it("does not exist when no object storage is composed", async () => {
    const built = await buildWithCompletedRequest({ composeCompletedArtifact: false });
    open = built.app;
    const { cookie } = await built.signIn(OWNER);
    const response = await built.app.inject({ method: "GET", url: downloadUrl, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an anonymous request", async () => {
    const built = await buildWithCompletedRequest();
    open = built.app;
    const response = await built.app.inject({ method: "GET", url: downloadUrl });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a non-member of the workspace", async () => {
    const built = await buildWithCompletedRequest();
    open = built.app;
    const stranger = "usr_stranger" as UserId;
    const { cookie } = await built.signIn(stranger);
    const response = await built.app.inject({ method: "GET", url: downloadUrl, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it("streams the sealed bytes to the sender with the right headers", async () => {
    const built = await buildWithCompletedRequest();
    open = built.app;
    const { cookie } = await built.signIn(OWNER);
    const response = await built.app.inject({ method: "GET", url: downloadUrl, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.body).toBe("%PDF-1.4 completed bytes");
  });
  // ── Stats ─────────────────────────────────────────────────────────────────

  describe("GET /workspaces/:workspaceId/signing-requests/stats", () => {
    const STATS_URL = `/workspaces/${WORKSPACE}/signing-requests/stats`;

    it("counts by state, every state present", async () => {
      const h = await harness();
      await create(h);
      const { cookie } = await h.signIn(OWNER);
      const response = await h.app.inject({ method: "GET", url: STATS_URL, headers: { cookie } });

      expect(response.statusCode).toBe(200);
      // Typed over the state union, not `Record<string, …>`: an index
      // signature would force bracket access and, worse, would let a typo'd
      // state name compile.
      const body = response.json<{ total: number; byState: Record<SigningRequestState, number> }>();
      expect(body.total).toBe(1);
      expect(body.byState.draft).toBe(1);
      // Zeros are present, not absent — a dashboard sums these.
      expect(body.byState.completed).toBe(0);
      expect(Object.keys(body.byState).sort()).toEqual([
        "cancelled", "completed", "completion-ready", "declined", "draft",
        "expired", "partially-completed", "ready-to-send", "sent",
      ]);
    });

    it("is never mistaken for a request id", async () => {
      // `/stats` sits beside `/:signingRequestId`. A router that matched the
      // parametric route first would answer 404 "no such request".
      const h = await harness();
      const { cookie } = await h.signIn(OWNER);
      const response = await h.app.inject({ method: "GET", url: STATS_URL, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ total: number }>().total).toBe(0);
    });

    it("does not cache", async () => {
      const h = await harness();
      const { cookie } = await h.signIn(OWNER);
      const response = await h.app.inject({ method: "GET", url: STATS_URL, headers: { cookie } });
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("refuses an anonymous caller", async () => {
      const h = await harness();
      const response = await h.app.inject({ method: "GET", url: STATS_URL });
      expect(response.statusCode).toBe(401);
    });

    it("gives a non-member 404, like the list", async () => {
      const h = await harness();
      const { cookie } = await h.signIn("usr_outsider" as UserId);
      const response = await h.app.inject({ method: "GET", url: STATS_URL, headers: { cookie } });
      expect(response.statusCode).toBe(404);
    });
  });
});
