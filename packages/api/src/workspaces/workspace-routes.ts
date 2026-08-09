// The workspace tenant surface.
//
//   POST   /workspaces                 create a workspace, become its owner
//   GET    /workspaces                 the caller's own workspaces
//   GET    /workspaces/:workspaceId    one workspace, if the caller belongs
//   PATCH  /workspaces/:workspaceId    rename it, owner only
//
// ── Path-scoped tenancy, not a header ──────────────────────────────────────
//
// The workspace is a PATH SEGMENT. No `X-Workspace-ID` header is invented here,
// because the API conventions never chose one and a header is a tenant boundary
// that does not appear in a log line, a route pattern, a metric label or an
// access log (§40, §110). Every future workspace-owned resource nests under the
// same prefix, so tenant context is visible in the URL of every request that
// has one.
//
// ── A path ID is not authorization ─────────────────────────────────────────
//
// The segment says WHICH tenant is being addressed. Whether the caller may enter
// it is `requireWorkspaceAccess`, which reads the authoritative membership on
// every single request. Knowing an ID grants nothing (§10, §50).
//
// ── No workspaceId in any body ─────────────────────────────────────────────
//
// The update schema has no `workspaceId` field, so a body value cannot disagree
// with the path and there is no reconciliation rule to get wrong (§41, §42).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  CreateWorkspace, listMyWorkspaces, getWorkspace, updateWorkspace,
  assertValidKey,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies,
  type RateLimitCheck, type SessionId,
} from "@lagda/application";
import {
  WorkspaceRoleSchema, WORKSPACE_NAME_MAX_LENGTH,
  IDEMPOTENCY_KEY_HEADER,
  type UserId, type WorkspaceId,
} from "@lagda/contracts";
import { policyById } from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Workspace creation. **ONE property.**
 *
 * `additionalProperties: false` is the control, not a tidiness preference: it is
 * what makes `{"name":"x","ownerUserId":"someone-else"}` a 422 rather than a
 * silently-ignored field. Fastify with `removeAdditional` would strip the
 * property before the handler saw it, so a leak assertion in a handler could not
 * observe the failure (§104, §167).
 *
 * Deliberately absent: `id`, `workspaceId`, `ownerUserId`, `createdBy`, `userId`,
 * `role`, `createdAt`, `archivedAt`, `plan`, `isEnterprise`, `slug`.
 */
export const CreateWorkspaceRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_NAME_MAX_LENGTH }),
}, { additionalProperties: false });

/**
 * The mutable metadata. Also one property, and for the same reason.
 *
 * Deliberately absent: `workspaceId`, `ownerUserId`, `role`, `archivedAt`,
 * `plan`, `billingEmail`, and every RLS or storage field. A lifecycle change is
 * never an ordinary metadata patch (§105).
 */
export const UpdateWorkspaceRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_NAME_MAX_LENGTH }),
}, { additionalProperties: false });

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * One workspace, as its own member sees it.
 *
 * `role` is the CALLER's role — their own authorization state, which is safe
 * (§109, §202). No other member, no member count, no permission matrix: member
 * management is BACKEND-26 and capabilities are BACKEND-27 (§106, §201).
 */
export const WorkspaceResponseSchema = Type.Object({
  workspaceId: Type.String(),
  name: Type.String(),
  role: WorkspaceRoleSchema,
  createdAt: Type.Integer(),
}, { additionalProperties: false });

export const WorkspaceListResponseSchema = Type.Object({
  workspaces: Type.Array(Type.Object({
    workspaceId: Type.String(),
    name: Type.String(),
    role: WorkspaceRoleSchema,
    /** When this user joined. Distinct from when the workspace was created. */
    joinedAt: Type.Integer(),
    createdAt: Type.Integer(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequestSchema>;
export type UpdateWorkspaceRequest = Static<typeof UpdateWorkspaceRequestSchema>;
export type WorkspaceParams = Static<typeof WorkspaceParamsSchema>;

// ── Registration ────────────────────────────────────────────────────────────

export interface WorkspaceRouteOptions {
  /**
   * Resolves a FULL session. Returns null for anonymous callers and for a
   * browser holding only a pre-auth credential.
   *
   * A half-finished MFA ceremony has proved a password and nothing more, and
   * must not be able to create a tenant or read one (§160).
   */
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly createWorkspaceDependencies: () => CreateWorkspaceDependencies;
  readonly listDependencies: () => ListMyWorkspacesDependencies;
  readonly workspaceDependencies: () => GetWorkspaceDependencies;
  /**
   * Optional so a test can exercise routing without a limiter. Absent means the
   * semantic policies are not applied — reported honestly rather than implied.
   */
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

/**
 * Workspace responses are never cacheable.
 *
 * `no-store`, not `no-cache`: the latter lets a shared cache KEEP the response
 * and merely revalidate it. A workspace name can reveal a client, a matter or a
 * counterparty, and a proxy holding one tenant's list is exactly the failure to
 * avoid (§218, §219).
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: WorkspaceRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * Emits a workspace lifecycle event.
   *
   * IDs and outcomes only. **Never the workspace name** — a name can carry the
   * client, the matter or the transaction, and routine operational logs are the
   * one place that data has no business being (§121, §125, §184).
   *
   * Metric labels carry NO workspace ID, user ID or membership ID: those are
   * unbounded, and one series per tenant is how a metrics backend falls over
   * (§126, §185).
   */
  const record = (
    request: FastifyRequest,
    event: "workspace.created" | "workspace.updated",
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): void => {
    request.log.info(
      { event, workspaceId, actorUserId: extra["actorUserId"], result: "success", ...extra },
      event,
    );
    metrics?.increment("workspace_operations_total", {
      operation: event === "workspace.created" ? "create" : "update",
      result: "success",
      processRole: "api",
    });
  };

  const denied = (request: FastifyRequest, workspaceId: string): void => {
    // A cross-tenant attempt. The RESPONSE reveals nothing; the LOG records
    // enough to spot a sustained pattern (§127, §186).
    request.log.warn(
      {
        event: "security.tenant_access_denied",
        securityEvent: "tenant_access_denied",
        requestedWorkspaceId: workspaceId,
        result: "denied",
      },
      "workspace access denied",
    );
    metrics?.increment("security_events_total", {
      securityEvent: "tenant_access_denied", result: "denied", processRole: "api",
    });
  };

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces", {
    schema: {
      body: CreateWorkspaceRequestSchema,
      response: { 201: WorkspaceResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    // Semantic rate limit, AFTER authentication because there is no user to
    // count against before it, and BEFORE the transaction because the point is
    // to stop the expensive part.
    await applyLimits(request, options, [{
      policy: policyById("workspace.create.user"),
      scope: { type: "user", userId: actor.userId },
    }]);

    // ── Idempotency is REQUIRED here ─────────────────────────────────────
    //
    // Not optional, and not "recommended". A browser that loses the response
    // to this request cannot tell success from failure, and the natural retry
    // creates a SECOND PERMANENT TENANT with the same name — which nothing in
    // the system can currently delete (§25, §26).
    //
    // `assertValidKey` throws a validation error for a missing or malformed
    // key, mapped to 422 by the canonical mapper.
    const key = assertValidKey(request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as
      string | undefined);

    const body = request.body as CreateWorkspaceRequest;
    const created = await new CreateWorkspace(options.createWorkspaceDependencies())
      .execute({
        // From the validated session. There is no body field that could
        // nominate anyone else, and no code path that reads one.
        actor: { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
        name: body.name,
        idempotencyKey: key,
      });

    record(request, "workspace.created", created.workspaceId, { actorUserId: actor.userId });

    return reply.status(201).send({
      workspaceId: created.workspaceId,
      name: created.name,
      role: created.role,
      createdAt: created.createdAt,
    });
  });

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces", {
    schema: { response: { 200: WorkspaceListResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    // No workspace context is needed to ask which workspaces you belong to, and
    // no CSRF token either — this is a GET and changes nothing.
    const workspaces = await listMyWorkspaces(actor.userId, options.listDependencies());
    return reply.status(200).send({ workspaces });
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId", {
    schema: {
      params: WorkspaceParamsSchema,
      response: { 200: WorkspaceResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as WorkspaceParams;
    try {
      const detail = await getWorkspace(
        actor.userId, workspaceId as WorkspaceId, options.workspaceDependencies());
      return reply.status(200).send(detail);
    } catch (error) {
      // The error is re-thrown unchanged so the canonical mapper produces the
      // 404. Only the telemetry is added here — a route that built its own
      // error body would be a second envelope.
      denied(request, workspaceId);
      throw error;
    }
  });

  // ── Update ──────────────────────────────────────────────────────────────
  app.patch("/workspaces/:workspaceId", {
    schema: {
      params: WorkspaceParamsSchema,
      body: UpdateWorkspaceRequestSchema,
      response: { 200: WorkspaceResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as WorkspaceParams;

    await applyLimits(request, options, [{
      policy: policyById("workspace.update.user"),
      scope: { type: "user", userId: actor.userId },
    }]);

    // ── No Idempotency-Key here, deliberately ────────────────────────────
    //
    // PATCH with an absolute value is already idempotent: applying `{"name":
    // "Acme"}` twice leaves the same state as applying it once. Requiring a key
    // would be the mechanism applied mechanically rather than where it earns
    // its cost (§56).
    const body = request.body as UpdateWorkspaceRequest;
    let result;
    try {
      result = await updateWorkspace(
        actor.userId, workspaceId as WorkspaceId, { name: body.name },
        options.workspaceDependencies());
    } catch (error) {
      denied(request, workspaceId);
      throw error;
    }

    if (result.outcome === "invalid") {
      return reply.status(422).send({
        error: { code: "INVALID_WORKSPACE_NAME", message: nameMessage(result.reason) },
      });
    }

    // CHANGED FIELDS, never their values. "the name changed" is the operational
    // fact; what it changed to is business data (§122).
    record(request, "workspace.updated", workspaceId, {
      actorUserId: actor.userId, changedFields: ["name"],
    });

    return reply.status(200).send(result.workspace);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function applyLimits(
  request: FastifyRequest,
  options: WorkspaceRouteOptions,
  checks: readonly RateLimitCheck[],
): Promise<void> {
  if (options.rateLimit === undefined) return;
  await checkSemanticLimits(request, checks, options.rateLimit);
}

function nameMessage(reason: "empty" | "too-long" | "control-characters"): string {
  switch (reason) {
    case "empty": return "A workspace name is required.";
    case "too-long": return "That workspace name is too long.";
    case "control-characters":
      return "That workspace name contains unsupported characters.";
  }
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}
