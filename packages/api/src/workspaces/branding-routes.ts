// Workspace branding (082).
//
//   GET    /workspaces/:workspaceId/branding          any member
//   PATCH  /workspaces/:workspaceId/branding          owner / administrator
//   PUT    /workspaces/:workspaceId/branding/logo     owner / administrator (base64 PNG)
//   DELETE /workspaces/:workspaceId/branding/logo     owner / administrator
//   POST   /workspaces/:workspaceId/branding/reset    owner / administrator
//   GET    /workspaces/:workspaceId/branding/logo     any member (the PNG bytes)
//
// Registered inside the authenticated scope, so every state change carries a
// validated session and a CSRF token because of WHERE it is registered.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getWorkspaceBranding, updateWorkspaceBranding, setWorkspaceLogo, removeWorkspaceLogo,
  resetWorkspaceBranding, getWorkspaceLogo,
  BRANDING_SENDER_NAME_MAX_LENGTH, BRANDING_TAGLINE_MAX_LENGTH,
  type BrandingDependencies, type AuthenticatedActor, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import { validateLogoImage, MAX_LOGO_BASE64_LENGTH } from "../security/logo-image.js";

const Params = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 64 }) });

export const WorkspaceBrandingSchema = Type.Object({
  displayName: Type.String(),
  senderDisplayName: Type.Union([Type.String(), Type.Null()]),
  footerTagline: Type.Union([Type.String(), Type.Null()]),
  primaryColor: Type.Union([Type.String(), Type.Null()]),
  logo: Type.Union([Type.Null(), Type.Object({
    version: Type.String(), width: Type.Integer(), height: Type.Integer(),
  }, { additionalProperties: false })]),
  updatedAt: Type.Union([Type.Integer(), Type.Null()]),
  canEdit: Type.Boolean(),
}, { title: "WorkspaceBranding", additionalProperties: false });

const UpdateSchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  senderDisplayName: Type.Optional(Type.Union([
    Type.String({ maxLength: BRANDING_SENDER_NAME_MAX_LENGTH }), Type.Null()])),
  footerTagline: Type.Optional(Type.Union([
    Type.String({ maxLength: BRANDING_TAGLINE_MAX_LENGTH }), Type.Null()])),
  primaryColor: Type.Optional(Type.Union([Type.String({ maxLength: 7 }), Type.Null()])),
}, { additionalProperties: false });

const LogoSchema = Type.Object({
  /** Base64 PNG, no `data:` prefix. Checked from its bytes. */
  image: Type.String({ minLength: 1, maxLength: MAX_LOGO_BASE64_LENGTH }),
}, { additionalProperties: false });

export interface BrandingRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId; readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => BrandingDependencies;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({ error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." } });
}

export function registerBrandingRoutes(app: FastifyInstance, options: BrandingRouteOptions): void {
  const actorOf = async (request: FastifyRequest): Promise<AuthenticatedActor | null> => {
    const who = await options.authenticatedUser(request);
    return who === null ? null : { actorType: "user", userId: who.userId, sessionId: who.sessionId };
  };
  const workspaceOf = (request: FastifyRequest) =>
    (request.params as Static<typeof Params>).workspaceId as WorkspaceId;

  app.get("/workspaces/:workspaceId/branding", {
    schema: { params: Params, response: { 200: WorkspaceBrandingSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    return reply.status(200).send(await getWorkspaceBranding(actor, workspaceOf(request), options.dependencies()));
  });

  app.patch("/workspaces/:workspaceId/branding", {
    schema: { params: Params, body: UpdateSchema, response: { 200: WorkspaceBrandingSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const body = request.body as Static<typeof UpdateSchema>;
    return reply.status(200).send(
      await updateWorkspaceBranding(actor, workspaceOf(request), body, options.dependencies()));
  });

  app.put("/workspaces/:workspaceId/branding/logo", {
    schema: { params: Params, body: LogoSchema, response: { 200: WorkspaceBrandingSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const validated = validateLogoImage((request.body as Static<typeof LogoSchema>).image);
    if (validated === null) {
      return reply.status(422).send({
        error: {
          code: "INVALID_LOGO",
          message: "That image could not be used. Choose a PNG or JPEG logo.",
        },
      });
    }
    return reply.status(200).send(
      await setWorkspaceLogo(actor, workspaceOf(request), validated, options.dependencies()));
  });

  app.delete("/workspaces/:workspaceId/branding/logo", {
    schema: { params: Params, response: { 200: WorkspaceBrandingSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    return reply.status(200).send(
      await removeWorkspaceLogo(actor, workspaceOf(request), options.dependencies()));
  });

  app.post("/workspaces/:workspaceId/branding/reset", {
    schema: { params: Params, response: { 200: WorkspaceBrandingSchema } },
  }, async (request, reply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    return reply.status(200).send(
      await resetWorkspaceBranding(actor, workspaceOf(request), options.dependencies()));
  });

  app.get("/workspaces/:workspaceId/branding/logo", {
    schema: { params: Params },
  }, async (request, reply) => {
    const actor = await actorOf(request);
    if (actor === null) { noStore(reply); return unauthenticated(reply); }
    const logo = await getWorkspaceLogo(actor, workspaceOf(request), options.dependencies());
    if (logo === null) {
      noStore(reply);
      return reply.status(404).send({ error: { code: "LOGO_NOT_FOUND", message: "No logo is set." } });
    }
    // Versioned by `?v=<digest>` on the client, so it may be kept; `private`
    // so no shared cache holds a workspace's asset.
    void reply.header("Cache-Control", "private, max-age=31536000, immutable");
    void reply.header("ETag", `"${logo.digest}"`);
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Content-Security-Policy", "default-src 'none'");
    return reply.type(logo.mediaType).send(Buffer.from(logo.bytes));
  });
}
