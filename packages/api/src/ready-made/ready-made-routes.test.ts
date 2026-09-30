// The ready-made library: the catalogue carries no document text at all; the
// full library reaches only a member of a workspace whose owner is on
// Personal or higher, and a stranger learns nothing.

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { PlanReadDependencies, SessionId, UserPlanRecord } from "@lagda/application";
import { registerReadyMadeRoutes, catalogOf } from "./ready-made-routes.js";
import { READY_MADE_LIBRARY } from "./library.js";
import { mapError } from "../errors/index.js";

const OWNER = "usr_owner" as UserId;
const MEMBER = "usr_member" as UserId;
const STRANGER = "usr_stranger" as UserId;
const WS = "ws_1" as WorkspaceId;

function app(caller: UserId | null, ownerPlan: UserPlanRecord["plan"]) {
  const members = [
    { userId: OWNER, role: "owner" }, { userId: MEMBER, role: "member" },
  ];
  const deps = {
    transactions: {
      runForWorkspace: (_ws: WorkspaceId, op: (uow: unknown) => Promise<unknown>) => op({
        memberships: {
          findByUser: (u: UserId) => Promise.resolve(members.find(m => m.userId === u) ?? null),
          list: () => Promise.resolve(members),
        },
      }),
    },
    plans: {
      find: () => Promise.resolve({ userId: OWNER, plan: ownerPlan, paidUntil: Date.now() + 86_400_000, autoRenew: false, freeDocumentsUsed: 0, updatedAt: 0 }),
    },
    clock: { now: () => Date.now() },
  } as unknown as PlanReadDependencies;
  const server = Fastify();
  server.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id as never);
    void reply.status(mapped.status).send(mapped.body);
  });
  registerReadyMadeRoutes(server, {
    authenticatedUser: () => Promise.resolve(caller === null ? null : { userId: caller, sessionId: "ses_1" as SessionId }),
    dependencies: () => deps,
  });
  return server;
}

const bodies = READY_MADE_LIBRARY.categories.flatMap(c => c.documents.map(d => d.body_content));

describe("ready-made templates", () => {
  it("strips every document's text from the catalogue", async () => {
    const res = await app(MEMBER, "free").inject({ method: "GET", url: "/ready-made-templates/catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("body_content");
    for (const body of bodies) expect(res.body.includes(body.slice(0, 60))).toBe(false);
    const parsed = res.json<ReturnType<typeof catalogOf>>();
    expect(parsed.categories.flatMap(c => c.documents)).toHaveLength(58);
  });

  it("gives the full library to a member of a Personal workspace", async () => {
    const res = await app(MEMBER, "personal").inject({ method: "GET", url: `/workspaces/${WS}/ready-made-templates` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain(bodies[0]!.slice(0, 60));
  });

  it("refuses a Free workspace with plan_required and no text", async () => {
    const res = await app(OWNER, "free").inject({ method: "GET", url: `/workspaces/${WS}/ready-made-templates` });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("plan_required");
    expect(res.body.includes(bodies[0]!.slice(0, 60))).toBe(false);
  });

  it("tells a stranger nothing, even of a paid workspace", async () => {
    const res = await app(STRANGER, "business").inject({ method: "GET", url: `/workspaces/${WS}/ready-made-templates` });
    expect(res.statusCode).toBe(404);
    expect(res.body.includes(bodies[0]!.slice(0, 60))).toBe(false);
  });

  it("needs a session for both", async () => {
    const server = app(null, "business");
    expect((await server.inject({ method: "GET", url: "/ready-made-templates/catalog" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: `/workspaces/${WS}/ready-made-templates` })).statusCode).toBe(401);
  });
});
