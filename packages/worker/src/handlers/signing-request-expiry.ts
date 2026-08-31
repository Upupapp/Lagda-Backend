// The expiry sweep, as a job (BACKEND-46).
//
// SYSTEM-scoped, and it has to be: a deadline passes with nobody watching, so
// there is no workspace on whose behalf this runs. Declared in the job
// definition rather than inferred from a missing field.
//
// The handler is thin on purpose. Finding due requests, entering each
// workspace and applying the transition are the USE CASE's decisions --
// `expireDueSigningRequests` -- so the same behaviour is reachable from a test,
// a script or a future operator endpoint without going through a queue.

import { Value } from "@sinclair/typebox/value";
import {
  CleanupPayloadSchema, TerminalJobError, expireDueSigningRequests,
  type CleanupPayload, type ExpirySweepDependencies, type ExpirySweepResult,
  type SystemJobContext,
} from "@lagda/application";

/**
 * Validates a queue payload at runtime.
 *
 * The queue is NOT trusted because LAGDA wrote to it: it holds rows written by
 * a previous deployment, and possibly rows written by an operator by hand. A
 * malformed payload is TERMINAL, because retrying identical bad input only
 * delays the dead-letter signal that tells someone what is wrong.
 */
export function parseExpiryPayload(raw: unknown): CleanupPayload {
  if (!Value.Check(CleanupPayloadSchema, raw)) {
    throw new TerminalJobError("Signing request expiry payload failed validation.");
  }
  return raw;
}

export type SigningRequestExpiryDependencies =
  Omit<ExpirySweepDependencies, "policy">;

/**
 * Expires every signing request whose deadline has passed.
 *
 * The batch size comes from the PAYLOAD, and the instant from the clock at
 * EXECUTION time -- never baked in at enqueue. A job delayed by an outage must
 * expire against the time it actually ran, not against the time somebody meant
 * to run it.
 */
export async function handleSigningRequestExpiry(
  raw: unknown,
  _context: SystemJobContext,
  deps: SigningRequestExpiryDependencies,
): Promise<ExpirySweepResult> {
  const payload = parseExpiryPayload(raw);
  return expireDueSigningRequests({
    ...deps,
    policy: { batchSize: payload.batchSize },
  });
}
