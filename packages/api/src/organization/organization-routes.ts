// The org chart over HTTP (TENANT_CORE).
//
//   GET    /workspaces/:workspaceId/units
//   POST   /workspaces/:workspaceId/units
//   PATCH  /workspaces/:workspaceId/units/:unitId
//   POST   /workspaces/:workspaceId/units/:unitId/archive
//   POST   /workspaces/:workspaceId/units/:unitId/members
//   DELETE /workspaces/:workspaceId/units/:unitId/members/:userId
//
// Registered INSIDE the authenticated scope, so session validation and CSRF
// come from where these live rather than from anything this file does.
//
// ── The response is a flat list, not a tree ────────────────────────────────
//
// Every unit carries its `parentUnitId`, and the client assembles the shape it
// wants. A nested response would fix one traversal order in the contract, make
// the payload's depth unbounded, and force a second endpoint the moment
// somebody needs a flat picker — which every "choose a department" control is.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  createOrganizationUnit, updateOrganizationUnit, archiveOrganizationUnit,
  addUnitMember, removeUnitMember, listOrganizationUnits,
  type OrganizationDependencies,
} from "@lagda/application";
import { ORGANIZATION_UNIT_KINDS, UNIT_NAME_MAX_LENGTH } from "@lagda/core";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

const WorkspaceParams = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const UnitParams = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  unitId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const MemberParams = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  unitId: Type.String({ minLength: 1, maxLength: 64 }),
  userId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

/** Closed, so a client cannot introduce a hierarchy vocabulary. */
const UnitKind = Type.Union(
  ORGANIZATION_UNIT_KINDS.map(kind => Type.Literal(kind)),
  { title: "OrganizationUnitKind" },
);

const CreateUnitBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: UNIT_NAME_MAX_LENGTH }),
  kind: UnitKind,
  parentUnitId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

/**
 * `parentUnitId` is nullable AND optional, and the two mean different things.
 *
 * Absent leaves the unit where it is. Explicit null promotes it to a root. A
 * schema that collapsed them would relocate a whole subtree because a form
 * omitted a field.
 */
const UpdateUnitBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: UNIT_NAME_MAX_LENGTH }),
  parentUnitId: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  ),
}, { additionalProperties: false });

const AddMemberBody = Type.Object({
  userId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const UnitSchema = Type.Object({
  unitId: Type.String(),
  parentUnitId: Type.Union([Type.String(), Type.Null()]),
  kind: UnitKind,
  name: Type.String(),
  createdAt: Type.Number(),
  archivedAt: Type.Union([Type.Number(), Type.Null()]),
}, { additionalProperties: false });

const UnitListSchema = Type.Object({
  units: Type.Array(UnitSchema),
}, { additionalProperties: false });

export interface OrganizationRouteOptions {
  readonly authenticatedUser: (
    request: FastifyRequest,
  ) => Promise<{ readonly userId: UserId } | null>;
  readonly organizationDependencies: OrganizationDependencies;
  readonly metrics: MetricsRecorder;
}

/**
 * The projection.
 *
 * `workspaceId` is deliberately absent from the response: it is already in the
 * path the caller used, and echoing a tenant identifier into every element of
 * every list is how one leaks into a log or a client cache key.
 */
const project = (unit: {
  unitId: string; parentUnitId: string | null; kind: string; name: string;
  createdAt: number; archivedAt: number | null;
}) => ({
  unitId: unit.unitId,
  parentUnitId: unit.parentUnitId,
  kind: unit.kind,
  name: unit.name,
  createdAt: unit.createdAt,
  archivedAt: unit.archivedAt,
});

export function registerOrganizationRoutes(
  app: FastifyInstance,
  options: OrganizationRouteOptions,
): void {
  const requireActor = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    // Unreachable behind the scope's `requireSession`, and checked anyway: a
    // route whose correctness depends on a hook breaks silently the day
    // somebody moves it.
    if (actor === null) throw new Error("No authenticated actor.");
    return actor;
  };

  app.get("/workspaces/:workspaceId/units", {
    schema: {
      params: WorkspaceParams,
      response: { 200: UnitListSchema },
    },
  }, async request => {
    const { workspaceId } = request.params as { workspaceId: string };
    const actor = await requireActor(request);

    const units = await listOrganizationUnits({
      actor, workspaceId: workspaceId as WorkspaceId,
    }, options.organizationDependencies);

    return { units: units.map(project) };
  });

  app.post("/workspaces/:workspaceId/units", {
    schema: {
      params: WorkspaceParams,
      body: CreateUnitBody,
      response: { 201: UnitSchema },
    },
  }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as {
      name: string; kind: string; parentUnitId?: string;
    };
    const actor = await requireActor(request);

    const unit = await createOrganizationUnit({
      actor,
      workspaceId: workspaceId as WorkspaceId,
      name: body.name,
      kind: body.kind,
      ...(body.parentUnitId === undefined
        ? {} : { parentUnitId: body.parentUnitId }),
    }, options.organizationDependencies);

    return reply.code(201).send(project(unit));
  });

  app.patch("/workspaces/:workspaceId/units/:unitId", {
    schema: {
      params: UnitParams,
      body: UpdateUnitBody,
      response: { 200: UnitSchema },
    },
  }, async request => {
    const { workspaceId, unitId } = request.params as {
      workspaceId: string; unitId: string;
    };
    const body = request.body as {
      name: string; parentUnitId?: string | null;
    };
    const actor = await requireActor(request);

    const unit = await updateOrganizationUnit({
      actor,
      workspaceId: workspaceId as WorkspaceId,
      unitId,
      name: body.name,
      // Spread, so ABSENT stays absent under `exactOptionalPropertyTypes` and
      // the use case can tell "leave it" from "make it a root".
      ...("parentUnitId" in body ? { parentUnitId: body.parentUnitId } : {}),
    }, options.organizationDependencies);

    return project(unit);
  });

  // POST rather than DELETE: archiving is not deletion, and the row survives.
  // A DELETE verb here would tell every client the opposite of what happens.
  app.post("/workspaces/:workspaceId/units/:unitId/archive", {
    schema: { params: UnitParams, response: { 204: Type.Null() } },
  }, async (request, reply) => {
    const { workspaceId, unitId } = request.params as {
      workspaceId: string; unitId: string;
    };
    const actor = await requireActor(request);

    await archiveOrganizationUnit({
      actor, workspaceId: workspaceId as WorkspaceId, unitId,
    }, options.organizationDependencies);

    return reply.code(204).send();
  });

  app.post("/workspaces/:workspaceId/units/:unitId/members", {
    schema: {
      params: UnitParams, body: AddMemberBody,
      response: { 204: Type.Null() },
    },
  }, async (request, reply) => {
    const { workspaceId, unitId } = request.params as {
      workspaceId: string; unitId: string;
    };
    const { userId } = request.body as { userId: string };
    const actor = await requireActor(request);

    await addUnitMember({
      actor, workspaceId: workspaceId as WorkspaceId, unitId, userId,
    }, options.organizationDependencies);

    return reply.code(204).send();
  });

  app.delete("/workspaces/:workspaceId/units/:unitId/members/:userId", {
    schema: { params: MemberParams, response: { 204: Type.Null() } },
  }, async (request, reply) => {
    const { workspaceId, unitId, userId } = request.params as {
      workspaceId: string; unitId: string; userId: string;
    };
    const actor = await requireActor(request);

    // 204 whether or not they were in it. Removing somebody already out is the
    // state the caller asked for, and a 404 would make a retry look like a bug.
    await removeUnitMember({
      actor, workspaceId: workspaceId as WorkspaceId, unitId, userId,
    }, options.organizationDependencies);

    return reply.code(204).send();
  });
}
