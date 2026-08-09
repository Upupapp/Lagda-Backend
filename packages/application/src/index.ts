// @lagda/application — business orchestration.
//
// Depends on @lagda/core and @lagda/contracts. Never on Fastify, PostgreSQL,
// object storage, queues, PDF libraries or email vendors. See README.md.

export * from "./common/ports/index.js";
export * from "./common/errors/index.js";
export * from "./common/context.js";
export * from "./workspaces/index.js";

// Behavioural contract for repository adapters. Consumed by @lagda/db tests.
export * from "./test-support/repository-contract.js";

export * from "./common/ports/session.js";
export * from "./security/session-service.js";
export * from "./common/ports/idempotency.js";
export * from "./idempotency/canonical.js";
export * from "./idempotency/service.js";
export * from "./common/ports/rate-limit.js";
export * from "./rate-limit/policies.js";
export * from "./rate-limit/limiter.js";
export * from "./common/ports/jobs.js";
export * from "./jobs/definitions.js";
export * from "./common/ports/storage.js";
export * from "./common/ports/upload.js";
export * from "./upload/process-upload.js";
export * from "./common/ports/auth.js";
export * from "./auth/email-identity.js";
export * from "./auth/register-user.js";
export * from "./auth/login-user.js";
export * from "./auth/verify-email.js";
export * from "./auth/reset-password.js";
export * from "./auth/mfa.js";
export * from "./account/profile.js";
