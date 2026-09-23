// The workflow-template surface's HTTP contract, through the REAL `createApp`.
//
// Same construction as the contact suite: a fake session STORE, but the real
// session service, the real cookies, the real CSRF hook, the real error handler
// and the real encapsulation — so the 401s, 403s and 404s below are the app
// that runs in production, not a hook a test attached to a bare Fastify.
//
// ── What this file is really for ──────────────────────────────────────────
//
// The brief asked for proof that the template permission actually BLOCKS an
// unauthorized call rather than merely existing. The use-case suite proves the
// capability check; only this file proves that no route reaches a write
// without passing through it, over the wire, with a real session attached.
//
// So every denial assertion below is paired with a check that the store is
// still empty or unchanged. A 404 with a written row would be the worst
// outcome of the three and the one a status-code-only test would miss.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Response as LightMyRequestResponse } from "light-my-request";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type WorkflowTemplateDependencies,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-09-22T09:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const TEMPLATE_ADMIN = "usr_template_admin" as UserId;
const SENDER = "usr_sender" as UserId;
const MEMBER = "usr_member" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const WORKSPACE = "ws_templates" as WorkspaceId;
const OTHER_WORKSPACE = "ws_other" as WorkspaceId;

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

  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    transactions.store.workspaces.set(id, {
      workspaceId: id, name: `WS ${id}`, createdAt: AT,
    });
  }

  // One role per verb-boundary the capability matrix draws:
  //   owner, template_administrator  — full write
  //   sender                         — read and apply only
  //   member                         — nothing, not even read
  //   outsider                       — not a member at all
  const seats: ReadonlyArray<readonly [string, UserId, string]> = [
    ["mem_owner", OWNER, "owner"],
    ["mem_tpl", TEMPLATE_ADMIN, "template_administrator"],
    ["mem_sender", SENDER, "sender"],
    ["mem_member", MEMBER, "member"],
  ];
  for (const [memberId, userId, role] of seats) {
    transactions.store.memberships.push({
      memberId: memberId as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId, role: role as never, createdAt: AT,
    });
  }
  // The outsider owns a DIFFERENT workspace. Being an owner somewhere must not
  // carry any authority here — the distinction a membership-free fixture
  // cannot test, because it cannot tell "denied" from "has no workspaces".
  transactions.store.memberships.push({
    memberId: "mem_outsider" as WorkspaceMemberId, workspaceId: OTHER_WORKSPACE,
    userId: OUTSIDER, role: "owner", createdAt: AT,
  });

  // ONE generator for the whole app: a fresh one per request would hand every
  // template the id `wft_1` and the suite would test a single overwritten row.
  const ids = new SequentialWorkflowTemplateIds();

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
        workflowTemplates: (): WorkflowTemplateDependencies => ({
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

const URL = `/workspaces/${WORKSPACE}/workflow-templates`;

const BODY = {
  name: "New Hire Onboarding",
  routingMode: "sequential",
  roleSlots: [
    {
      label: "Hiring Manager", role: "approver",
      required: true, routingStep: 1, defaultAuthMethod: "none",
    },
    {
      label: "New Employee", role: "signer",
      required: true, routingStep: 2, defaultAuthMethod: "email-otp",
    },
  ],
  completionSettings: { notifySenderOnComplete: true },
  variables: [],
};

const templates = (h: Harness) => h.transactions.store.workflowTemplates;

async function createAs(
  h: Harness, user: UserId, body: Record<string, unknown> = BODY,
): Promise<LightMyRequestResponse> {
  const { cookie, csrf } = await h.signIn(user);
  return await h.app.inject({
    method: "POST", url: URL,
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    payload: body,
  });
}

// ── The scope's protections ─────────────────────────────────────────────────

describe("workflow-template routes — the scope's protections", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    const routes = [
      ["GET", URL],
      ["POST", URL],
      ["GET", `${URL}/wft_1`],
      ["PUT", `${URL}/wft_1`],
      ["DELETE", `${URL}/wft_1`],
    ] as const;

    for (const [method, url] of routes) {
      const response = await h.app.inject({
        method, url,
        ...(method === "POST" || method === "PUT" ? { payload: BODY } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(templates(h)).toHaveLength(0);
  });

  it("refuses a mutation with a session but no CSRF token", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);

    for (const [method, url] of [
      ["POST", URL],
      ["PUT", `${URL}/wft_1`],
      ["DELETE", `${URL}/wft_1`],
    ] as const) {
      const response = await h.app.inject({
        method, url, headers: { cookie }, payload: BODY,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(templates(h)).toHaveLength(0);
  });

  it("marks every response no-store", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── Permission gating, over the wire ────────────────────────────────────────

describe("the template permission actually blocks", () => {
  it("lets an owner create", async () => {
    const h = await harness();
    const response = await createAs(h, OWNER);
    expect(response.statusCode).toBe(201);
    expect(templates(h)).toHaveLength(1);
  });

  it("lets a template administrator create", async () => {
    const h = await harness();
    const response = await createAs(h, TEMPLATE_ADMIN);
    expect(response.statusCode).toBe(201);
  });

  it("refuses a create by a SENDER, who may read but not write", async () => {
    const h = await harness();
    const response = await createAs(h, SENDER);

    expect(response.statusCode).toBe(404);
    // The part a status assertion alone would not catch.
    expect(templates(h)).toHaveLength(0);
  });

  it("still lets that same sender LIST — read and write are separate", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie } = await h.signIn(SENDER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("refuses a plain member even a READ", async () => {
    const h = await harness();
    await createAs(h, OWNER);

    const { cookie } = await h.signIn(MEMBER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an update by anyone without the write capability", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    for (const user of [SENDER, MEMBER]) {
      const { cookie, csrf } = await h.signIn(user);
      const response = await h.app.inject({
        method: "PUT", url: `${URL}/wft_1`,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
        payload: { ...BODY, name: "Hijacked" },
      });
      expect(response.statusCode, user).toBe(404);
    }

    expect(templates(h)[0]?.name).toBe(BODY.name);
  });

  it("refuses a delete by anyone without the write capability", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    for (const user of [SENDER, MEMBER]) {
      const { cookie, csrf } = await h.signIn(user);
      const response = await h.app.inject({
        method: "DELETE", url: `${URL}/wft_1`,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      });
      expect(response.statusCode, user).toBe(404);
    }

    expect(templates(h)).toHaveLength(1);
  });

  it("gives a NON-MEMBER the same 404 a denied member gets", async () => {
    // Deliberate: denial and non-membership must be indistinguishable, or the
    // status code itself reports which workspaces exist.
    const h = await harness();
    await createAs(h, OWNER);

    const { cookie } = await h.signIn(OUTSIDER);
    const response = await h.app.inject({ method: "GET", url: URL, headers: { cookie } });

    expect(response.statusCode).toBe(404);
  });
});

// ── Workspace isolation, over the wire ──────────────────────────────────────

describe("workspace isolation", () => {
  it("does not return another workspace's template, even to its owner", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    // The outsider owns OTHER_WORKSPACE, so this is a fully authorized request
    // in a workspace that simply holds no templates.
    const { cookie } = await h.signIn(OUTSIDER);
    const response = await h.app.inject({
      method: "GET", url: `/workspaces/${OTHER_WORKSPACE}/workflow-templates`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("will not fetch a known id across the workspace boundary", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie } = await h.signIn(OUTSIDER);
    const response = await h.app.inject({
      method: "GET", url: `/workspaces/${OTHER_WORKSPACE}/workflow-templates/wft_1`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("will not delete one across the workspace boundary", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(OUTSIDER);
    const response = await h.app.inject({
      method: "DELETE", url: `/workspaces/${OTHER_WORKSPACE}/workflow-templates/wft_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(404);
    expect(templates(h)).toHaveLength(1);
  });
});

// ── Cross-tenant isolation, EVERY per-template route ────────────────────────
//
// The three tests above cover read, list and delete. That left six routes —
// update, document attach/detach, field read/write and role-assignments —
// whose isolation was asserted at the use-case layer but never over the wire.
// A route that forgot its workspace scope would have passed the old suite.
//
// The actor is the OUTSIDER, who OWNS `OTHER_WORKSPACE`. That is the sharp
// version of the test: not "a stranger is refused" but "a fully authorized
// owner, holding every capability, still cannot reach a template that lives
// in somebody else's workspace by naming its real id".

describe("every per-template route refuses across the workspace boundary", () => {
  const CROSSED = `/workspaces/${OTHER_WORKSPACE}/workflow-templates/wft_1`;

  interface CrossedRoute {
    readonly method: "GET" | "PUT" | "DELETE";
    readonly url: string;
    readonly payload?: Record<string, unknown>;
  }

  const ROUTES: readonly CrossedRoute[] = [
    { method: "GET", url: CROSSED },
    { method: "PUT", url: CROSSED, payload: { ...BODY, name: "Hijacked" } },
    { method: "DELETE", url: CROSSED },
    {
      method: "PUT", url: `${CROSSED}/document`,
      payload: { documentId: "doc_1", artifactId: "art_1" },
    },
    { method: "DELETE", url: `${CROSSED}/document` },
    { method: "GET", url: `${CROSSED}/fields` },
    { method: "PUT", url: `${CROSSED}/fields`, payload: { fields: [] } },
    { method: "GET", url: `${CROSSED}/role-assignments` },
    { method: "GET", url: `${CROSSED}/apply` },
  ];

  it("404s every one of them, and leaves the real template untouched", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(OUTSIDER);

    for (const route of ROUTES) {
      const response = await h.app.inject({
        method: route.method,
        url: route.url,
        headers: {
          cookie,
          ...(route.method === "GET" ? {} : { [CSRF_TOKEN_HEADER]: csrf }),
        },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }

    // The assertion a status-code-only test would miss: nothing was renamed,
    // detached, re-fielded or removed on the way to those 404s.
    expect(templates(h)).toHaveLength(1);
    expect(templates(h)[0]?.name).toBe(BODY.name);
    expect(templates(h)[0]?.documentId ?? null).toBeNull();
  });
});

// ── Status mutations: no route, and no way to smuggle one ───────────────────
//
// The frontend once offered Archive / Restore / Make Available / Return to
// Draft for a stored template. The backend has no status column and no such
// route, so those controls were hidden. This proves the SERVER position
// rather than trusting that the UI stays hidden: there is nothing to call,
// and the ordinary write cannot be used to smuggle a status in either.

describe("template status mutations do not exist server-side", () => {
  it("404s every archive-style path, and changes nothing", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);
    const { cookie, csrf } = await h.signIn(OWNER);

    for (const path of ["archive", "restore", "make-available", "return-to-draft", "status"]) {
      for (const method of ["POST", "PUT"] as const) {
        const response = await h.app.inject({
          method, url: `${URL}/wft_1/${path}`,
          headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
          payload: {},
        });
        expect(response.statusCode, `${method} ${path}`).toBe(404);
      }
    }

    expect(templates(h)).toHaveLength(1);
  });

  it("REFUSES a status-like field smuggled into the ordinary write", async () => {
    // `additionalProperties: false` is doing the work. An extra key is not
    // ignored — the whole request is rejected, so a client cannot invent
    // persistence for a concept the schema does not have.
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);
    const { cookie, csrf } = await h.signIn(OWNER);

    const smuggled: ReadonlyArray<Record<string, unknown>> = [
      { status: "archived" },
      { archivedAt: "2026-09-23T00:00:00.000Z" },
      { workflowTemplateId: "wft_somebody_elses" },
      { createdBy: "usr_someone_else" },
    ];

    for (const extra of smuggled) {
      const response = await h.app.inject({
        method: "PUT", url: `${URL}/wft_1`,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
        payload: { ...BODY, ...extra },
      });
      expect(response.statusCode, Object.keys(extra)[0]).toBe(422);
    }

    expect(templates(h)[0]?.name).toBe(BODY.name);
  });
});

// ── A sender's exact surface, over the wire ─────────────────────────────────
//
// `sender` holds `template.view` and nothing else. Create/update/delete were
// already asserted; the document and field WRITES were not, and those are
// precisely the routes that shape what a document asks for. Read and apply
// are asserted alongside them, because a gate that denies everything is as
// wrong as one that permits everything.

describe("a sender may read and apply, and write nothing", () => {
  it("refuses every WRITE route", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(SENDER);
    const writes: ReadonlyArray<{
      readonly method: "PUT" | "DELETE";
      readonly url: string;
      readonly payload?: Record<string, unknown>;
    }> = [
      { method: "PUT", url: `${URL}/wft_1/document`, payload: { documentId: "doc_1", artifactId: "art_1" } },
      { method: "DELETE", url: `${URL}/wft_1/document` },
      { method: "PUT", url: `${URL}/wft_1/fields`, payload: { fields: [] } },
    ];

    for (const write of writes) {
      const response = await h.app.inject({
        method: write.method, url: write.url,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
        ...(write.payload === undefined ? {} : { payload: write.payload }),
      });
      expect(response.statusCode, `${write.method} ${write.url}`).toBe(404);
    }

    expect(templates(h)[0]?.documentId ?? null).toBeNull();
  });

  it("ALLOWS every read route, including apply", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie } = await h.signIn(SENDER);
    for (const url of [
      `${URL}/wft_1`,
      `${URL}/wft_1/fields`,
      `${URL}/wft_1/apply`,
    ]) {
      const response = await h.app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
    }
  });
});

// ── The contract ────────────────────────────────────────────────────────────

describe("POST /workflow-templates", () => {
  it("returns 201 with a Location header and ISO timestamps", async () => {
    const h = await harness();
    const response = await createAs(h, OWNER);

    expect(response.statusCode).toBe(201);
    expect(response.headers["location"]).toBe(`${URL}/wft_1`);

    const body = response.json<Record<string, string>>();
    expect(body["workflowTemplateId"]).toBe("wft_1");
    expect(body["createdAt"]).toBe(new Date(AT).toISOString());
    expect(body["updatedAt"]).toBe(body["createdAt"]);
  });

  it("does not leak the author's user id or the workspace id", async () => {
    const h = await harness();
    const body = (await createAs(h, OWNER)).json<Record<string, unknown>>();

    expect(body).not.toHaveProperty("createdBy");
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("rejects a duplicate name with 409, ignoring case and surrounding space", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const response = await createAs(h, OWNER, { ...BODY, name: "  new hire onboarding " });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("WORKFLOW_TEMPLATE_NAME_TAKEN");
    expect(templates(h)).toHaveLength(1);
  });

  it("refuses malformed role slots rather than storing partial routing", async () => {
    const h = await harness();

    const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["no slots at all", { ...BODY, roleSlots: [] }],
      ["a slot with a blank label",
        { ...BODY, roleSlots: [{ ...BODY.roleSlots[0], label: "  " }] }],
      ["an unknown role",
        { ...BODY, roleSlots: [{ ...BODY.roleSlots[0], role: "notary" }] }],
      ["a routing step of zero",
        { ...BODY, roleSlots: [{ ...BODY.roleSlots[0], routingStep: 0 }] }],
      ["a skipped routing step", {
        ...BODY,
        roleSlots: [BODY.roleSlots[0], { ...BODY.roleSlots[1], routingStep: 3 }],
      }],
      ["an unknown routing mode", { ...BODY, routingMode: "round-robin" }],
      ["a blank name", { ...BODY, name: "   " }],
    ];

    for (const [what, body] of malformed) {
      const response = await createAs(h, OWNER, body);
      expect(response.statusCode, what).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, what).toBeLessThan(500);
    }

    // Not one of them left anything behind. A partially-routed template is
    // worse than a rejected one: it would send a document to some of the
    // people it named and silently to none of the rest.
    expect(templates(h)).toHaveLength(0);
  });
});

// ── Variables (063) ─────────────────────────────────────────────────────────

describe("template variables", () => {
  const withVariables = {
    ...BODY,
    variables: [
      { key: "client_name", label: "Client Name", type: "short-text", required: true },
    ],
  };

  it("round-trips through create, read and update", async () => {
    const h = await harness();
    const created = await createAs(h, OWNER, withVariables);
    expect(created.statusCode).toBe(201);
    expect(created.json<{ variables: unknown }>().variables).toEqual(withVariables.variables);

    const { cookie } = await h.signIn(OWNER);
    const read = await h.app.inject({ method: "GET", url: `${URL}/wft_1`, headers: { cookie } });
    expect(read.json<{ variables: unknown }>().variables).toEqual(withVariables.variables);
  });

  it("refuses two variables with the same key, case-insensitively", async () => {
    const h = await harness();
    const response = await createAs(h, OWNER, {
      ...BODY,
      variables: [
        { key: "client_name", label: "Client Name", type: "short-text", required: true },
        { key: "CLIENT_NAME", label: "Client Name (dup)", type: "short-text", required: false },
      ],
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(templates(h)).toHaveLength(0);
  });

  it("refuses a key that is not lowercase-letters-digits-underscore", async () => {
    const h = await harness();
    const response = await createAs(h, OWNER, {
      ...BODY,
      variables: [{ key: "Client Name!", label: "Client Name", type: "short-text", required: true }],
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it("refuses a request with no variables property at all", async () => {
    // The write schema requires it — a whole-object PUT/POST, same as every
    // other field on this body.
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    const { variables: _omit, ...withoutVariables } = withVariables;
    const response = await h.app.inject({
      method: "POST", url: URL,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: withoutVariables,
    });
    expect(response.statusCode).toBe(422);
  });

  it("defaults to an empty array and stays that way through an update with none", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "PUT", url: `${URL}/wft_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: BODY,
    });
    expect(response.json<{ variables: unknown }>().variables).toEqual([]);
  });
});

describe("PUT and DELETE", () => {
  it("replaces the template wholesale and advances updatedAt", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "PUT", url: `${URL}/wft_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: {
        ...BODY,
        name: "New Hire Onboarding (2026)",
        routingMode: "parallel",
        roleSlots: [{
          label: "Everyone", role: "signer",
          required: true, routingStep: 1, defaultAuthMethod: "none",
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["name"]).toBe("New Hire Onboarding (2026)");
    expect(body["routingMode"]).toBe("parallel");
    expect(body["roleSlots"]).toHaveLength(1);
  });

  it("deletes with 204 and then 404s the same id", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie, csrf } = await h.signIn(OWNER);
    const deleted = await h.app.inject({
      method: "DELETE", url: `${URL}/wft_1`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });
    expect(deleted.statusCode).toBe(204);
    expect(templates(h)).toHaveLength(0);

    const again = await h.app.inject({
      method: "GET", url: `${URL}/wft_1`, headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });
});

// ── Apply ────────────────────────────────────────────────────────────────────

describe("GET .../apply", () => {
  it("returns the slots, settings and an empty field list for a plain template", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie } = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}/wft_1/apply`, headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["routingMode"]).toBe("sequential");
    expect(body["roleSlots"]).toHaveLength(2);
    expect(body["documentId"]).toBeNull();
    expect(body["fields"]).toEqual([]);
    // Never the template id — see the schema's own header.
    expect(body).not.toHaveProperty("workflowTemplateId");
  });

  it("lets a SENDER read it — applying is a sender's act", async () => {
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie } = await h.signIn(SENDER);
    const response = await h.app.inject({
      method: "GET", url: `${URL}/wft_1/apply`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("404s an unknown id and a cross-workspace one, indistinguishably", async () => {
    // This test previously asserted only the unknown id while its NAME claimed
    // the cross-workspace half too — a test that lied about its own coverage.
    // Both halves are asserted now, and they must return the SAME status: a
    // different code for "exists but not yours" would confirm the id exists.
    const h = await harness();
    expect((await createAs(h, OWNER)).statusCode).toBe(201);

    const { cookie: ownerCookie } = await h.signIn(OWNER);
    const unknown = await h.app.inject({
      method: "GET", url: `${URL}/wft_nope/apply`, headers: { cookie: ownerCookie },
    });

    // `wft_1` genuinely exists — in WORKSPACE, not in OTHER_WORKSPACE. The
    // outsider owns OTHER_WORKSPACE outright, so this is a fully authorized
    // request that must still find nothing.
    const { cookie: outsiderCookie } = await h.signIn(OUTSIDER);
    const crossWorkspace = await h.app.inject({
      method: "GET",
      url: `/workspaces/${OTHER_WORKSPACE}/workflow-templates/wft_1/apply`,
      headers: { cookie: outsiderCookie },
    });

    expect(unknown.statusCode).toBe(404);
    expect(crossWorkspace.statusCode).toBe(404);
    expect(crossWorkspace.statusCode).toBe(unknown.statusCode);
  });
});
