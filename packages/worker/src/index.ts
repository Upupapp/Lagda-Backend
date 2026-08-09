// @lagda/worker — the background job process.
//
// Importing this module starts NOTHING. `startWorker()` must be called
// explicitly, so a stray import never opens a queue connection or registers a
// consumer.

export { startWorker, type StartedWorker } from "./server/start-worker.js";
export { loadWorkerConfig, WorkerConfigError, type WorkerConfig } from "./config/index.js";
export { createJobScheduler } from "./queue/scheduler.js";
export {
  handleIdempotencyCleanup, handleRateLimitCleanup, parseCleanupPayload,
  type CleanupDependencies, type CleanupOutcome,
} from "./handlers/cleanup.js";
