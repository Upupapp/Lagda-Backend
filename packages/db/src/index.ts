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

export { migrateToLatest, migrationStatus, migrateDown } from "./migrations/runner.js";
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
export { createTestDatabase, hasIntegrationDatabase, truncateAll } from "./testing/harness.js";
export {
  createUploadRepository, createQuarantineCleanupLookup,
} from "./repositories/uploads.js";
export {
  createUserRepository, createVerificationChallengeRepository,
} from "./repositories/users.js";
export {
  createVerificationRepository, createVerifiableUserRepository,
} from "./repositories/verification.js";
