// The authenticated account surface.
//
//   GET    /me                      the current user
//   PATCH  /me/profile              editable profile fields
//   PATCH  /me/preferences          personal preferences
//   POST   /me/password             change password (requires the current one)
//   GET    /me/sessions             the caller's own sessions
//   POST   /me/sessions/revoke      revoke one, or all others
//
// ── There is no user id in any path ────────────────────────────────────────
//
// Every route resolves the account from the validated session and nothing else.
// That is a structural choice, not a check: with no `:userId` segment and no
// `userId` field in any schema, "user A edits user B" is not a request that can
// be expressed, so there is no authorization comparison to get wrong (§20, §168).
//
// ── A pre-auth credential is not a session ─────────────────────────────────
//
// `authenticatedUser` resolves a FULL session only. A browser midway through an
// MFA ceremony has proved a password and nothing more, and must not be able to
// read an account or edit it (§21, §158).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getCurrentUser, updateCurrentUserProfile, updateCurrentUserPreferences,
  changeCurrentPassword, listOwnSessions, revokeOwnSession, revokeOtherSessions,
  NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH,
  DATE_FORMATS, TIME_FORMATS, NUMBER_FORMATS, APPEARANCES, DENSITIES,
  DOCUMENT_LIST_VIEWS,
  type GetCurrentUserDependencies, type UpdateProfileDependencies,
  type UpdatePreferencesDependencies, type ChangePasswordDependencies,
  type ListSessionsDependencies, type RevokeSessionDependencies,
  type RevokeOtherSessionsDependencies,
  type UserId, type SessionId, type UpdatePreferencesInput,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  clearCookieOptions, clearCsrfCookieOptions,
} from "../security/cookies.js";

const literals = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map(value => Type.Literal(value)));

const NullableName = Type.Union([
  Type.String({ maxLength: NAME_MAX_LENGTH }), Type.Null(),
]);

// ── Response projections ────────────────────────────────────────────────────

export const CurrentUserResponseSchema = Type.Object({
  userId: Type.String(),
  /** The DISPLAY address. `normalized_email` is internal and never leaves. */
  email: Type.String(),
  /** Derived. The timestamp is not exposed — the product renders a badge. */
  emailVerified: Type.Boolean(),
  profile: Type.Object({
    fullName: Type.Union([Type.String(), Type.Null()]),
    displayName: Type.String(),
    jobTitle: Type.Union([Type.String(), Type.Null()]),
    department: Type.Union([Type.String(), Type.Null()]),
    preferredSenderName: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }),
  preferences: Type.Object({
    timezone: Type.Union([Type.String(), Type.Null()]),
    locale: Type.Union([Type.String(), Type.Null()]),
    language: Type.Union([Type.String(), Type.Null()]),
    dateFormat: Type.Union([literals(DATE_FORMATS), Type.Null()]),
    timeFormat: Type.Union([literals(TIME_FORMATS), Type.Null()]),
    numberFormat: Type.Union([literals(NUMBER_FORMATS), Type.Null()]),
    appearance: Type.Union([literals(APPEARANCES), Type.Null()]),
    density: Type.Union([literals(DENSITIES), Type.Null()]),
    documentListView: Type.Union([literals(DOCUMENT_LIST_VIEWS), Type.Null()]),
  }, { additionalProperties: false }),
  /**
   * A SUMMARY. Whether a factor exists and of what type — never the secret,
   * the provisioning URI, the replay watermark, or any challenge state (§8).
   */
  security: Type.Object({
    mfaEnabled: Type.Boolean(),
    mfaFactor: Type.Union([Type.Literal("TOTP"), Type.Null()]),
    recoveryCodesRemaining: Type.Union([Type.Integer(), Type.Null()]),
  }, { additionalProperties: false }),
  createdAt: Type.Integer(),
}, { additionalProperties: false });

/**
 * The profile mutation. FIVE fields, and nothing else.
 *
 * `additionalProperties: false` is what makes `{"emailVerified": true}` a 400
 * rather than a silently-ignored field. Fastify would strip an unknown property
 * before the handler saw it, so a leak assertion in a handler could not observe
 * the failure — the schema is the control (§19, §161).
 *
 * Deliberately absent: `email`, `password`, `mfaEnabled`, `role`, `workspaceId`,
 * `isSystemAdmin`, `userId`.
 */
export const UpdateProfileRequestSchema = Type.Object({
  fullName: Type.Optional(NullableName),
  displayName: Type.Optional(NullableName),
  jobTitle: Type.Optional(NullableName),
  department: Type.Optional(NullableName),
  preferredSenderName: Type.Optional(NullableName),
}, { additionalProperties: false });

export const UpdatePreferencesRequestSchema = Type.Object({
  timezone: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  locale: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
  language: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
  dateFormat: Type.Optional(Type.Union([literals(DATE_FORMATS), Type.Null()])),
  timeFormat: Type.Optional(Type.Union([literals(TIME_FORMATS), Type.Null()])),
  numberFormat: Type.Optional(Type.Union([literals(NUMBER_FORMATS), Type.Null()])),
  appearance: Type.Optional(Type.Union([literals(APPEARANCES), Type.Null()])),
  density: Type.Optional(Type.Union([literals(DENSITIES), Type.Null()])),
  documentListView: Type.Optional(
    Type.Union([literals(DOCUMENT_LIST_VIEWS), Type.Null()])),
}, { additionalProperties: false });

export const ChangePasswordRequestSchema = Type.Object({
  currentPassword: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
  newPassword: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
}, { additionalProperties: false });

export const ChangePasswordResponseSchema = Type.Object({
  status: Type.Literal("changed"),
  /** A COUNT. Session identifiers are never returned (§135). */
  otherSessionsRevoked: Type.Integer(),
}, { additionalProperties: false });

export const SessionListResponseSchema = Type.Object({
  sessions: Type.Array(Type.Object({
    sessionId: Type.String(),
    createdAt: Type.Integer(),
    lastSeenAt: Type.Integer(),
    expiresAt: Type.Integer(),
    isCurrent: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const RevokeSessionRequestSchema = Type.Object({
  /** Absent means "every session except this one". */
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

export const RevokeSessionResponseSchema = Type.Object({
  revoked: Type.Integer(),
  /** True when the caller signed themselves out; the client should redirect. */
  signedOut: Type.Boolean(),
}, { additionalProperties: false });

export type UpdateProfileRequest = Static<typeof UpdateProfileRequestSchema>;
export type UpdatePreferencesRequest = Static<typeof UpdatePreferencesRequestSchema>;
export type ChangePasswordRequest = Static<typeof ChangePasswordRequestSchema>;
export type RevokeSessionRequest = Static<typeof RevokeSessionRequestSchema>;

export interface AccountRouteOptions {
  readonly config: ApiConfig;
  /**
   * Resolves a FULL session. Returns null for anonymous callers and for a
   * browser holding only a pre-auth credential.
   */
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly currentUserDependencies: () => GetCurrentUserDependencies;
  readonly updateProfileDependencies: () => UpdateProfileDependencies;
  readonly updatePreferencesDependencies: () => UpdatePreferencesDependencies;
  readonly changePasswordDependencies: () => ChangePasswordDependencies;
  readonly listSessionsDependencies: () => ListSessionsDependencies;
  readonly revokeSessionDependencies: () => RevokeSessionDependencies;
  readonly revokeOtherSessionsDependencies: () => RevokeOtherSessionsDependencies;
}

/**
 * Account responses are never cacheable.
 *
 * `no-store`, not `no-cache`: the latter permits a shared cache to KEEP the
 * response and merely revalidate it. An account body carries an email address
 * and MFA status, and a proxy holding a copy of one user's `/me` is exactly the
 * failure to avoid (§127).
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

export function registerAccountRoutes(
  app: FastifyInstance,
  options: AccountRouteOptions,
): void {
  // ── Current user ────────────────────────────────────────────────────────
  app.get("/me", {
    schema: { response: { 200: CurrentUserResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const user = await getCurrentUser(actor.userId, options.currentUserDependencies());
    if (user === null) {
      // A valid session pointing at an account that no longer exists is a
      // security inconsistency, not an empty profile. Returning a blank user
      // would let the frontend render a logged-in shell for nobody (§227).
      void reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(options.config));
      void reply.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions(options.config));
      return unauthenticated(reply);
    }
    return reply.status(200).send(project(user));
  });

  // ── Profile ─────────────────────────────────────────────────────────────
  app.patch("/me/profile", {
    schema: {
      body: UpdateProfileRequestSchema,
      response: { 200: CurrentUserResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const body = request.body as UpdateProfileRequest;
    const result = await updateCurrentUserProfile(actor.userId, {
      fullName: body.fullName ?? null,
      displayName: body.displayName ?? null,
      jobTitle: body.jobTitle ?? null,
      department: body.department ?? null,
      preferredSenderName: body.preferredSenderName ?? null,
    }, options.updateProfileDependencies());

    if (result.outcome === "invalid") {
      return reply.status(422).send({
        error: { code: "INVALID_PROFILE", message: messageFor(result.reason) },
      });
    }
    if (result.outcome === "not-found") return unauthenticated(reply);
    return reply.status(200).send(project(result.user));
  });

  // ── Preferences ─────────────────────────────────────────────────────────
  app.patch("/me/preferences", {
    schema: {
      body: UpdatePreferencesRequestSchema,
      response: { 200: CurrentUserResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    // The cast is sound because AJV has already validated the body against the
    // CLOSED enums above — a value outside `DATE_FORMATS` is a 400 before this
    // line runs. The helper that builds those unions widens the literal types,
    // which is a TypeBox limitation rather than a loosening of the contract.
    const result = await updateCurrentUserPreferences(
      actor.userId,
      request.body as UpdatePreferencesInput,
      options.updatePreferencesDependencies());

    if (result.outcome === "invalid") {
      return reply.status(422).send({
        error: {
          code: "INVALID_PREFERENCES",
          message: "That time zone is not recognized.",
        },
      });
    }
    if (result.outcome === "not-found") return unauthenticated(reply);
    return reply.status(200).send(project(result.user));
  });

  // ── Password ────────────────────────────────────────────────────────────
  app.post("/me/password", {
    schema: {
      body: ChangePasswordRequestSchema,
      response: { 200: ChangePasswordResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const body = request.body as ChangePasswordRequest;
    const result = await changeCurrentPassword(actor.userId, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      currentSessionId: actor.sessionId,
    }, options.changePasswordDependencies());

    if (result.outcome === "invalid-current-password") {
      // One safe code. Nothing about the stored hash or its parameters (§225).
      return reply.status(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "That password is incorrect.",
        },
      });
    }
    if (result.outcome === "invalid-new-password") {
      return reply.status(422).send({
        error: {
          code: "INVALID_PASSWORD",
          message: result.reason === "too-short"
            ? "That password is too short." : "That password is too long.",
        },
      });
    }
    if (result.outcome === "not-found") return unauthenticated(reply);

    // The caller's own session SURVIVES — no new cookie is issued and none is
    // cleared. Signing someone out of the browser they used to change their
    // password teaches them the security action breaks things (§40).
    return reply.status(200).send({
      status: "changed" as const,
      otherSessionsRevoked: result.revokedSessionCount,
    });
  });

  // ── Sessions ────────────────────────────────────────────────────────────
  app.get("/me/sessions", {
    schema: { response: { 200: SessionListResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const sessions = await listOwnSessions(
      actor.userId, actor.sessionId, options.listSessionsDependencies());
    // No token, no digest, no IP, no user agent — the projection carries only
    // what the product's own page says it shows.
    return reply.status(200).send({ sessions });
  });

  app.post("/me/sessions/revoke", {
    schema: {
      body: RevokeSessionRequestSchema,
      response: { 200: RevokeSessionResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const body = request.body as RevokeSessionRequest;

    if (body.sessionId === undefined) {
      const revoked = await revokeOtherSessions(
        actor.userId, actor.sessionId,
        options.revokeOtherSessionsDependencies());
      return reply.status(200).send({ revoked, signedOut: false });
    }

    const result = await revokeOwnSession(actor.userId, {
      sessionId: body.sessionId as SessionId,
      currentSessionId: actor.sessionId,
    }, options.revokeSessionDependencies());

    if (result.outcome === "not-found") {
      // The same answer for "no such session" and "belongs to someone else".
      // Separating them would make this an oracle for which ids exist (§201).
      return reply.status(404).send({
        error: { code: "SESSION_NOT_FOUND", message: "No such session." },
      });
    }

    if (result.wasCurrent) {
      // The user signed themselves out from the settings page. The session is
      // already dead server-side; clearing the cookies stops the browser
      // presenting a revoked credential on every subsequent request (§91).
      void reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(options.config));
      void reply.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions(options.config));
    }
    return reply.status(200).send({ revoked: 1, signedOut: result.wasCurrent });
  });
}

/** Maps the domain projection to the wire shape. Never a database row (§104). */
function project(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (user === null) throw new Error("unreachable");
  return {
    userId: user.userId,
    email: user.email,
    emailVerified: user.emailVerified,
    profile: user.profile,
    preferences: user.preferences,
    security: user.security,
    createdAt: user.createdAt,
  };
}

function messageFor(reason: string): string {
  switch (reason) {
    case "full-name-too-short": return "Full name must be at least 2 characters.";
    case "display-name-required": return "A display name is required.";
    case "control-characters": return "That value contains unsupported characters.";
    default: return "That value is too long.";
  }
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}
