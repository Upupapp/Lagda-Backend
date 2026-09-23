// The workflow-template surface (migration 058, extended by 059).
//
//   GET    /workspaces/:id/workflow-templates
//   POST   /workspaces/:id/workflow-templates
//   GET    /workspaces/:id/workflow-templates/:templateId
//   PUT    /workspaces/:id/workflow-templates/:templateId
//   DELETE /workspaces/:id/workflow-templates/:templateId
//   PUT    /workspaces/:id/workflow-templates/:templateId/document
//   DELETE /workspaces/:id/workflow-templates/:templateId/document
//   GET    /workspaces/:id/workflow-templates/:templateId/fields
//   PUT    /workspaces/:id/workflow-templates/:templateId/fields
//   GET    /workspaces/:id/workflow-templates/:templateId/role-assignments
//   GET    /workspaces/:id/workflow-templates/:templateId/apply
//
// Registered inside the authenticated workspace scope, so `requireSession`
// has already run its CSRF hook — the same position the contact routes take,
// and the reason neither file validates CSRF itself.
//
// ── Authorization is the use case's, not this file's ──────────────────────
//
// No route here compares a role or reads a membership. Each use case resolves
// the actor's current authority inside its own transaction and asserts a
// capability; an architecture test forbids role comparisons in route files.
//
// ── The document routes upload nothing ──────────────────────────────────
//
// `PUT .../document` takes a documentId + artifactId already produced by the
// ordinary POST /documents + POST /documents/:id/upload path. It attaches a
// reference; the use case verifies the pair rather than trusting it (see
// `attachWorkflowTemplateDocument`). No multipart parsing, no storage write
// and no virus scan happen here — all of that already happened to produce the
// artifact being named.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createWorkflowTemplate, listWorkflowTemplates, getWorkflowTemplate,
  updateWorkflowTemplate, deleteWorkflowTemplate,
  attachWorkflowTemplateDocument, detachWorkflowTemplateDocument,
  listWorkflowTemplateFields, saveWorkflowTemplateFields,
  resolveWorkflowRoleAssignments, resolveTemplateForApply,
  WorkflowTemplateNameTakenError,
  type WorkflowTemplateDependencies, type WorkflowTemplateRecord,
  type WorkflowTemplateFieldRecord, type WorkflowRoleAssignment,
  type WorkflowTemplateApplication,
  type SessionId, type UserId, type ArtifactId,
} from "@lagda/application";
import {
  WorkflowTemplateSchema, WorkflowTemplateWriteSchema, WorkflowTemplateListSchema,
  WorkflowTemplateDocumentInputSchema,
  WorkflowTemplateFieldListSchema, WorkflowTemplateFieldsWriteSchema,
  WorkflowRoleAssignmentListSchema, WorkflowTemplateApplicationSchema,
  type WorkflowTemplateWrite, type WorkflowTemplateDocumentInput,
  type WorkflowTemplateFieldsWrite,
  type WorkspaceId, type DocumentId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const TemplateParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  workflowTemplateId: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── Options ─────────────────────────────────────────────────────────────────

export interface WorkflowTemplateRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly workflowTemplateDependencies: () => WorkflowTemplateDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A template names the roles a workspace routes its documents through. It is
 * workspace configuration, and belongs in no shared cache.
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

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * What leaves the backend.
 *
 * `createdBy` and `workspaceId` are deliberately absent. The workspace is in
 * the path the caller already used, and the author's user id is an internal
 * identifier a template UI has no use for — a display name would be a
 * different feature with its own lookup.
 */
const present = (template: WorkflowTemplateRecord) => ({
  workflowTemplateId: template.workflowTemplateId,
  name: template.name,
  routingMode: template.routingMode,
  roleSlots: template.roleSlots.map(slot => ({
    slotId: slot.slotId,
    label: slot.label,
    role: slot.role,
    required: slot.required,
    routingStep: slot.routingStep,
    defaultAuthMethod: slot.defaultAuthMethod,
    // 061. Spread, not a `resolution: slot.resolution ?? undefined` — the
    // latter would send an explicit `null` the write-back schema (Optional,
    // not nullable) does not accept, breaking a plain read-then-PUT.
    ...(slot.resolution === undefined ? {} : { resolution: slot.resolution }),
  })),
  completionSettings: {
    notifySenderOnComplete: template.completionSettings.notifySenderOnComplete,
  },
  documentId: template.documentId,
  sourceArtifactId: template.sourceArtifactId,
  createdAt: iso(template.createdAt),
  updatedAt: iso(template.updatedAt),
});

/** What a field placement looks like on the wire. No `workspaceId`, no
 *  `workflowTemplateId` — both are already in the URL the caller used. */
const presentField = (field: WorkflowTemplateFieldRecord) => ({
  fieldId: field.fieldId,
  slotId: field.slotId,
  type: field.type,
  pageNumber: field.pageNumber,
  rect: { x: field.x, y: field.y, width: field.width, height: field.height },
  required: field.required,
  label: field.label,
  layer: field.layer,
});

/** What a slot's resolved assignment looks like on the wire — the
 *  `userId`/`displayName`/`email` triple is present only when `status` is
 *  `"resolved"`, matching `WorkflowRoleAssignmentSchema`'s own shape. */
const presentAssignment = (assignment: WorkflowRoleAssignment) =>
  assignment.status === "resolved"
    ? {
        slotId: assignment.slotId, status: assignment.status,
        userId: assignment.userId, displayName: assignment.displayName,
        email: assignment.email,
      }
    : { slotId: assignment.slotId, status: assignment.status };

/** The apply-time snapshot on the wire. No `workflowTemplateId` — see
 *  `WorkflowTemplateApplicationSchema`'s own header. */
const presentApplication = (application: WorkflowTemplateApplication) => ({
  routingMode: application.routingMode,
  roleSlots: application.roleSlots.map(slot => ({
    slotId: slot.slotId,
    label: slot.label,
    role: slot.role,
    required: slot.required,
    routingStep: slot.routingStep,
    defaultAuthMethod: slot.defaultAuthMethod,
    ...(slot.resolution === undefined ? {} : { resolution: slot.resolution }),
  })),
  completionSettings: {
    notifySenderOnComplete: application.completionSettings.notifySenderOnComplete,
  },
  documentId: application.documentId,
  sourceArtifactId: application.sourceArtifactId,
  fields: application.fields.map(presentField),
});

export function registerWorkflowTemplateRoutes(
  app: FastifyInstance,
  options: WorkflowTemplateRouteOptions,
): void {
  const metrics = options.metrics;
  // The same adapter the contact routes use: the application's actor carries
  // an `actorType`, and a route must not invent one per call site.
  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  const record = (request: FastifyRequest, event: string, fields: Record<string, unknown>) => {
    // Ids and counts only. A template's NAME is business data and its slot
    // labels can name a counterparty's role — neither belongs in a log line.
    request.log.info({ event, ...fields }, event);
    metrics?.increment("workflow_template_operations_total", {
      operation: event.slice("workflow_template.".length),
      result: "success",
      processRole: "api",
    });
  };

  /**
   * A name already in use is a 409, not a 422.
   *
   * The body was well-formed and the caller may retry with a different name —
   * which is exactly what `conflict` means in the API conventions. Everything
   * else (a malformed slot, an unknown routing mode) is the application's
   * `validation` category and reaches the shared error mapper as a 422.
   */
  const withNameConflict = async (
    reply: FastifyReply, run: () => Promise<FastifyReply>,
  ): Promise<FastifyReply> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof WorkflowTemplateNameTakenError) {
        return reply.status(409).send({
          error: { code: "WORKFLOW_TEMPLATE_NAME_TAKEN", message: error.message },
        });
      }
      throw error;
    }
  };

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/workflow-templates", {
    schema: {
      params: WorkspaceParamsSchema,
      response: { 200: WorkflowTemplateListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const templates = await listWorkflowTemplates(
      actor, workspaceId as WorkspaceId, options.workflowTemplateDependencies());

    return reply.status(200).send({ items: templates.map(present) });
  });

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/workflow-templates", {
    schema: {
      params: WorkspaceParamsSchema,
      body: WorkflowTemplateWriteSchema,
      response: { 201: WorkflowTemplateSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const body = request.body as WorkflowTemplateWrite;

    return withNameConflict(reply, async () => {
      const template = await createWorkflowTemplate(
        actor, workspaceId as WorkspaceId, body,
        options.workflowTemplateDependencies());

      record(request, "workflow_template.created", {
        workspaceId,
        workflowTemplateId: template.workflowTemplateId,
        actorUserId: actor.userId,
        slotCount: template.roleSlots.length,
      });

      void reply.header("Location",
        `/workspaces/${workspaceId}/workflow-templates/${template.workflowTemplateId}`);
      return reply.status(201).send(present(template));
    });
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId", {
    schema: {
      params: TemplateParamsSchema,
      response: { 200: WorkflowTemplateSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    const template = await getWorkflowTemplate(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    return reply.status(200).send(present(template));
  });

  // ── Update ──────────────────────────────────────────────────────────────
  //
  // PUT, not PATCH: a template is replaced wholesale. A partial update of an
  // ordered slot list has no obvious meaning — "change slot 2" and "insert a
  // slot before 2" are the same request shape — and the editor holds the whole
  // template anyway.
  app.put("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId", {
    schema: {
      params: TemplateParamsSchema,
      body: WorkflowTemplateWriteSchema,
      response: { 200: WorkflowTemplateSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;
    const body = request.body as WorkflowTemplateWrite;

    return withNameConflict(reply, async () => {
      const template = await updateWorkflowTemplate(
        actor, workspaceId as WorkspaceId, workflowTemplateId, body,
        options.workflowTemplateDependencies());

      record(request, "workflow_template.updated", {
        workspaceId,
        workflowTemplateId,
        actorUserId: actor.userId,
        slotCount: template.roleSlots.length,
      });

      return reply.status(200).send(present(template));
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  //
  // A real delete, unlike a contact's archive. Nothing references a template
  // (migration 058 keeps it that way), so removing one orphans no record of
  // anything that happened — and a draft already built from it holds its own
  // copy of the slots, so nothing it produced changes either.
  app.delete("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId", {
    schema: { params: TemplateParamsSchema, response: { 204: Type.Null() } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    await deleteWorkflowTemplate(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    record(request, "workflow_template.deleted", {
      workspaceId, workflowTemplateId, actorUserId: actor.userId,
    });

    return reply.status(204).send();
  });

  // ── Attach document (059) ──────────────────────────────────────────────
  app.put("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/document", {
    schema: {
      params: TemplateParamsSchema,
      body: WorkflowTemplateDocumentInputSchema,
      response: { 200: WorkflowTemplateSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;
    const body = request.body as WorkflowTemplateDocumentInput;

    const template = await attachWorkflowTemplateDocument(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      { documentId: body.documentId as DocumentId, artifactId: body.artifactId as ArtifactId },
      options.workflowTemplateDependencies());

    record(request, "workflow_template.document_attached", {
      workspaceId, workflowTemplateId, actorUserId: actor.userId,
    });

    return reply.status(200).send(present(template));
  });

  // ── Detach document (059) ──────────────────────────────────────────────
  //
  // Removes the reference only. The document and its artifact are untouched
  // and outlive it — exactly as they outlive a deleted signing request.
  app.delete("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/document", {
    schema: {
      params: TemplateParamsSchema,
      response: { 200: WorkflowTemplateSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    const template = await detachWorkflowTemplateDocument(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    record(request, "workflow_template.document_detached", {
      workspaceId, workflowTemplateId, actorUserId: actor.userId,
    });

    return reply.status(200).send(present(template));
  });

  // ── Field placements (060) ─────────────────────────────────────────────
  //
  // Their OWN resource, not embedded in `WorkflowTemplateSchema` — the same
  // choice `document_preparations`/`preparation_fields` already made for a
  // real document: most callers that want a template have no use for its
  // geometry, and embedding it would make every template read pay for a
  // field fetch it does not need.
  app.get("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/fields", {
    schema: {
      params: TemplateParamsSchema,
      response: { 200: WorkflowTemplateFieldListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    const fields = await listWorkflowTemplateFields(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    return reply.status(200).send({ items: fields.map(presentField) });
  });

  // Whole-layout replace, the same PUT-not-PATCH reasoning the template's
  // own update route states: a partial update of geometry keyed by id has
  // no obvious meaning when the editor already holds the whole layout.
  app.put("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/fields", {
    schema: {
      params: TemplateParamsSchema,
      body: WorkflowTemplateFieldsWriteSchema,
      response: { 200: WorkflowTemplateFieldListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;
    const body = request.body as WorkflowTemplateFieldsWrite;

    const fields = await saveWorkflowTemplateFields(
      actor, workspaceId as WorkspaceId, workflowTemplateId, body.fields,
      options.workflowTemplateDependencies());

    record(request, "workflow_template.fields_saved", {
      workspaceId, workflowTemplateId, actorUserId: actor.userId,
      fieldCount: fields.length,
    });

    return reply.status(200).send({ items: fields.map(presentField) });
  });

  // ── Role assignments (061) ─────────────────────────────────────────────
  //
  // Read-only, and its own route rather than folded into GET .../:id: this
  // one pays for a directory join (`memberships.listWithAccounts()`) that a
  // plain template read has no reason to make, and it answers a different
  // question — not "what does this template say" but "who does that mean
  // right now."
  app.get("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/role-assignments", {
    schema: {
      params: TemplateParamsSchema,
      response: { 200: WorkflowRoleAssignmentListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    const assignments = await resolveWorkflowRoleAssignments(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    return reply.status(200).send({ items: assignments.map(presentAssignment) });
  });

  // ── Apply ───────────────────────────────────────────────────────────────
  //
  // The one read a sender needs to start from a template: slots, settings,
  // document pair and field geometry, in one transaction. See
  // `resolveTemplateForApply`'s own header for why it needs `template.view`
  // rather than a write capability, and why it never returns the template id.
  app.get("/workspaces/:workspaceId/workflow-templates/:workflowTemplateId/apply", {
    schema: {
      params: TemplateParamsSchema,
      response: { 200: WorkflowTemplateApplicationSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, workflowTemplateId } =
      request.params as Static<typeof TemplateParamsSchema>;

    const application = await resolveTemplateForApply(
      actor, workspaceId as WorkspaceId, workflowTemplateId,
      options.workflowTemplateDependencies());

    return reply.status(200).send(presentApplication(application));
  });
}
