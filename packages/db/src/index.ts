// @lagda/db — PostgreSQL persistence.
//
// Infrastructure only. DO NOT import this package from @lagda/core or
// @lagda/application — it IMPLEMENTS their ports, and importing it from either
// inverts the architecture. Composition roots (api, worker) wire it up.

export { loadDatabaseConfig, describeDatabase, DatabaseConfigError } from "./config/index.js";
export type { DatabaseConfig } from "./config/index.js";

export { createDatabase } from "./client/index.js";
export type { LagdaDatabase } from "./client/index.js";

export { migrateToLatest, migrationStatus, migrateDown } from "./migrations/runner.js";
export type { MigrationOutcome, MigrationStatus } from "./migrations/runner.js";

export { createTransactionManager } from "./transactions/index.js";

export {
  createWorkspaceRepository, createWorkspaceMembershipRepository,
} from "./repositories/workspaces.js";

export { PersistenceMappingError } from "./mapping/index.js";
export { isUniqueViolation, isForeignKeyViolation, isCheckViolation } from "./errors.js";
