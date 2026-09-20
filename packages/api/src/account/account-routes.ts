// The authenticated account surface.
//
//   GET    /me                      the current user
//   PATCH  /me/profile              editable profile fields
//   PATCH  /me/preferences          personal preferences
//   POST   /me/password             change password (requires the current one)
//   GET    /me/sessions             the caller's own sessions
//   POST   /me/sessions/revoke      revoke one, or all others
//   GET    /me/signatures           the caller's saved signatures
//   PUT    /me/signatures/:purpose  save or replace one
//   DELETE /me/signatures/:purpose  remove one
//   POST   /me/signing-links        claim a signing handoff code
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
import type {
  UserSignatureRepository, UserSignaturePurpose, SavedSignature,
} from "@lagda/db";
import type { SignatureImageValidator } from "@lagda/application";
import { SignatureRepresentationSchema } from "@lagda/contracts";
import { randomUUID } from "node:crypto";
import { pngCanHaveTransparency } from "../security/signature-image.js";
import {
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  clearCookieOptions, clearCsrfCookieOptions,
} from "../security/cookies.js";

const literals = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map(value => Type.Literal(value)));

const NullableName = Type.Union([
  Type.String({ maxLength: NAME_MAX_LENGTH }), Type.Null(),
]);

// ── Saved signatures ────────────────────────────────────────────────────────

const SIGNATURE_PURPOSES = ["signature", "initials"] as const;

/**
 * The same two shapes the ceremony accepts, deliberately.
 *
 * A saved signature exists to be applied to a document later, so anything the
 * library accepts must be something the ceremony would accept. Reusing the
 * contract's own schemas rather than restating them is what keeps that true:
 * if the ceremony's bounds tighten, this tightens with it, in the same commit.
 */
const SavedSignatureRequestSchema = Type.Object({
  representation: SignatureRepresentationSchema,
}, { title: "SaveUserSignatureRequest", additionalProperties: false });

const SavedSignatureSchema = Type.Object({
  purpose: literals(SIGNATURE_PURPOSES),
  method: Type.Union([Type.Literal("typed"), Type.Literal("drawn")]),
  /** Present for a typed signature only. */
  text: Type.Optional(Type.String()),
  styleIndex: Type.Optional(Type.Integer()),
  /** Present for a drawn signature only. Re-encoded from the stored bytes. */
  base64: Type.Optional(Type.String()),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
  /** SHA-256 of the stored bytes. Lets a client detect a change without refetching. */
  digest: Type.String(),
  /** Null until the bytes passed validation. An unusable entry says so. */
  validatedAt: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
}, { title: "SavedSignature", additionalProperties: false });

const SavedSignatureListSchema = Type.Object({
  signatures: Type.Array(SavedSignatureSchema),
}, { title: "SavedSignatureList", additionalProperties: false });

const ClaimSigningLinkRequestSchema = Type.Object({
  /** The opaque code minted by the ceremony. Never an id, never an address. */
  code: Type.String({ minLength: 8, maxLength: 64 }),
}, { title: "ClaimSigningLinkRequest", additionalProperties: false });

const ClaimSigningLinkResponseSchema = Type.Object({
  signingRequestId: Type.String(),
  recipientId: Type.String(),
}, { title: "ClaimSigningLinkResponse", additionalProperties: false });

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
  /**
   * The same double-submit check `requireSession` installs.
   *
   * `/me` is registered OUTSIDE the authenticated scope, so that hook does not
   * reach it. Every existing route here is either a read or a write already
   * gated by the current password — but a saved signature is neither, and its
   * payload is later drawn onto a legally binding document. It gets the check.
   */
  readonly validateCsrf: (request: FastifyRequest) => boolean;
  readonly signatures: () => UserSignatureRepository;
  /** Claims a ceremony handoff code as this account. See migration 051. */
  readonly claimSigningLink: (
    userId: UserId, code: string,
  ) => Promise<{ signingRequestId: string; recipientId: string }>;
  readonly signatureImages: () => SignatureImageValidator;
  readonly now: () => Date;
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

  // ── Saved signatures ────────────────────────────────────────────────────
  //
  // A PREFERENCE, not evidence. Applying one in a ceremony inserts a fresh
  // representation row with its own digest; the evidence never points here.
  // See migration 050 for why that separation is load-bearing.
  //
  // ── No step-up authentication here, and why that is a decision ──────────
  //
  // Saving a signature is not yet dangerous: nothing applies one automatically.
  // The moment auto-sign exists, a compromised session stops being "read my
  // documents" and becomes "put my handwritten mark on a binding contract" —
  // and at THAT point a re-entered password becomes mandatory, on both saving
  // and applying. This is recorded here rather than left implicit so it reads
  // as a sequencing choice and not as an omission nobody noticed.

  const projectSignature = (saved: SavedSignature) => {
    const common = {
      purpose: saved.purpose,
      digest: saved.digest,
      validatedAt: saved.validatedAt === null ? null : saved.validatedAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
    if (saved.representationType === "TYPED_SIGNATURE_V1") {
      return {
        ...common,
        method: "typed" as const,
        text: saved.typedText ?? "",
        styleIndex: saved.typedStyleIndex ?? 0,
      };
    }
    return {
      ...common,
      method: "drawn" as const,
      // Re-encoded from the STORED bytes, never echoed from the request.
      base64: (saved.rasterBytes ?? Buffer.alloc(0)).toString("base64"),
      width: saved.rasterWidth ?? 0,
      height: saved.rasterHeight ?? 0,
    };
  };

  const readPurpose = (request: FastifyRequest): UserSignaturePurpose | null => {
    const value = (request.params as { purpose?: string }).purpose;
    return value === "signature" || value === "initials" ? value : null;
  };

  app.get("/me/signatures", {
    schema: { response: { 200: SavedSignatureListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const saved = await options.signatures().list(actor.userId);
    return reply.status(200).send({ signatures: saved.map(projectSignature) });
  });

  app.put("/me/signatures/:purpose", {
    schema: {
      body: SavedSignatureRequestSchema,
      response: { 200: SavedSignatureSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);
    if (!options.validateCsrf(request)) return csrfFailed(reply);

    const purpose = readPurpose(request);
    if (purpose === null) return unknownPurpose(reply);

    const { representation } = request.body as {
      representation:
        | { method: "typed"; text: string; styleIndex: number }
        | { method: "drawn"; base64: string };
    };
    const now = options.now();
    const images = options.signatureImages();

    if (representation.method === "typed") {
      const saved = await options.signatures().save({
        userSignatureId: `usig_${randomUUID().replace(/-/g, "")}`,
        userId: actor.userId,
        purpose,
        representationType: "TYPED_SIGNATURE_V1",
        typedText: representation.text,
        typedStyleIndex: representation.styleIndex,
        rasterBytes: null, rasterMediaType: null,
        rasterWidth: null, rasterHeight: null,
        // The SAME canonical form the ceremony digests, copied from
        // signing-submission.ts rather than invented here. Two different
        // canonical forms would mean the same typed signature has two
        // different integrity identifiers depending on where it was saved.
        digest: images.digestCanonical(JSON.stringify({
          v: 1, text: representation.text, styleIndex: representation.styleIndex,
        })),
        validatedAt: now,
        now,
      });
      return reply.status(200).send(projectSignature(saved));
    }

    // The SAME validator the ceremony uses: magic bytes, IHDR, dimensions,
    // length, digest. A library that accepted what a ceremony would refuse
    // would fail at the worst possible moment — mid-signature.
    const validated = images.validate(representation.base64);
    if (validated === null) return unusableImage(reply);

    // The sealer embeds with no compositing control, so a fully opaque PNG
    // paints a rectangle over whatever it lands on. The signer never sees it:
    // the preview shows their signature and the box appears only in the sealed
    // document. Refused here rather than discovered there.
    if (!pngCanHaveTransparency(validated.bytes)) return opaqueImage(reply);

    const saved = await options.signatures().save({
      userSignatureId: `usig_${randomUUID().replace(/-/g, "")}`,
      userId: actor.userId,
      purpose,
      representationType: "RASTER_SIGNATURE_V1",
      typedText: null, typedStyleIndex: null,
      rasterBytes: validated.bytes,
      rasterMediaType: validated.mediaType,
      rasterWidth: validated.width,
      rasterHeight: validated.height,
      digest: validated.digest,
      validatedAt: now,
      now,
    });
    return reply.status(200).send(projectSignature(saved));
  });

  app.delete("/me/signatures/:purpose", {
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);
    if (!options.validateCsrf(request)) return csrfFailed(reply);

    const purpose = readPurpose(request);
    if (purpose === null) return unknownPurpose(reply);

    // Idempotent: deleting what is not there is a success, not a 404. The
    // caller's goal — "I do not have a saved signature" — is satisfied either
    // way, and a 404 would only invite a retry that cannot help.
    await options.signatures().remove(actor.userId, purpose);
    return reply.status(204).send();
  });

  // ── Signing handoff ─────────────────────────────────────────────────────
  //
  // The WORKSPACE half of the account binding. The recipient realm minted a
  // code saying "whoever presents this claims to be the account for this
  // address"; this is the side that can check it, because only this side
  // knows who is signed in.
  //
  // It grants nothing. No ceremony is opened, no document becomes readable,
  // no signature becomes possible. It records that an account and a recipient
  // are the same person, and the ceremony remains gated by the credential
  // from the emailed link exactly as before.
  app.post("/me/signing-links", {
    schema: {
      body: ClaimSigningLinkRequestSchema,
      response: { 200: ClaimSigningLinkResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);
    if (!options.validateCsrf(request)) return csrfFailed(reply);

    const { code } = request.body as { code: string };
    try {
      const claimed = await options.claimSigningLink(actor.userId, code);
      // Ids only. Never the code, never either address.
      request.log.info({
        event: "signing_account_link.claimed",
        signingRequestId: claimed.signingRequestId,
      }, "signing_account_link.claimed");
      return reply.status(200).send(claimed);
    } catch {
      // ONE refusal for every cause — unknown, expired, already claimed,
      // wrong account, unverified address. Distinguishing them would let a
      // caller holding a code learn that some other account owns that
      // address, which is exactly what the single error prevents.
      return reply.status(422).send({
        error: {
          code: "SIGNING_LINK_NOT_CLAIMABLE",
          message: "This sign-in link could not be used. Open the signing link again and retry.",
        },
      });
    }
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

function csrfFailed(reply: FastifyReply): FastifyReply {
  return reply.status(403).send({
    error: {
      code: "csrf_validation_failed",
      message: "The request could not be verified. Please retry from the application.",
    },
  });
}

function unknownPurpose(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({
    error: {
      code: "UNKNOWN_SIGNATURE_PURPOSE",
      message: "A saved signature is either a signature or a set of initials.",
    },
  });
}

function unusableImage(reply: FastifyReply): FastifyReply {
  return reply.status(422).send({
    error: {
      code: "SIGNATURE_IMAGE_INVALID",
      message: "That image could not be used. It must be a PNG of your signature.",
    },
  });
}

function opaqueImage(reply: FastifyReply): FastifyReply {
  return reply.status(422).send({
    error: {
      code: "SIGNATURE_IMAGE_OPAQUE",
      // Says what to do, because the fix is not obvious from the failure.
      message: "That image has no transparent background, so it would cover part "
        + "of the document. Upload it again and let the background be removed.",
    },
  });
}
