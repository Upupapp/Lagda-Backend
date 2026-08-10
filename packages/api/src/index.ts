// @lagda/api — the HTTP adapter and composition root.
//
// Importing this module starts NOTHING. `startServer()` must be called
// explicitly, which is what makes the app factory testable and keeps a stray
// import from binding a port during a test run.

export { createApp, type CreateAppOptions } from "./app/create-app.js";
export type {
  AppDependencies, DatabaseHealth, WorkspaceDependencies,
} from "./app/dependencies.js";
export {
  loadApiConfig, ApiConfigError,
  type ApiConfig, type TrustProxySetting, type NodeEnvironment,
} from "./config/index.js";
export {
  startServer, createProductionDependencies, type StartedServer,
} from "./server/start-server.js";
export { createShutdown, type ShutdownTarget, type ShutdownOptions } from "./server/shutdown.js";
export {
  mapError, HttpError, badRequest, validationFailed, routeNotFound,
  payloadTooLarge, unsupportedMediaType, type MappedError,
} from "./errors/index.js";
export { toValidationDetails, toFieldPath } from "./errors/validation.js";
export {
  observeRequest, observeIp, observeUserAgent, generateRequestId,
  MAX_USER_AGENT_LENGTH,
  type ObservedRequestMetadata, type ObservedIpAddress, type IpProvenance,
} from "./context/index.js";
export {
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  sessionCookieOptions, csrfCookieOptions, clearCookieOptions, clearCsrfCookieOptions,
} from "./security/cookies.js";
export {
  createSecurityTokenGenerator, createSecurityTokenDigester,
  createIdempotencyKeyDigester, createIdempotencyRecordIdGenerator,
} from "./security/crypto.js";
export { sessionResolution, requireSession, type RequestAuth } from "./security/session-plugin.js";
export {
  applyIpRateLimit, checkSemanticLimits, createRateLimitScopeDigester,
  type RateLimitOptions,
} from "./security/rate-limit-plugin.js";
export {
  createArgon2PasswordHasher, describeHash, ARGON2_PARAMETERS,
  PasswordHasherConfigError, type PasswordHasherOptions,
} from "./security/password-hasher.js";
export {
  createVerificationTokenFactory, digestVerificationCode, digestSubmittedCode,
  canonicalizeVerificationCode, formatVerificationCode, buildVerificationUrl,
} from "./security/verification-token.js";
export {
  createResetTokenFactory, digestResetToken, digestSubmittedResetToken,
  isWellFormedResetToken, buildPasswordResetUrl,
} from "./security/reset-token.js";
export {
  createSecretBox, generateSecretBoxKey, SecretBoxError, type SecretBox,
  type SealedSecret,
} from "./security/secret-box.js";
export {
  generateTotpSecret, buildProvisioningUri, verifyTotp, timeStepFor,
  isWellFormedTotpCode, TOTP_PARAMETERS, type TotpSecret,
} from "./security/totp.js";
export {
  issueRecoveryCodes, digestRecoveryCode, digestSubmittedRecoveryCode,
  canonicalizeRecoveryCode, RECOVERY_CODE_COUNT,
} from "./security/recovery-codes.js";
export {
  createPreAuthCredentialFactory, digestPreAuthToken,
  digestSubmittedPreAuthToken, isWellFormedPreAuthToken,
} from "./security/pre-auth-token.js";
export {
  registerInvitationManagementRoutes, registerInvitationPreviewRoute,
  registerInvitationRedemptionRoutes,
  CreateInvitationRequestSchema, InvitationSummarySchema,
  InvitationListResponseSchema, InvitationPreviewResponseSchema,
  AcceptInvitationResponseSchema, InvitationTokenRequestSchema,
  type InvitationRouteOptions,
} from "./workspaces/invitation-routes.js";
export { createInvitationLinkBuilder } from "./workspaces/invitation-link.js";
export {
  registerMemberRoutes, ChangeMemberRoleRequestSchema, WorkspaceMemberSchema,
  MemberListResponseSchema, WorkspaceAccessResponseSchema,
  type MemberRouteOptions,
} from "./workspaces/member-routes.js";
export { createInvitationTokenFactory } from "./security/invitation-token.js";

export {
  registerWorkspaceRoutes, CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema, WorkspaceResponseSchema,
  WorkspaceListResponseSchema,
  type WorkspaceRouteOptions,
} from "./workspaces/workspace-routes.js";

export {
  registerAccountRoutes, CurrentUserResponseSchema, UpdateProfileRequestSchema,
  UpdatePreferencesRequestSchema, ChangePasswordRequestSchema,
  ChangePasswordResponseSchema, SessionListResponseSchema,
  RevokeSessionRequestSchema, RevokeSessionResponseSchema,
  type AccountRouteOptions,
} from "./account/account-routes.js";
export {
  registerMfaRoutes, VerifyMfaRequestSchema, VerifyMfaResponseSchema,
  EnrollMfaResponseSchema, ConfirmMfaRequestSchema, ConfirmMfaResponseSchema,
  DisableMfaRequestSchema, DisableMfaResponseSchema, type MfaRouteOptions,
} from "./auth/mfa-routes.js";
export {
  registerPasswordResetRoutes, ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema, ResetPasswordRequestSchema,
  ResetPasswordResponseSchema, type PasswordResetRouteOptions,
} from "./auth/password-reset-routes.js";
export {
  registerAuthRoutes, RegisterRequestSchema, RegisterResponseSchema,
  type RegisterRouteOptions,
} from "./auth/register-route.js";
export {
  registerSessionRoutes, SignInRequestSchema, SignInResponseSchema,
  type SessionRouteOptions,
} from "./auth/session-routes.js";
export {
  registerVerificationRoutes, VerifyEmailRequestSchema, VerifyEmailResponseSchema,
  ResendVerificationRequestSchema, ResendVerificationResponseSchema,
  type VerificationRouteOptions,
} from "./auth/verification-routes.js";
