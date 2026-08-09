// Maintenance handlers.
//
// Both are SYSTEM-scoped: idempotency records and rate-limit counters span
// workspace, user, recipient and IP scopes, so there is no workspace to act on
// behalf of. That is declared in the job definition, not inferred from a
// missing field.

import { Value } from "@sinclair/typebox/value";
import {
  CleanupPayloadSchema, TerminalJobError,
  type CleanupPayload, type IdempotencyRepository,
  type RateLimitCounterRepository, type SystemJobContext,
} from "@lagda/application";
import type { Clock } from "@lagda/application";

/**
 * Validates a queue payload at runtime.
 *
 * The queue is NOT trusted because LAGDA wrote to it. It holds rows written by
 * a previous deployment, and possibly rows written by an operator by hand. A
 * malformed payload is TERMINAL — retrying identical bad input three times only
 * delays the dead-letter signal that tells someone what is wrong.
 */
export function parseCleanupPayload(raw: unknown): CleanupPayload {
  if (!Value.Check(CleanupPayloadSchema, raw)) {
    throw new TerminalJobError("Cleanup job payload failed validation.");
  }
  return raw;
}

export interface CleanupDependencies {
  readonly idempotency: IdempotencyRepository;
  readonly rateLimits: RateLimitCounterRepository;
  readonly clock: Clock;
}

export interface CleanupOutcome {
  readonly deleted: number;
}

/**
 * Deletes idempotency records past their retention.
 *
 * The horizon is read from the clock HERE, at execution time, not baked in at
 * enqueue — a job delayed by an outage must not delete using a stale cutoff.
 */
export async function handleIdempotencyCleanup(
  raw: unknown,
  _context: SystemJobContext,
  deps: CleanupDependencies,
): Promise<CleanupOutcome> {
  const payload = parseCleanupPayload(raw);
  // Bounded. A sweep that deleted every expired row in one statement would
  // hold locks on a table the request path writes to.
  const deleted = await deps.idempotency.deleteExpired(deps.clock.now(), payload.batchSize);
  return { deleted };
}

/**
 * Deletes rate-limit counters whose window has fully lapsed.
 *
 * Only rows past `expires_at`, which is a full window past their reset.
 * Deleting a live counter would reset an attacker's attempt count — the
 * predicate is the security property, not the batching.
 */
export async function handleRateLimitCleanup(
  raw: unknown,
  _context: SystemJobContext,
  deps: CleanupDependencies,
): Promise<CleanupOutcome> {
  const payload = parseCleanupPayload(raw);
  const deleted = await deps.rateLimits.deleteExpired(deps.clock.now(), payload.batchSize);
  return { deleted };
}
