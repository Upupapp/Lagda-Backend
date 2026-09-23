// @lagda/db — PostgreSQL persistence.
//
// Infrastructure only. DO NOT import this package from @lagda/core or
// @lagda/application — it IMPLEMENTS their ports, and importing it from either
// inverts the architecture. Composition roots (api, worker) wire it up.
//
// Repository implementations are deliberately NOT exported. They are built by
// the unit of work, which is what guarantees they share one transaction and one
// workspace. An independently constructed repository could hold the pool.

export { loadDatabaseConfig, describeDatabase, DatabaseConfigError } from "./config/index.js";
export type { DatabaseConfig } from "./config/index.js";

export { createDatabase } from "./client/index.js";
export type { LagdaDatabase } from "./client/index.js";

export {
  migrateToLatest, migrationStatus, migrateDown, hasCurrentSchema,
} from "./migrations/runner.js";
export type { MigrationOutcome, MigrationStatus } from "./migrations/runner.js";

export { createTransactionManager } from "./transactions/index.js";

export { PersistenceMappingError } from "./mapping/index.js";

export {
  PersistenceError,
  UniqueConstraintViolation, ForeignKeyConstraintViolation,
  CheckConstraintViolation, TransientPersistenceConflict,
  WorkspaceScopeMismatchError,
  isUniqueViolation, isForeignKeyViolation, isCheckViolation, isTransientConflict,
  translatePersistenceError,
} from "./errors.js";

export { createSessionRepository } from "./repositories/session.js";
export { createIdempotencyRepository } from "./repositories/idempotency.js";
export { createRateLimitCounterRepository } from "./repositories/rate-limit.js";
export type { Database } from "./schema/index.js";
export {
  createTestDatabase, hasIntegrationDatabase, truncateAll, truncateAccounts, seedUser,
  withRawTenantTransaction, withRawGlobalTransaction,
} from "./testing/harness.js";
export {
  createUploadRepository, createQuarantineCleanupLookup,
} from "./repositories/uploads.js";
export {
  createUserRepository, createVerificationChallengeRepository,
  createAccountContactRepository,
} from "./repositories/users.js";
// The anonymous verification read. Exported for the same reason the others
// above are: it belongs to no workspace, so no unit of work can own it. It
// takes a transaction RUNNER rather than a pool, so an independently
// constructed instance cannot hold a connection -- which is the risk the note
// at the top of this file is about.
export { createPublicVerificationLookup } from "./repositories/evidence.js";
export {
  createVerificationRepository, createVerifiableUserRepository,
} from "./repositories/verification.js";
export {
  createPasswordResetRepository, createPasswordResettableUserRepository,
  createUserAdopter,
} from "./repositories/password-reset.js";
export {
  createMfaFactorRepository, createRecoveryCodeRepository,
  createPendingAuthenticationRepository,
} from "./repositories/mfa.js";
export {
  createAccountProfileRepository, createAccountCredentialRepository,
  createAccountSessionRepository,
} from "./repositories/account.js";
export {
  createUserSigningRecordsRepository, createSigningResumeIntentRepository,
} from "./repositories/user-signing-records.js";
export { createScopedWorkflowTemplateRepository } from "./repositories/workflow-templates.js";
export {
  createPreparedSignatureRepository,
  type PreparedSignatureRepository, type PreparedSignature,
  type PrepareSignatureInput,
} from "./repositories/prepared-signatures.js";
export {
  createSigningAccountLinkRepository,
  type SigningAccountLinkRepository, type SigningLinkIntentRecord,
  type SigningAccountLinkRecord, type CreateSigningLinkIntentInput,
  type CreateSigningAccountLinkInput,
} from "./repositories/signing-account-links.js";
export {
  createUserSignatureRepository,
  type UserSignatureRepository, type SavedSignature,
  type SaveSignatureInput, type UserSignaturePurpose,
} from "./repositories/user-signatures.js";
export {
  createNotificationFeedRepository,
  type NotificationFeedRepository, type FeedNotification,
  type FeedNotificationType,
} from "./repositories/notification-feed.js";
