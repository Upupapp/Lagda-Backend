// The account surface's HTTP contract.
//
// The properties under test: a pre-auth credential is not a session, every
// security field is refused at the schema, and no response carries a credential.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type {
  GetCurrentUserDependencies, UpdateProfileDependencies,
  UpdatePreferencesDependencies, ChangePasswordDependencies,
  ListSessionsDependencies, RevokeSessionDependencies,
  RevokeOtherSessionsDependencies, CurrentUser, PasswordHash,
  SessionId, UserId, SignedDocumentView, CompletedOtherDocumentView, ParticipantCompletionView,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import type { UserSignatureRepository, SavedSignature } from "@lagda/db";
import { createSignatureImageValidator } from "../security/signature-image.js";
import { fakeNotificationPreferences } from "@lagda/application/test-support";
import {
  registerAccountRoutes, CurrentUserResponseSchema,
  UpdateProfileRequestSchema, ChangePasswordRequestSchema,
  SessionListResponseSchema,
} from "./account-routes.js";

const HASH = "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash;
const NORMALIZED = "real.user@example.com";
const SESSION_TOKEN = "S".repeat(43);
const PASSWORD = "correct horse battery staple";

/** 072. One in-memory photo store; each photo test clears it first. */
const avatarMap = new Map<string, { bytes: Buffer; digest: string }>();
const avatarStore = {
  find: (id: string) => {
    const a = avatarMap.get(id);
    return Promise.resolve(a === undefined ? null : { mediaType: "image/png" as const, ...a });
  },
  versionOf: (id: string) => Promise.resolve(avatarMap.get(id)?.digest ?? null),
  save: (i: { userId: string; bytes: Buffer; digest: string }) => {
    avatarMap.set(i.userId, { bytes: i.bytes, digest: i.digest });
    return Promise.resolve();
  },
  remove: (id: string) => Promise.resolve(avatarMap.delete(id)),
};

const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

function currentUser(): CurrentUser {
  return {
    userId: "usr_1" as UserId,
    email: "Real.User@Example.com",
    emailVerified: true,
    profile: {
      fullName: "Real User", displayName: "Real",
      jobTitle: "Notary", department: "Legal",
      preferredSenderName: "Real U.",
    },
    preferences: {
      timezone: "Asia/Manila", locale: "en-PH", language: "en",
      dateFormat: "DD/MM/YYYY", timeFormat: "24h", numberFormat: "comma-dot",
      appearance: "system", density: "comfortable", documentListView: "table",
    },
    security: { mfaEnabled: true, mfaFactor: "TOTP", recoveryCodesRemaining: 8 },
    createdAt: 1_700_000_000_000,
  };
}

interface Built {
  readonly app: FastifyInstance;
  readonly profileWrites: unknown[];
  readonly revoked: string[];
  readonly feedQueries: { userId: string; limit: number; includeDismissed?: boolean }[];
  readonly stateWrites: { userId: string; ids: readonly string[]; change: unknown }[];
  readonly preferences: ReturnType<typeof fakeNotificationPreferences>;
}

async function build(options: {
  signedDocuments?: readonly SignedDocumentView[];
  completedOthers?: readonly CompletedOtherDocumentView[];
  participantLogo?: { mediaType: string; bytes: Uint8Array; digest: string } | null;
  authenticated?: boolean;
  userExists?: boolean;
  passwordOutcome?: "changed" | "invalid-current-password";
  revokeFound?: boolean;
  revokeCurrent?: boolean;
  csrfValid?: boolean;
  notifications?: {
    notificationIntentId: string; notificationType: string;
    workspaceId: string | null; sourceKind: string; sourceId: string;
    templateInput: unknown; createdAt: Date;
    readAt?: Date | null; dismissedAt?: Date | null;
  }[];
} = {}): Promise<Built> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false, coerceTypes: true, allErrors: true,
      },
    },
  });
  await app.register(cookie);
  const profileWrites: unknown[] = [];
  const feedQueries: { userId: string; limit: number; includeDismissed?: boolean }[] = [];
  const stateWrites: { userId: string; ids: readonly string[]; change: unknown }[] = [];
  const revoked: string[] = [];
  const preferences = fakeNotificationPreferences();

  // An in-memory stand-in for the saved-signature table, honouring the one
  // property the real one enforces with a UNIQUE constraint: at most one per
  // purpose, so saving twice replaces rather than accumulates.
  const stored = new Map<string, SavedSignature>();
  const savedSignatures: UserSignatureRepository = {
    list: () => Promise.resolve([...stored.values()]),
    find: (_userId, purpose) => Promise.resolve(stored.get(purpose) ?? null),
    save: (input) => {
      const row: SavedSignature = {
        userSignatureId: input.userSignatureId,
        purpose: input.purpose,
        representationType: input.representationType,
        typedText: input.typedText,
        typedStyleIndex: input.typedStyleIndex,
        rasterBytes: input.rasterBytes,
        rasterMediaType: input.rasterMediaType,
        rasterWidth: input.rasterWidth,
        rasterHeight: input.rasterHeight,
        digest: input.digest,
        validatedAt: input.validatedAt,
        createdAt: input.now,
        updatedAt: input.now,
      };
      stored.set(input.purpose, row);
      return Promise.resolve(row);
    },
    remove: (_userId, purpose) => Promise.resolve(stored.delete(purpose)),
  };

  const accounts = {
    findCurrentUser: () => Promise.resolve(
      options.userExists === false ? null : currentUser()),
    updateProfile(input: unknown) {
      profileWrites.push(input);
      return Promise.resolve(true);
    },
    updatePreferences(input: unknown) {
      profileWrites.push(input);
      return Promise.resolve(true);
    },
  };

  const notificationFeed = {
    listForUser: (userId: string, limit: number, feed: { includeDismissed?: boolean } = {}) => {
      feedQueries.push({
        userId, limit,
        ...(feed.includeDismissed === undefined ? {} : { includeDismissed: feed.includeDismissed }),
      });
      return Promise.resolve((options.notifications ?? []).map(row => ({
        readAt: null, dismissedAt: null, ...row,
      })));
    },
    setStates: (userId: string, ids: readonly string[], change: unknown) => {
      stateWrites.push({ userId, ids, change });
      return Promise.resolve(ids.length);
    },
  };

  registerAccountRoutes(app, {
    config: CONFIG,
    validateCsrf: () => options.csrfValid !== false,
    signatures: () => savedSignatures,
    avatars: () => avatarStore,
    notificationFeed: () => notificationFeed,
    notificationPreferences: () => preferences,
    claimSigningLink: () => Promise.reject(new Error("not used")),
    listDocumentsToSign: () => Promise.resolve([]),
    listSignedDocuments: () => Promise.resolve(options.signedDocuments ?? []),
    listCompletedOtherDocuments: () => Promise.resolve(options.completedOthers ?? []),
    participantDocumentLogo: (_userId, verificationId) => {
      logoLookups.push(verificationId);
      return Promise.resolve(options.participantLogo ?? null);
    },
    beginInAppSigning: () => Promise.reject(new Error("not used")),
    signatureImages: () => createSignatureImageValidator(),
    now: () => new Date(1_700_000_000_000),
    authenticatedUser: () => Promise.resolve(
      options.authenticated === false
        ? null
        : { userId: "usr_1" as UserId, sessionId: "ses_1" as SessionId }),
    currentUserDependencies: (): GetCurrentUserDependencies => ({ accounts }),
    updateProfileDependencies: (): UpdateProfileDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      commit: operation => operation({ accounts }),
    }),
    updatePreferencesDependencies: (): UpdatePreferencesDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      isKnownTimezone: () => true,
      commit: operation => operation({ accounts }),
    }),
    changePasswordDependencies: (): ChangePasswordDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      hasher: {
        hash: () => Promise.resolve(HASH),
        verify: () => Promise.resolve(
          options.passwordOutcome !== "invalid-current-password"),
        needsRehash: () => false,
      },
      credentials: { findPasswordHash: () => Promise.resolve(HASH) },
      commit: operation => operation({
        credentials: {
          findPasswordHash: () => Promise.resolve(HASH),
          replacePasswordHash: () => Promise.resolve(true),
        },
        sessions: {
          listActiveForUser: () => Promise.resolve([]),
          revokeOwnedByUser: () => Promise.resolve(true),
          revokeAllForUserExcept: () => Promise.resolve(2),
        },
      }),
    }),
    listSessionsDependencies: (): ListSessionsDependencies => ({
      sessions: {
        listActiveForUser: () => Promise.resolve([
          {
            sessionId: "ses_1" as SessionId, createdAt: 1, lastSeenAt: 2,
            expiresAt: 3,
          },
          {
            sessionId: "ses_2" as SessionId, createdAt: 4, lastSeenAt: 5,
            expiresAt: 6,
          },
        ]),
      },
    }),
    revokeSessionDependencies: (): RevokeSessionDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      sessions: {
        revokeOwnedByUser(input) {
          if (options.revokeFound === false) return Promise.resolve(false);
          revoked.push(input.sessionId);
          return Promise.resolve(true);
        },
      },
    }),
    revokeOtherSessionsDependencies: (): RevokeOtherSessionsDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      sessions: {
        revokeAllForUserExcept() { revoked.push("others"); return Promise.resolve(3); },
      },
    }),
  });
  await app.ready();
  return { app, profileWrites, revoked, feedQueries, stateWrites, preferences };
}

const patch = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "PATCH", url, payload: payload as object });
const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

// ── /me ─────────────────────────────────────────────────────────────────────

const logoLookups: string[] = [];

const COMPLETION: ParticipantCompletionView = {
  verificationId: "LAGDA-VER-2026-AAAAAAAAAA",
  completedAt: 1_700_000_000_000,
  participants: 2,
  completed: 2,
  branding: { displayName: "Acme", primaryColor: "#112233", logo: { version: "d".repeat(64), width: 10, height: 5 } },
};

describe("participants' completed documents", () => {
  it("adds the completion and owner's branding to Signed by me", async () => {
    const { app } = await build({
      signedDocuments: [
        { signingRequestId: "sr_1", documentTitle: "Lease", senderName: "Paul", senderEmail: "p@example.com",
          workspaceName: "Acme", signedAt: 1_700_000_000_000,
          completion: { ...COMPLETION, signingRequestId: "sr_1" } as ParticipantCompletionView },
        { signingRequestId: "sr_2", documentTitle: "NDA", senderName: null, senderEmail: null,
          workspaceName: null, signedAt: 1_700_000_000_000, completion: null },
      ],
    });
    const response = await app.inject({ method: "GET", url: "/me/signed-documents" });
    expect(response.statusCode).toBe(200);
    const body: { items: { completion: unknown }[] } = response.json();
    const items = body.items;
    expect(items[0]?.completion).toEqual({ ...COMPLETION, completedAt: new Date(1_700_000_000_000).toISOString() });
    expect(items[1]?.completion).toBeNull();
    await app.close();
  });

  it("lists completed Others with their completion", async () => {
    const { app } = await build({
      completedOthers: [{
        signingRequestId: "sr_3", recipientId: "srr_3", documentTitle: "Memo", recipientType: "viewer",
        senderName: "Paul", senderEmail: "p@example.com", workspaceName: "Acme",
        invitedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000,
        completion: { ...COMPLETION, signingRequestId: "sr_3" } as ParticipantCompletionView,
      }],
    });
    const response = await app.inject({ method: "GET", url: "/me/other-documents/completed" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    const body: { items: { recipientType: string; completion: { verificationId: string } }[] } = response.json();
    const [item] = body.items;
    expect(item?.recipientType).toBe("viewer");
    expect(item?.completion.verificationId).toBe(COMPLETION.verificationId);
    await app.close();
  });

  it("refuses anonymous callers", async () => {
    const { app } = await build({ authenticated: false });
    for (const url of ["/me/other-documents/completed", "/me/participant-documents/LAGDA-VER-2026-AAAAAAAAAA/branding/logo"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    await app.close();
  });

  it("serves the participant's logo privately, and 404s without one", async () => {
    const { app } = await build({
      participantLogo: { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), digest: "d".repeat(64) },
    });
    const response = await app.inject({
      method: "GET", url: "/me/participant-documents/LAGDA-VER-2026-AAAAAAAAAA/branding/logo",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(logoLookups.at(-1)).toBe("LAGDA-VER-2026-AAAAAAAAAA");
    await app.close();

    const { app: bare } = await build();
    expect((await bare.inject({
      method: "GET", url: "/me/participant-documents/LAGDA-VER-2026-AAAAAAAAAA/branding/logo",
    })).statusCode).toBe(404);
    await bare.close();
  });
});

describe("GET /me", () => {
  it("returns the safe projection", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.statusCode).toBe(200);
    const body: CurrentUser = response.json();
    expect(body.email).toBe("Real.User@Example.com");
    expect(body.security.mfaEnabled).toBe(true);
    await app.close();
  });

  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    const response = await app.inject({ method: "GET", url: "/me" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a browser holding only a pre-auth credential", async () => {
    // `authenticatedUser` resolves a FULL session; a pre-auth cookie is not
    // one. A half-finished MFA ceremony has proved a password and nothing
    // more, and must not be able to read an account (§21, §158).
    const { app } = await build({ authenticated: false });
    const response = await app.inject({
      method: "GET", url: "/me",
      cookies: { lagda_pre_auth: "P".repeat(43) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("carries no credential or internal identity in the body", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.body).not.toContain(HASH);
    expect(response.body).not.toContain(NORMALIZED);
    expect(response.body).not.toMatch(
      /passwordHash|normalizedEmail|tokenDigest|csrf|secret|emailVerifiedAt/i);
    await app.close();
  });

  it("is never cacheable", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });
    // `no-store`, not `no-cache` — the latter lets a shared cache KEEP the
    // body and merely revalidate it (§127).
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("clears cookies when the session outlives the account", async () => {
    const { app } = await build({ userExists: false });
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.statusCode).toBe(401);
    // Not an empty profile. A blank user would let the frontend render a
    // logged-in shell for nobody (§227).
    expect(response.cookies.find(c => c.name === "lagda_session")?.value).toBe("");
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    expect(CurrentUserResponseSchema.additionalProperties).toBe(false);
    expect(Object.keys(CurrentUserResponseSchema.properties).sort())
      .toEqual([
        "avatar", "createdAt", "email", "emailVerified", "preferences", "profile",
        "security", "userId",
      ]);
  });
});

// ── Mass assignment ─────────────────────────────────────────────────────────

describe("PATCH /me/profile — mass assignment", () => {
  it("updates the allowed fields", async () => {
    const { app, profileWrites } = await build();
    const response = await patch(app, "/me/profile", {
      fullName: "Maria Reyes", jobTitle: "Notary",
    });
    expect(response.statusCode).toBe(200);
    expect(profileWrites).toHaveLength(1);
    await app.close();
  });

  it("REFUSES every security field", async () => {
    const { app, profileWrites } = await build();
    // Each of these is a real privilege-escalation attempt. The schema's
    // `additionalProperties: false` is what makes them 400s — Fastify would
    // otherwise strip them before the handler could observe anything.
    for (const attack of [
      { emailVerified: true },
      { email: "attacker@example.com" },
      { normalizedEmail: "attacker@example.com" },
      { password: "hunter2" },
      { passwordHash: "$argon2id$..." },
      { mfaEnabled: false },
      { mfaFactor: null },
      { role: "admin" },
      { isSystemAdmin: true },
      { workspaceId: "ws_1" },
      { workspaceRole: "owner" },
      { userId: "usr_2" },
      { sessionId: "ses_9" },
      { createdAt: 0 },
    ]) {
      const response = await patch(app, "/me/profile",
        { fullName: "Maria Reyes", ...attack });
      expect(response.statusCode).toBe(400);
    }
    // Not one reached the repository.
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("the request schema names exactly five fields", () => {
    expect(UpdateProfileRequestSchema.additionalProperties).toBe(false);
    expect(Object.keys(UpdateProfileRequestSchema.properties).sort())
      .toEqual([
        "department", "displayName", "fullName", "jobTitle",
        "preferredSenderName",
      ]);
  });

  it("refuses an anonymous caller without writing", async () => {
    const { app, profileWrites } = await build({ authenticated: false });
    const response = await patch(app, "/me/profile", { fullName: "Maria" });
    expect(response.statusCode).toBe(401);
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("takes no user id from the request — there is nowhere to put one", () => {
    // The strongest form of §168: with no `:userId` path segment and no
    // `userId` field, "user A edits user B" is not expressible, so there is no
    // authorization comparison that could be wrong.
    expect(Object.keys(UpdateProfileRequestSchema.properties))
      .not.toContain("userId");
  });
});

// ── Preferences ─────────────────────────────────────────────────────────────

describe("PATCH /me/preferences", () => {
  it("rejects a value outside the closed vocabulary", async () => {
    const { app, profileWrites } = await build();
    for (const bad of [
      { appearance: "neon" }, { dateFormat: "DD-MM-YY" },
      { timeFormat: "36h" }, { density: "roomy" },
    ]) {
      expect((await patch(app, "/me/preferences", bad)).statusCode).toBe(400);
    }
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("rejects security fields", async () => {
    const { app } = await build();
    expect((await patch(app, "/me/preferences",
      { appearance: "dark", mfaEnabled: false })).statusCode).toBe(400);
    await app.close();
  });
});

// ── Password ────────────────────────────────────────────────────────────────

describe("POST /me/password", () => {
  it("changes the password and reports the revoked count", async () => {
    const { app } = await build({ passwordOutcome: "changed" });
    const response = await post(app, "/me/password", {
      currentPassword: PASSWORD, newPassword: "a different passphrase",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "changed", otherSessionsRevoked: 2 });
    // The caller's own session survives — no cookie is issued and none cleared.
    expect(response.cookies.find(c => c.name === "lagda_session")).toBeUndefined();
    await app.close();
  });

  it("refuses a wrong current password with one safe code", async () => {
    const { app } = await build({ passwordOutcome: "invalid-current-password" });
    const response = await post(app, "/me/password", {
      currentPassword: "wrong", newPassword: "a different passphrase",
    });
    expect(response.statusCode).toBe(401);
    const body: { error: { code: string } } = response.json();
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("REQUIRES the current password", () => {
    // A session alone must not be enough. The schema makes that unskippable.
    expect(Object.keys(ChangePasswordRequestSchema.properties).sort())
      .toEqual(["currentPassword", "newPassword"]);
    expect(ChangePasswordRequestSchema.additionalProperties).toBe(false);
  });

  it("rejects a request with no current password", async () => {
    const { app } = await build();
    expect((await post(app, "/me/password",
      { newPassword: "a different passphrase" })).statusCode).toBe(400);
    await app.close();
  });

  it("never echoes a password or hash", async () => {
    for (const outcome of ["changed", "invalid-current-password"] as const) {
      const { app } = await build({ passwordOutcome: outcome });
      const response = await post(app, "/me/password", {
        currentPassword: PASSWORD, newPassword: "a different passphrase",
      });
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain("a different passphrase");
      expect(response.body).not.toContain(HASH);
      await app.close();
    }
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe("session management", () => {
  it("lists own sessions with no credentials", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me/sessions" });

    expect(response.statusCode).toBe(200);
    const body: { sessions: { isCurrent: boolean }[] } = response.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter(s => s.isCurrent)).toHaveLength(1);
    expect(response.body).not.toContain(SESSION_TOKEN);
    expect(response.body).not.toMatch(/tokenHash|token_hash|csrf|ipAddress|userAgent/i);
    await app.close();
  });

  it("revokes one session", async () => {
    const { app, revoked } = await build();
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_2" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 1, signedOut: false });
    expect(revoked).toEqual(["ses_2"]);
    await app.close();
  });

  it("clears cookies when the caller revokes their OWN session", async () => {
    const { app } = await build();
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_1" });

    const body: { signedOut: boolean } = response.json();
    expect(body.signedOut).toBe(true);
    expect(response.cookies.find(c => c.name === "lagda_session")?.value).toBe("");
    await app.close();
  });

  it("returns 404 for a session that is not the caller's", async () => {
    const { app } = await build({ revokeFound: false });
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_x" });
    // The same answer as "no such session". Separating them would make this an
    // oracle for which identifiers exist (§201).
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("revokes all others when no id is given", async () => {
    const { app, revoked } = await build();
    const response = await post(app, "/me/sessions/revoke", {});
    expect(response.json()).toEqual({ revoked: 3, signedOut: false });
    expect(revoked).toEqual(["others"]);
    await app.close();
  });

  it("rejects a userId in the revoke body", async () => {
    const { app } = await build();
    expect((await post(app, "/me/sessions/revoke",
      { sessionId: "ses_2", userId: "usr_2" })).statusCode).toBe(400);
    await app.close();
  });

  it("declares a CLOSED session projection", () => {
    const item = SessionListResponseSchema.properties.sessions.items as {
      additionalProperties?: boolean; properties: Record<string, unknown>;
    };
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort())
      .toEqual(["createdAt", "expiresAt", "isCurrent", "lastSeenAt", "sessionId"]);
  });
});

// ── /me/notifications ───────────────────────────────────────────────────────
//
// The feed's whole risk is disclosure: `notification_intents` holds sealed
// signing-link ciphertexts, and a SIGNING_INVITATION row belongs to a
// recipient in the other credential realm. These pin the two guards that keep
// those out — the scope handed to the repository, and the closed response
// schema.

describe("GET /me/notifications", () => {
  const ROW = {
    notificationIntentId: "nti_1",
    notificationType: "SIGNING_COMPLETED",
    workspaceId: "wsp_1",
    sourceKind: "SIGNING_REQUEST",
    sourceId: "sr_1",
    templateInput: { documentTitle: "Engagement Letter" },
    createdAt: new Date(1_700_000_000_000),
  };

  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    const res = await app.inject({ method: "GET", url: "/me/notifications" });
    expect(res.statusCode).toBe(401);
  });

  it("asks only for the authenticated caller's own rows", async () => {
    const { app, feedQueries } = await build({ notifications: [ROW] });
    await app.inject({ method: "GET", url: "/me/notifications" });
    // The route must never widen this: the repository's WHERE clause is the
    // authorization boundary, and it is only as good as the id passed in.
    expect(feedQueries).toEqual([{ userId: "usr_1", limit: 100, includeDismissed: false }]);
  });

  it("returns the projected notification", async () => {
    const { app } = await build({ notifications: [ROW] });
    const res = await app.inject({ method: "GET", url: "/me/notifications" });
    expect(res.statusCode).toBe(200);
    const body: { notifications: Record<string, unknown>[] } = res.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      id: "nti_1", type: "SIGNING_COMPLETED", workspaceId: "wsp_1",
    });
  });

  it("carries this account's read and dismissed state (090)", async () => {
    const { app } = await build({
      notifications: [
        ROW,
        { ...ROW, notificationIntentId: "nti_2", readAt: new Date(1_700_000_100_000) },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/me/notifications" });
    const body: { notifications: Record<string, unknown>[] } = res.json();
    expect(body.notifications[0]).toMatchObject({ id: "nti_1", read: false, readAt: null, dismissed: false });
    expect(body.notifications[1]).toMatchObject({
      id: "nti_2", read: true, readAt: new Date(1_700_000_100_000).toISOString(), dismissed: false,
    });
  });

  it("hides dismissed notices unless asked, and refuses an unknown query key", async () => {
    const { app, feedQueries } = await build({ notifications: [ROW] });
    await app.inject({ method: "GET", url: "/me/notifications?includeDismissed=true" });
    await app.inject({ method: "GET", url: "/me/notifications?includeDismissed=false" });
    expect(feedQueries.map(q => q.includeDismissed)).toEqual([true, false]);
    const bad = await app.inject({ method: "GET", url: "/me/notifications?userId=usr_2" });
    expect(bad.statusCode).toBe(400);
  });

  it("strips anything the schema does not name, including a sealed secret", async () => {
    // Simulates the failure this is here to catch: a later change makes the
    // repository select a credential column, and it reaches the route.
    const leaky = {
      ...ROW,
      sealedSecret: "SHOULD-NEVER-BE-SERIALIZED",
      sealedKeyVersion: "v1",
      challengeId: "chal_1",
    };
    const { app } = await build({ notifications: [leaky] });
    const res = await app.inject({ method: "GET", url: "/me/notifications" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SHOULD-NEVER-BE-SERIALIZED");
    expect(res.body).not.toContain("sealedKeyVersion");
    expect(res.body).not.toContain("challengeId");
  });
});

describe("POST /me/notifications/state (090)", () => {
  const post = (app: FastifyInstance, payload: unknown) =>
    app.inject({ method: "POST", url: "/me/notifications/state", payload: payload as object });

  it("refuses an anonymous caller", async () => {
    const { app, stateWrites } = await build({ authenticated: false });
    const res = await post(app, { ids: ["nti_1"], read: true });
    expect(res.statusCode).toBe(401);
    expect(stateWrites).toEqual([]);
  });

  it("refuses a failed CSRF check without writing", async () => {
    const { app, stateWrites } = await build({ csrfValid: false });
    const res = await post(app, { ids: ["nti_1"], read: true });
    expect(res.statusCode).toBe(403);
    expect(stateWrites).toEqual([]);
  });

  it("writes as the SESSION's user, only the flags given, and answers 204", async () => {
    const { app, stateWrites } = await build();
    const res = await post(app, { ids: ["nti_1", "nti_2"], read: true });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    const dismiss = await post(app, { ids: ["nti_1"], dismissed: true, read: false });
    expect(dismiss.statusCode).toBe(204);
    expect(stateWrites).toEqual([
      { userId: "usr_1", ids: ["nti_1", "nti_2"], change: { read: true } },
      { userId: "usr_1", ids: ["nti_1"], change: { read: false, dismissed: true } },
    ]);
  });

  it("refuses a change that names neither flag (422)", async () => {
    const { app, stateWrites } = await build();
    const res = await post(app, { ids: ["nti_1"] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "EMPTY_STATE_CHANGE" } });
    expect(stateWrites).toEqual([]);
  });

  it("bounds the body: 1-100 ids, closed, no user id expressible", async () => {
    const { app, stateWrites } = await build();
    expect((await post(app, { ids: [], read: true })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `nti_${i}`);
    expect((await post(app, { ids: tooMany, read: true })).statusCode).toBe(400);
    expect((await post(app, { ids: ["nti_1"], read: true, userId: "usr_2" })).statusCode).toBe(400);
    expect((await post(app, { ids: [""], read: true })).statusCode).toBe(400);
    expect(stateWrites).toEqual([]);
  });
});

// ── Profile photo (072) ─────────────────────────────────────────────────────

/** A real 1x1 PNG. The validator reads its header, so it must be genuine. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("profile photo", () => {
  it("stores a PNG, versions it on /me, and serves it back", async () => {
    avatarMap.clear();
    const { app } = await build();
    const put = await app.inject({ method: "PUT", url: "/me/avatar", payload: { image: PNG_1X1 } });
    expect(put.statusCode).toBe(200);
    const { version } = put.json<{ version: string }>();
    expect(version).toMatch(/^[a-f0-9]{64}$/);

    const me = (await app.inject({ method: "GET", url: "/me" })).json<{ avatar: { version: string } | null }>();
    expect(me.avatar).toEqual({ version });

    const img = await app.inject({ method: "GET", url: `/me/avatar?v=${version}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.rawPayload.equals(Buffer.from(PNG_1X1, "base64"))).toBe(true);
    await app.close();
  });

  it("refuses anything that is not a PNG — SVG above all", async () => {
    avatarMap.clear();
    const { app } = await build();
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64");
    const res = await app.inject({ method: "PUT", url: "/me/avatar", payload: { image: svg } });
    expect(res.statusCode).toBe(422);
    expect(avatarMap.size).toBe(0);
    await app.close();
  });

  it("refuses a write without a valid CSRF token", async () => {
    avatarMap.clear();
    const { app } = await build({ csrfValid: false });
    expect((await app.inject({ method: "PUT", url: "/me/avatar", payload: { image: PNG_1X1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/me/avatar" })).statusCode).toBe(403);
    expect(avatarMap.size).toBe(0);
    await app.close();
  });

  it("removes the photo, after which /me reports none", async () => {
    avatarMap.clear();
    const { app } = await build();
    await app.inject({ method: "PUT", url: "/me/avatar", payload: { image: PNG_1X1 } });
    expect((await app.inject({ method: "DELETE", url: "/me/avatar" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/me/avatar" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/me" })).json<{ avatar: unknown }>().avatar).toBeNull();
    await app.close();
  });

  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    expect((await app.inject({ method: "GET", url: "/me/avatar" })).statusCode).toBe(401);
    await app.close();
  });
});


// ── Notification preferences (084) ─────────────────────────────────────────

describe("/me/notification-preferences", () => {
  const ALL_ON = {
    signerActivity: true, requestCompleted: true, actionReminders: true,
    workspaceRequests: true, invitations: true,
  };

  it("reads as everything on, never changed, for an account with no row", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me/notification-preferences" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...ALL_ON, updatedAt: null });
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("changes only the named switches and returns the full set", async () => {
    const { app, preferences } = await build();
    const response = await patch(app, "/me/notification-preferences", { requestCompleted: false });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...ALL_ON, requestCompleted: false, updatedAt: 1_700_000_000_000 });
    // The SESSION's account, and only the key that was sent.
    expect(preferences.writes).toEqual([{ userId: "usr_1", patch: { requestCompleted: false } }]);

    const second = await patch(app, "/me/notification-preferences", { workspaceRequests: false });
    expect(second.json()).toMatchObject({ requestCompleted: false, workspaceRequests: false, invitations: true });
    const read = await app.inject({ method: "GET", url: "/me/notification-preferences" });
    expect(read.json()).toMatchObject({ requestCompleted: false, workspaceRequests: false });
    await app.close();
  });

  it("an empty change writes nothing", async () => {
    const { app, preferences } = await build();
    const response = await patch(app, "/me/notification-preferences", {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...ALL_ON, updatedAt: null });
    expect(preferences.writes).toHaveLength(0);
    await app.close();
  });

  it("refuses a key that is not a switch — security mail has none", async () => {
    const { app, preferences } = await build();
    for (const payload of [
      { passwordReset: false }, { signingInvitation: false }, { userId: "usr_2", invitations: false },
    ]) {
      expect((await patch(app, "/me/notification-preferences", payload)).statusCode).toBe(400);
    }
    expect((await patch(app, "/me/notification-preferences", { invitations: "nope" })).statusCode).toBe(400);
    expect(preferences.writes).toHaveLength(0);
    await app.close();
  });

  it("refuses a change without a valid CSRF token", async () => {
    const { app, preferences } = await build({ csrfValid: false });
    const response = await patch(app, "/me/notification-preferences", { invitations: false });
    expect(response.statusCode).toBe(403);
    expect(preferences.writes).toHaveLength(0);
    await app.close();
  });

  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    expect((await app.inject({ method: "GET", url: "/me/notification-preferences" })).statusCode).toBe(401);
    expect((await patch(app, "/me/notification-preferences", { invitations: false })).statusCode).toBe(401);
    await app.close();
  });
});
