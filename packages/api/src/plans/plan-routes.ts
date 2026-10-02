// Plans (093): the account's own plan, a workspace's plan, test-mode upgrade
// requests, and the approver's decisions.
//
//   GET  /me/plan                                   plan, Free allowance, pending request
//   POST /me/plan/upgrade-requests                  { plan, bank } — sample account only
//   POST /me/plan/upgrade-requests/cancel           withdraw the pending request
//   GET  /workspaces/:workspaceId/plan              the owner's plan, for a member
//   GET  /plan-requests                             pending requests (approver only)
//   GET  /plan-requests/:requestId                  one request (approver only)
//   POST /plan-requests/:requestId/approve | decline
//
// And the plan GATES: one preHandler on the authenticated scope that refuses
// a paid feature when the workspace owner's plan does not include it. A table
// of route patterns rather than a line in every route module, so the whole
// Free/paid boundary on the server can be read in one place.
//
// Registered inside the authenticated scope: every route needs the session,
// and every mutation its CSRF check.

import { renderPlanInvoice } from "@lagda/sealing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getMyPlan, getWorkspacePlan, requestPlanUpgrade, cancelMyPlanUpgradeRequest, listMyPlanInvoices, getMyPlanInvoice,
  SAMPLE_BANK_ACCOUNT,
  listPendingPlanUpgradeRequests, getPlanUpgradeRequest, decidePlanUpgradeRequest,
  requireWorkspacePlan, requireOwnPlan, policyById,
  type PlanDependencies, type PlanUpgradeRequestView, type PlanUpgradeReviewView,
  type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

export interface PlanRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => PlanDependencies;
  readonly metrics?: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
}

// ── Schemas ───────────────────────────────────────────────────────────────

const PlanLiteral = Type.Union([
  Type.Literal("free"), Type.Literal("personal"), Type.Literal("business"), Type.Literal("enterprise"),
]);
const RequestableLiteral = Type.Union([Type.Literal("personal"), Type.Literal("business")]);
const StatusLiteral = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("declined"),
  Type.Literal("expired"), Type.Literal("cancelled"),
]);
const NullableString = Type.Union([Type.String(), Type.Null()]);

const RequestSchema = Type.Object({
  requestId: Type.String(),
  plan: RequestableLiteral,
  amountPesos: Type.Integer(),
  status: StatusLiteral,
  createdAt: Type.String(),
  expiresAt: Type.String(),
  decidedAt: NullableString,
}, { additionalProperties: false });

const InvoiceListSchema = Type.Object({
  invoices: Type.Array(Type.Object({
    number: Type.String(),
    requestId: Type.String(),
    plan: RequestableLiteral,
    planName: Type.String(),
    amountPesos: Type.Integer(),
    issuedAt: Type.String(),
    periodEnd: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const ReviewSchema = Type.Object({
  requestId: Type.String(),
  plan: RequestableLiteral,
  amountPesos: Type.Integer(),
  status: StatusLiteral,
  createdAt: Type.String(),
  expiresAt: Type.String(),
  decidedAt: NullableString,
  requesterName: Type.String(),
  requesterEmail: Type.String(),
  currentPlan: PlanLiteral,
}, { additionalProperties: false });

const MyPlanSchema = Type.Object({
  plan: PlanLiteral,
  storedPlan: PlanLiteral,
  paidUntil: NullableString,
  autoRenew: Type.Boolean(),
  freeDocumentsUsed: Type.Integer(),
  freeDocumentLimit: Type.Integer(),
  pendingRequest: Type.Union([RequestSchema, Type.Null()]),
  approver: Type.Boolean(),
  upgradesAvailable: Type.Boolean(),
}, { additionalProperties: false });

const WorkspacePlanSchema = Type.Object({
  plan: PlanLiteral,
  ownerIsYou: Type.Boolean(),
  ownerName: NullableString,
  paidUntil: NullableString,
}, { additionalProperties: false });

const Field = Type.String({ minLength: 1, maxLength: 120 });
const UpgradeBody = Type.Object({
  plan: RequestableLiteral,
  bank: Type.Object({
    bankName: Field,
    accountName: Field,
    accountNumber: Field,
    branch: Field,
    swiftCode: Field,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const WorkspaceParams = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 64 }) });
const RequestParams = Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 64 }) });

// ── Helpers ───────────────────────────────────────────────────────────────

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/** Field by field: every schema here is closed. */
const presentRequest = (r: PlanUpgradeRequestView) => ({
  requestId: r.requestId,
  plan: r.plan,
  amountPesos: r.amountPesos,
  status: r.status,
  createdAt: new Date(r.createdAt).toISOString(),
  expiresAt: new Date(r.expiresAt).toISOString(),
  decidedAt: iso(r.decidedAt),
});

const presentReview = (r: PlanUpgradeReviewView) => ({
  ...presentRequest(r),
  requesterName: r.requesterName,
  requesterEmail: r.requesterEmail,
  currentPlan: r.currentPlan,
});

type Operation = "invoice_downloaded" | "upgrade_requested" | "upgrade_cancelled" | "upgrade_approved" | "upgrade_declined";

export function registerPlanRoutes(app: FastifyInstance, options: PlanRouteOptions): void {
  const deps = options.dependencies;

  /** IDs and outcomes only — never an address, a name or a bank field. */
  const record = (request: FastifyRequest, operation: Operation, fields: Record<string, unknown>) => {
    const event = `plans.${operation}`;
    request.log.info({ event, result: "success", ...fields }, event);
    options.metrics?.increment("plan_operations_total", { operation, result: "success", processRole: "api" });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  app.get("/me/plan", {
    schema: { response: { 200: MyPlanSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const view = await getMyPlan(actor, deps());
    return reply.status(200).send({
      plan: view.plan,
      storedPlan: view.storedPlan,
      paidUntil: iso(view.paidUntil),
      autoRenew: view.autoRenew,
      freeDocumentsUsed: view.freeDocumentsUsed,
      freeDocumentLimit: view.freeDocumentLimit,
      pendingRequest: view.pendingRequest === null ? null : presentRequest(view.pendingRequest),
      approver: view.approver,
      upgradesAvailable: view.upgradesAvailable,
    });
  });

  // Test-mode invoices: one per approved plan change, the caller's own only.
  app.get("/me/plan/invoices", {
    schema: { response: { 200: InvoiceListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const invoices = await listMyPlanInvoices(actor, deps());
    return reply.status(200).send({
      invoices: invoices.map(i => ({
        number: i.number, requestId: i.requestId, plan: i.plan, planName: i.planName,
        amountPesos: i.amountPesos, issuedAt: new Date(i.issuedAt).toISOString(), periodEnd: new Date(i.periodEnd).toISOString(),
      })),
    });
  });

  // The invoice as a PDF, built here from what the server holds: the logo, the
  // QR code to the invoice in the app, and the test-mode sample account.
  app.get("/me/plan/invoices/:number/pdf", {
    schema: {
      params: Type.Object({ number: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9-]+$" }) }),
      querystring: Type.Object({ workspace: Type.Optional(Type.String({ maxLength: 120 })) }),
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { number } = request.params as { number: string };
    const { workspace } = request.query as { workspace?: string };
    const doc = await getMyPlanInvoice(actor, number, deps());
    const bytes = await renderPlanInvoice({
      number: doc.invoice.number, planName: doc.invoice.planName, amountPesos: doc.invoice.amountPesos,
      issuedAt: doc.invoice.issuedAt, periodEnd: doc.invoice.periodEnd, generatedAt: deps().clock.now(),
      billedTo: { ...doc.billedTo, workspace: workspace?.trim() || "Workspace owner" },
      url: doc.url ?? "https://lagda.io",
      sampleAccount: { bank: SAMPLE_BANK_ACCOUNT.bankName, accountName: SAMPLE_BANK_ACCOUNT.accountName, accountNumber: SAMPLE_BANK_ACCOUNT.accountNumber },
    });
    record(request, "invoice_downloaded", { invoice: doc.invoice.number });
    void reply.header("Content-Disposition", `attachment; filename="${doc.invoice.number}.pdf"`);
    void reply.header("X-Content-Type-Options", "nosniff");
    return reply.type("application/pdf").send(Buffer.from(bytes));
  });

  app.post("/me/plan/upgrade-requests", {
    schema: { body: UpgradeBody, response: { 201: RequestSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    if (options.rateLimit !== undefined) {
      await checkSemanticLimits(request, [{
        policy: policyById("plans.upgrade-request.user"), scope: { type: "user", userId: actor.userId },
      }], options.rateLimit);
    }
    const body = request.body as Static<typeof UpgradeBody>;
    const view = await requestPlanUpgrade(actor, { plan: body.plan, bank: body.bank }, deps());
    record(request, "upgrade_requested", { requestId: view.requestId, plan: view.plan });
    return reply.status(201).send(presentRequest(view));
  });

  app.post("/me/plan/upgrade-requests/cancel", {
    schema: { response: { 204: Type.Null() } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    await cancelMyPlanUpgradeRequest(actor, deps());
    record(request, "upgrade_cancelled", {});
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/plan", {
    schema: { params: WorkspaceParams, response: { 200: WorkspacePlanSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const view = await getWorkspacePlan(actor, workspaceId as WorkspaceId, deps());
    return reply.status(200).send({
      plan: view.plan,
      ownerIsYou: view.ownerIsYou,
      ownerName: view.ownerName,
      paidUntil: iso(view.paidUntil),
    });
  });

  // ── The approver ────────────────────────────────────────────────────────

  app.get("/plan-requests", {
    schema: { response: { 200: Type.Object({ requests: Type.Array(ReviewSchema) }, { additionalProperties: false }) } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const list = await listPendingPlanUpgradeRequests(actor, deps());
    return reply.status(200).send({ requests: list.map(presentReview) });
  });

  app.get("/plan-requests/:requestId", {
    schema: { params: RequestParams, response: { 200: ReviewSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { requestId } = request.params as Static<typeof RequestParams>;
    return reply.status(200).send(presentReview(await getPlanUpgradeRequest(actor, requestId, deps())));
  });

  for (const decision of ["approve", "decline"] as const) {
    app.post(`/plan-requests/:requestId/${decision}`, {
      schema: { params: RequestParams, response: { 200: ReviewSchema } },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      noStore(reply);
      const actor = await actorOf(request);
      if (actor === null) return unauthenticated(reply);
      const { requestId } = request.params as Static<typeof RequestParams>;
      const view = await decidePlanUpgradeRequest(actor, requestId, decision, deps());
      record(request, decision === "approve" ? "upgrade_approved" : "upgrade_declined", { requestId });
      return reply.status(200).send(presentReview(view));
    });
  }
}

// ── Gates ──────────────────────────────────────────────────────────────────

interface Gate {
  readonly method: string;
  readonly url: string;
  readonly minimum: "personal" | "business";
  readonly feature: string;
  /** When present, the gate applies only to requests it matches. */
  readonly when?: (request: FastifyRequest) => boolean;
  /** The CALLER's own plan decides, not the workspace owner's. */
  readonly own?: true;
}

const W = "/workspaces/:workspaceId";

/**
 * Every paid feature the server refuses on a Free (or lapsed) owner's
 * workspace — and, marked `own`, what a Free PERSON may not do anywhere
 * (joining another workspace). Reads, and taking things away (removing a logo, revoking a share,
 * removing a member), stay open: an expired month deletes nothing and hides
 * nothing that is already there.
 */
export const PLAN_GATES: readonly Gate[] = [
  { method: "PATCH", url: `${W}/branding`, minimum: "personal", feature: "Branding" },
  { method: "PUT", url: `${W}/branding/logo`, minimum: "personal", feature: "Branding" },
  { method: "POST", url: `${W}/documents/:documentId/shares`, minimum: "personal", feature: "Sharing documents" },
  { method: "POST", url: `${W}/invitations`, minimum: "business", feature: "Inviting members" },
  { method: "POST", url: `${W}/invitations/:invitationId/resend`, minimum: "business", feature: "Inviting members" },
  { method: "POST", url: `${W}/join-tickets`, minimum: "business", feature: "Join links" },
  { method: "PATCH", url: `${W}/join-tickets/:ticketId`, minimum: "business", feature: "Join links" },
  { method: "POST", url: `${W}/join-tickets/:ticketId/send`, minimum: "business", feature: "Join links" },
  { method: "POST", url: `${W}/join-requests/:requestId/approve`, minimum: "business", feature: "Approving join requests" },
  { method: "POST", url: `${W}/units`, minimum: "business", feature: "Teams" },
  { method: "PATCH", url: `${W}/units/:unitId`, minimum: "business", feature: "Teams" },
  { method: "POST", url: `${W}/units/:unitId/members`, minimum: "business", feature: "Teams" },
  { method: "PATCH", url: `${W}/units/:unitId/members/:userId`, minimum: "business", feature: "Teams" },
  { method: "GET", url: `${W}/activity`, minimum: "business", feature: "The activity log" },
  // Joining another workspace is the PERSON's feature: their own plan decides.
  { method: "POST", url: "/invitations/accept", minimum: "personal", feature: "Joining another workspace", own: true },
  { method: "POST", url: "/me/invitations/:invitationId/accept", minimum: "personal", feature: "Joining another workspace", own: true },
  { method: "POST", url: "/workspace-join/requests", minimum: "personal", feature: "Joining another workspace", own: true },
  {
    method: "POST", url: `${W}/contacts`, minimum: "business", feature: "Sharing contacts with the workspace",
    // Absent scope means "workspace" (the contacts module's default).
    when: request => (request.body as { scope?: unknown } | undefined)?.scope !== "personal",
  },
];

/** The gates, as one preHandler on the authenticated scope. */
export function registerPlanGates(
  app: FastifyInstance,
  dependencies: () => Pick<PlanDependencies, "plans" | "transactions" | "clock">,
): void {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    const url = request.routeOptions.url;
    if (url === undefined) return;
    const gate = PLAN_GATES.find(g => g.method === request.method && g.url === url);
    if (gate === undefined || (gate.when !== undefined && !gate.when(request))) return;
    if (gate.own === true) {
      if (request.auth.status !== "authenticated") return;
      await requireOwnPlan(request.auth.actor.userId, gate.minimum, gate.feature, dependencies());
      return;
    }
    const { workspaceId } = request.params as { workspaceId?: string };
    // Signed out, or no workspace in the route: the route's own checks answer.
    if (workspaceId === undefined || request.auth.status !== "authenticated") return;
    await requireWorkspacePlan(workspaceId as WorkspaceId, gate.minimum, gate.feature, dependencies(),
      request.auth.actor.userId);
  });
}
