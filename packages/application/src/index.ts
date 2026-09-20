// @lagda/application — business orchestration.
//
// Depends on @lagda/core and @lagda/contracts. Never on Fastify, PostgreSQL,
// object storage, queues, PDF libraries or email vendors. See README.md.

export * from "./common/ports/index.js";
export * from "./common/errors/index.js";
export * from "./common/context.js";
export * from "./workspaces/index.js";
export * from "./signing-account-link/index.js";

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
export * from "./contacts/contacts.js";
export * from "./documents/documents.js";
export * from "./documents/document-content.js";
export * from "./folders/folders.js";
export * from "./preparation/preparation.js";
export * from "./recipients/recipients.js";
export * from "./signing-requests/signing-requests.js";
export * from "./signing-requests/expiry.js";
export * from "./signing-requests/readiness.js";
export * from "./signing-requests/send.js";
export * from "./signing-requests/completed-artifact.js";
export * from "./signing-requests/signatures.js";
export * from "./signing-access/signing-access.js";
export * from "./signing-ceremony/signing-ceremony.js";
export * from "./signing-submission/signing-submission.js";
export * from "./signing-workflow/signing-workflow.js";
export * from "./completion/completion.js";
// Phase 1-B (BACKEND-38/41). Previously unexported — nothing outside this
// package's own tests ever consumed them, because nothing composed
// `CompletionStepRunners` in production. The worker's completion composition
// is the first real consumer.
export * from "./completion/field-merge.js";
export * from "./completion/certificate-step.js";
export * from "./completion/final-seal.js";
export * from "./completion/database-failure.js";
export * from "./completion/retry-sweep.js";
export * from "./verification/public-verification.js";
// BACKEND-43. The ONE way to construct an evidence event: producers call a
// factory rather than building a literal, so type, version, source and actor
// cannot drift apart.
export * from "./evidence/events.js";
// BACKEND-43. The private audit trail projection — computed at read time
// from evidence events, never materialized and never from logs.
export * from "./audit/audit-trail.js";
export * from "./notifications/index.js";
export * from "./organization/index.js";
export * from "./observability/metrics.js";
