// The identity surface: registration, sessions, verification, recovery, MFA,
// account.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// Six registrars were written, exported, and referenced by nothing. The
// integration sweep found the consequence: 38 published paths, all of which
// assume a session, and no route anywhere that can issue one.
//
// Nothing was lying. `createApp` mounts a group only when its dependency is
// supplied — the design that stops an unwired route from looking mounted — and
// it behaved exactly as intended. The gap was that nobody ever supplied these.
//
// So they are grouped and mounted together, present-or-absent AS A WHOLE. That
// is the same shape invitations and members use, and here it matters more:
// registration without sessions is an account nobody can use, and sessions
// without recovery is an account nobody can get back into. A per-route flag
// would make each of those independently reachable, and each of them is a
// half-built product rather than a configuration.
//
// ── Paths are constants, not configuration ────────────────────────────────
//
// A deployment does not get to choose where sign-in lives. These strings are
// part of the published contract, they are baked into a generated client, and a
// configurable one would let two environments disagree about the API they
// claim to implement.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UserId } from "@lagda/contracts";
import type { SessionId } from "@lagda/application";
import type {
  RegisterUserDependencies, LoginDependencies,
  VerifyEmailDependencies, ResendVerificationDependencies,
  FinalizeExternalEmailVerificationDependencies,
  RequestPasswordResetDependencies, ResetPasswordDependencies,
  CompleteMfaDependencies, BeginEnrolmentDependencies,
  ConfirmEnrolmentDependencies, DisableMfaDependencies,
  GetCurrentUserDependencies, UpdateProfileDependencies,
  UpdatePreferencesDependencies, ChangePasswordDependencies,
  ListSessionsDependencies, RevokeSessionDependencies,
  RevokeOtherSessionsDependencies,
} from "@lagda/application";
import type { UserSignatureRepository, NotificationFeedRepository } from "@lagda/db";
import type {
  SignatureImageValidator, SigningInboxItemView, SignedDocumentView,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import { registerAuthRoutes } from "../auth/register-route.js";
import { registerSessionRoutes } from "../auth/session-routes.js";
import { registerVerificationRoutes } from "../auth/verification-routes.js";
import { registerPasswordResetRoutes } from "../auth/password-reset-routes.js";
import { registerMfaRoutes } from "../auth/mfa-routes.js";
import { registerAccountRoutes } from "../account/account-routes.js";

/** The published identity paths. Contract, not configuration. */
export const IDENTITY_PATHS = {
  register: "/auth/register",
  signIn: "/auth/sessions",
  signOut: "/auth/sessions/current",
  verifyEmail: "/auth/email-verifications",
  resendVerification: "/auth/email-verifications/resend",
  /** Firebase-provider mode only — see verification-routes.ts. */
  firebaseFinalizeVerification: "/auth/email-verifications/firebase-finalize",
  forgotPassword: "/auth/password-resets",
  resetPassword: "/auth/password-resets/complete",
  mfaVerify: "/auth/mfa/verifications",
  mfaEnroll: "/auth/mfa/enrolments",
  mfaConfirm: "/auth/mfa/enrolments/confirm",
  mfaDisable: "/auth/mfa/enrolments/current",
} as const;

/**
 * Account routes that take a credential, and therefore need a rate limit.
 *
 * Not `IDENTITY_PATHS`, which is the `/auth/*` contract and asserted to be
 * nothing else. These live under `/me` and are registered by
 * `account-routes.ts`; listing them here is what puts them in the rate-limit
 * completeness gate. `/me/password` accepts the current password and had no
 * limit at all before it was listed.
 */
export const ACCOUNT_RATE_LIMITED_PATHS = {
  changePassword: "/me/password",
} as const;

/**
 * Everything the identity surface needs.
 *
 * Factories throughout, so a route holds no repository, no hasher and no
 * database handle of its own — it cannot query or hash even by accident.
 */
export interface IdentityDependencies {
  readonly register: () => RegisterUserDependencies;
  readonly login: () => LoginDependencies;
  readonly verifyEmail: () => VerifyEmailDependencies;
  readonly resendVerification: () => ResendVerificationDependencies;
  readonly requestPasswordReset: () => RequestPasswordResetDependencies;
  readonly resetPassword: () => ResetPasswordDependencies;
  readonly completeMfa: () => CompleteMfaDependencies;
  readonly beginEnrolment: () => BeginEnrolmentDependencies;
  readonly confirmEnrolment: () => ConfirmEnrolmentDependencies;
  readonly disableMfa: () => DisableMfaDependencies;
  readonly currentUser: () => GetCurrentUserDependencies;
  readonly updateProfile: () => UpdateProfileDependencies;
  readonly updatePreferences: () => UpdatePreferencesDependencies;
  readonly changePassword: () => ChangePasswordDependencies;
  readonly listSessions: () => ListSessionsDependencies;
  readonly revokeSession: () => RevokeSessionDependencies;
  readonly revokeOtherSessions: () => RevokeOtherSessionsDependencies;

  /** Ends one session by id. Used by sign-out. */
  readonly endSession: (sessionId: string) => Promise<void>;
  /**
   * Issues the FULL session after both factors succeed.
   *
   * A separate capability rather than something the MFA use case does, so "no
   * session before MFA" is checkable in one place.
   */
  readonly issueSession: (userId: UserId) => Promise<{
    readonly sessionToken: string;
    readonly csrfToken: string;
    readonly expiresAt: number;
  }>;
  /** Validates double-submit CSRF for an authenticated request. See sign-out. */
  readonly validateCsrf: (request: FastifyRequest) => boolean;
  readonly signatures: () => UserSignatureRepository;
  /** The caller's own notification feed. See migration 030. */
  readonly notificationFeed: () => NotificationFeedRepository;
  readonly claimSigningLink: (
    userId: UserId, code: string, currentPassword: string,
  ) => Promise<{
    signingRequestId: string; recipientId: string; preparedCount: number;
  }>;
  readonly signatureImages: () => SignatureImageValidator;
  /** "Documents I must sign" (migration 056), read by the caller's own id. */
  readonly listDocumentsToSign: (userId: UserId) => Promise<readonly SigningInboxItemView[]>;
  /** "Signed by me" (migration 055), read by the caller's own id. */
  readonly listSignedDocuments: (userId: UserId) => Promise<readonly SignedDocumentView[]>;
  /** The second verification before continuing to sign from the app. */
  readonly beginInAppSigning: (
    userId: UserId,
    input: { signingRequestId: string; recipientId: string; password: string },
  ) => Promise<{ code: string; expiresAt: number }>;
  readonly now: () => Date;
  /** Resolves a FULL session. Null for anonymous and for pre-auth credentials. */
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  /** Delivers the verification link created by registration. Default-provider
   *  mode only — mutually exclusive with issueFirebaseVerificationHandoff below. */
  readonly deliverVerification?: (input: {
    readonly email: string;
    readonly rawToken: string;
    readonly expiresAt: number;
  }) => Promise<void>;
  /**
   * Firebase-provider mode only (EMAIL_VERIFICATION_PROVIDER=firebase). Same
   * function used by both register and resend — see register-route.ts's
   * option of the same name for the full contract.
   */
  readonly issueFirebaseVerificationHandoff?: (input: {
    readonly userId: string;
    readonly email: string;
  }) => Promise<{ readonly customToken: string } | null>;
  /** Firebase-provider mode only. */
  readonly firebaseFinalizeVerification?: () => FinalizeExternalEmailVerificationDependencies;
}

/**
 * Mounts all six groups on the ROOT instance.
 *
 * Outside the authenticated scope, and that is not an oversight: every route
 * here is either reached without a session or issues the session itself.
 * Registering them inside the scope would make `requireSession` reject the
 * caller before sign-in could run — the scope would refuse everyone who has
 * not yet done the thing the scope exists to require.
 *
 * The account and MFA-settings routes DO need a full session, and they get it
 * from `authenticatedUser` rather than from placement, because they sit beside
 * routes that must stay anonymous.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  deps: IdentityDependencies,
): void {
  registerAuthRoutes(app, {
    path: IDENTITY_PATHS.register,
    dependencies: deps.register,
    ...(deps.deliverVerification === undefined
      ? {}
      : { deliverVerification: deps.deliverVerification }),
    ...(deps.issueFirebaseVerificationHandoff === undefined
      ? {}
      : { issueFirebaseVerificationHandoff: deps.issueFirebaseVerificationHandoff }),
  });

  registerSessionRoutes(app, {
    signInPath: IDENTITY_PATHS.signIn,
    signOutPath: IDENTITY_PATHS.signOut,
    config,
    dependencies: deps.login,
    revokeSession: deps.endSession,
    validateCsrf: deps.validateCsrf,
  });

  registerVerificationRoutes(app, {
    verifyPath: IDENTITY_PATHS.verifyEmail,
    resendPath: IDENTITY_PATHS.resendVerification,
    verifyDependencies: deps.verifyEmail,
    resendDependencies: deps.resendVerification,
    ...(deps.issueFirebaseVerificationHandoff === undefined
      ? {}
      : { issueFirebaseVerificationHandoff: deps.issueFirebaseVerificationHandoff }),
    ...(deps.firebaseFinalizeVerification === undefined
      ? {}
      : {
        firebaseFinalizePath: IDENTITY_PATHS.firebaseFinalizeVerification,
        firebaseFinalizeDependencies: deps.firebaseFinalizeVerification,
      }),
  });

  registerPasswordResetRoutes(app, {
    forgotPath: IDENTITY_PATHS.forgotPassword,
    resetPath: IDENTITY_PATHS.resetPassword,
    config,
    requestDependencies: deps.requestPasswordReset,
    resetDependencies: deps.resetPassword,
  });

  registerMfaRoutes(app, {
    verifyPath: IDENTITY_PATHS.mfaVerify,
    enrollPath: IDENTITY_PATHS.mfaEnroll,
    confirmPath: IDENTITY_PATHS.mfaConfirm,
    disablePath: IDENTITY_PATHS.mfaDisable,
    config,
    verifyDependencies: deps.completeMfa,
    enrollDependencies: deps.beginEnrolment,
    confirmDependencies: deps.confirmEnrolment,
    disableDependencies: deps.disableMfa,
    issueSession: deps.issueSession,
    // MFA settings need a FULL session and must never accept a pre-auth
    // credential: enrolling or disabling a factor mid-ceremony would let a
    // password alone change the account's security configuration.
    authenticatedUser: async request =>
      (await deps.authenticatedUser(request))?.userId ?? null,
    validateCsrf: deps.validateCsrf,
  });

  registerAccountRoutes(app, {
    config,
    authenticatedUser: deps.authenticatedUser,
    // `/me` sits outside the authenticated scope, so `requireSession`'s CSRF
    // hook never runs here. Every state-changing `/me` route asks for it
    // explicitly instead.
    validateCsrf: deps.validateCsrf,
    signatures: deps.signatures,
    notificationFeed: deps.notificationFeed,
    claimSigningLink: deps.claimSigningLink,
    listDocumentsToSign: deps.listDocumentsToSign,
    listSignedDocuments: deps.listSignedDocuments,
    beginInAppSigning: deps.beginInAppSigning,
    signatureImages: deps.signatureImages,
    now: deps.now,
    currentUserDependencies: deps.currentUser,
    updateProfileDependencies: deps.updateProfile,
    updatePreferencesDependencies: deps.updatePreferences,
    changePasswordDependencies: deps.changePassword,
    listSessionsDependencies: deps.listSessions,
    revokeSessionDependencies: deps.revokeSession,
    revokeOtherSessionsDependencies: deps.revokeOtherSessions,
  });
}
