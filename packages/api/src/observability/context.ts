// Observability context.
//
// ── The §37 decision: USE AsyncLocalStorage, for observability only ──────────
//
// The alternative is threading a logger through every application signature.
// That was rejected for a specific reason, not a stylistic one: it would put a
// Pino type in `@lagda/application`, and a use case that takes a logger cannot
// be called by the worker without one. The application layer must stay
// provider-independent (INV-134).
//
// ── The constraint that makes this safe ─────────────────────────────────────
//
// This store is for LOGGING. It is never the source of authorization or tenancy.
//
// `workspaceId` here exists so a log line can say which tenant a request
// concerned. Data access still takes its workspace from the unit of work, which
// binds scope rather than accepting it (INV-063), and RLS still reads the
// transaction-local setting. If this store vanished, no query would change
// behaviour and no permission would change answer — only the logs would get
// less useful. That is the test of whether an ambient value is safe.
//
// An architecture test asserts no repository or transaction code reads it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestId } from "@lagda/contracts";

/**
 * Which process produced a log line. Bounded, and safe as a metric label.
 *
 * `migration` is included because the migration runner is a real process role
 * that currently writes unstructured `console.info` output.
 */
export type ProcessRole = "api" | "worker" | "migration" | "test";

export interface ObservabilityContext {
  readonly requestId?: RequestId;
  /**
   * For CORRELATION ONLY. Never read to decide what data may be accessed.
   */
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly actorType?: "workspace-user" | "recipient" | "system";
  /** A stable use-case name — `SubmitSignature`, not a route URL. */
  readonly operation?: string;
  /** Set once a job system exists (BACKEND-16). */
  readonly jobId?: string;
  readonly attempt?: number;
}

const storage = new AsyncLocalStorage<ObservabilityContext>();

/** The current context, or an empty object outside any tracked execution. */
export function currentContext(): ObservabilityContext {
  return storage.getStore() ?? {};
}

/**
 * Runs `operation` with `context` in scope.
 *
 * Replaces rather than mutates. A shared mutable object would leak one request's
 * workspace into another's log line under concurrency — the failure this whole
 * module exists to avoid, and the one a test has to prove does not happen.
 */
export function withContext<T>(context: ObservabilityContext, operation: () => T): T {
  return storage.run(Object.freeze({ ...context }), operation);
}

/**
 * Runs with the current context EXTENDED.
 *
 * Used when a later stage learns something the first did not — an authenticated
 * actor resolved after the request started. The parent's context is unaffected,
 * so enrichment inside a nested call cannot escape upward.
 */
export function withAddedContext<T>(
  additions: ObservabilityContext,
  operation: () => T,
): T {
  return withContext({ ...currentContext(), ...additions }, operation);
}
