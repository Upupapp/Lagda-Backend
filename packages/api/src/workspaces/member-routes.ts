// The workspace member-administration surface.
//
//   GET     /workspaces/:workspaceId/members
//   PATCH   /workspaces/:workspaceId/members/:membershipId/role
//   DELETE  /workspaces/:workspaceId/members/:membershipId
//   GET     /workspaces/:workspaceId/access      the caller's own capabilities
//
// ── No role appears in this file ───────────────────────────────────────────
//
// Not in a comparison, not in a switch, not in a schema literal outside the
// role-change body — where the role IS the subject being modified rather than
// the authority being checked. Every authorization decision happens inside the
// use case, against a membership row the server read.
//
// That is BACKEND-27's central rule, and it is checkable: a static audit greps
// this directory for `=== "owner"` and finds nothing.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listWorkspaceMembers, changeWorkspaceMemberRole, removeWorkspaceMember,
  resolveWorkspaceAccess, accessCapabilities,
  type MemberAdministrationDependencies, type WorkspaceAccessDependencies,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  WorkspaceRoleSchema, WorkspaceCapabilitySchema,
  type WorkspaceId, type WorkspaceMemberId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const MemberParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  membershipId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * Changing a role. **One property.**
 *
 * The role is here because it is the SUBJECT of the operation — what the target
 * becomes — not because the client is asserting authority. Whether the caller
 * may assign it is the grant matrix's answer, evaluated server-side against the
 * caller's own membership row.
 *
 * `WorkspaceRoleSchema` includes `owner`, and the grant policy refuses it for
 * every actor. That is deliberate: the schema describes the role vocabulary,
 * and the policy decides who may hand out what. Rejecting `owner` at the schema
 * would put half the grant rule in a TypeBox literal where nobody reviews it
 * alongside the rest.
 *
 * Deliberately absent: `permissions`, `capabilities`, `isOwner`, `isAdmin`,
 * `userId`, `workspaceId`, `membershipId`. A client never supplies authority
 * (§133, §215).
 */
export const ChangeMemberRoleRequestSchema = Type.Object({
  role: WorkspaceRoleSchema,
}, { additionalProperties: false });

/**
 * A member, as an authorized administrator sees them.
 *
 * The email IS present, gated behind `membership.view`. Never present:
 * authentication state, session identifiers, MFA status, token digests, or
 * anything about another workspace (§246).
 */
export const WorkspaceMemberSchema = Type.Object({
  membershipId: Type.String(),
  userId: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  role: WorkspaceRoleSchema,
  joinedAt: Type.Integer(),
  isCurrentUser: Type.Boolean(),
}, { additionalProperties: false });

export const MemberListResponseSchema = Type.Object({
  members: Type.Array(WorkspaceMemberSchema),
}, { additionalProperties: false });

/**
 * The caller's own access, for a client to hide controls with.
 *
 * ── This is informational, and the word matters ────────────────────────────
 *
 * A client uses it to grey out an Invite button. It is NOT how the backend
 * decides anything: every mutation re-evaluates the policy against a membership
 * row read at the time of the write. A client that fabricated this response, or
 * cached a stale one, changes nothing about what it is permitted to do (§17,
 * §18, §80, §128).
 */
export const WorkspaceAccessResponseSchema = Type.Object({
  workspaceId: Type.String(),
  membershipId: Type.String(),
  role: WorkspaceRoleSchema,
  capabilities: Type.Array(WorkspaceCapabilitySchema),
}, { additionalProperties: false });

export type ChangeMemberRoleRequest = Static<typeof ChangeMemberRoleRequestSchema>;

// ── Options ─────────────────────────────────────────────────────────────────

export interface MemberRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly memberDependencies: () => MemberAdministrationDependencies;
  readonly accessDependencies: () => WorkspaceAccessDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A member directory is every colleague's email address; an access response is
 * the caller's current authority. Neither belongs in a shared cache.
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

export function registerMemberRoutes(
  app: FastifyInstance,
  options: MemberRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * An administrative change to who may do what.
   *
   * IDs and ROLE VALUES. Roles are a seven-value closed set, so they are safe
   * as a log field and as a metric label — unlike the ids, which are unbounded.
   * The member's email is never here: the directory returns it to an authorized
   * administrator, and that entitlement does not extend to logs (§178, §184).
   */
  const record = (
    request: FastifyRequest,
    event: "workspace.member.role_changed" | "workspace.member.removed",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("workspace_member_operations_total", {
      operation: event === "workspace.member.role_changed" ? "role_changed" : "removed",
      result: "success",
      processRole: "api",
    });
  };

  // ── The caller's own access ─────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/access", {
    schema: {
      params: WorkspaceParamsSchema,
      response: { 200: WorkspaceAccessResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    // Any member may ask what THEY can do. That needs no capability — a member
    // who could not discover their own authority could not render a usable
    // interface, and the answer discloses nothing about anyone else (§124).
    const access = await resolveWorkspaceAccess(
      actor.userId, workspaceId as WorkspaceId, options.accessDependencies());

    if (access === null) {
      // The same hidden 404 as every other workspace read.
      return reply.status(404).send({
        error: { code: "resource_not_found", message: "Workspace was not found." },
      });
    }

    return reply.status(200).send({
      workspaceId: access.workspaceId,
      membershipId: access.membershipId,
      role: access.role,
      capabilities: accessCapabilities(access),
    });
  });

  // ── List members ────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/members", {
    schema: {
      params: WorkspaceParamsSchema,
      response: { 200: MemberListResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const members = await listWorkspaceMembers(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId,
      options.memberDependencies(),
    );

    // No pagination. A workspace member list is bounded by how many people work
    // at one organization, and API_CONVENTIONS §5 already reasoned that
    // paginating a small list solves a volume problem nobody has measured.
    return reply.status(200).send({ members });
  });

  // ── Change a member's role ──────────────────────────────────────────────
  app.patch("/workspaces/:workspaceId/members/:membershipId/role", {
    schema: {
      params: MemberParamsSchema,
      body: ChangeMemberRoleRequestSchema,
      response: { 200: WorkspaceMemberSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, membershipId } =
      request.params as Static<typeof MemberParamsSchema>;
    const body = request.body as ChangeMemberRoleRequest;

    const result = await changeWorkspaceMemberRole(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId,
      membershipId as WorkspaceMemberId,
      body.role,
      options.memberDependencies(),
    );

    if (result.outcome === "changed") {
      record(request, "workspace.member.role_changed", {
        workspaceId,
        membershipId,
        actorUserId: actor.userId,
        targetUserId: result.member.userId,
        toRole: result.member.role,
      });
    }

    // 200 for both outcomes. A role that was already what the caller asked for
    // is the desired end state, and reporting a conflict would make an
    // idempotent retry look like a failure (§118).
    return reply.status(200).send(result.member);
  });

  // ── Remove a member ─────────────────────────────────────────────────────
  app.delete("/workspaces/:workspaceId/members/:membershipId", {
    schema: {
      params: MemberParamsSchema,
      response: {
        200: Type.Object({
          membershipId: Type.String(),
          removed: Type.Literal(true),
        }, { additionalProperties: false }),
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, membershipId } =
      request.params as Static<typeof MemberParamsSchema>;

    // No body. There is nothing a client could usefully say about a removal,
    // and a `reason` field would be free text in a security event (§135, §170).
    const result = await removeWorkspaceMember(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId,
      membershipId as WorkspaceMemberId,
      options.memberDependencies(),
    );

    record(request, "workspace.member.removed", {
      workspaceId, membershipId,
      actorUserId: actor.userId, targetUserId: result.userId,
    });

    return reply.status(200).send({ membershipId, removed: true as const });
  });
}
