// Idempotent execution.
//
// ── The guarantee, and exactly where it comes from ─────────────────────────
//
// The claim row is inserted INSIDE the caller's business transaction. That one
// decision provides three properties without any additional machinery:
//
//   Concurrent duplicates  PostgreSQL blocks the second INSERT on the unique
//                          index until the first transaction resolves.
//   Rollback               The claim disappears with the failed mutation. No
//                          poisoned key, and a retry can execute.
//   Crash                  Nothing committed, so no stale IN_PROGRESS row
//                          survives. No lease, no reclaim, no recovery job.
//
// It works only for mutations contained in one PostgreSQL transaction. An
// operation that seals a PDF or calls an email provider must not hold a
// transaction open across that work — those need staged durable state
// (BACKEND-33/38), and that limit is stated rather than hidden.

import type { IdempotencyKey } from "@lagda/contracts";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "@lagda/contracts";
import type {
  ClaimOutcome, IdempotencyKeyDigester, IdempotencyRecordIdGenerator,
  IdempotencyRepository, IdempotencyScope, IdempotentOperation, StoredResult,
} from "../common/ports/idempotency.js";
import type { Clock } from "../common/ports/index.js";
import { ApplicationError } from "../common/errors/index.js";
import { canonicalRequest } from "./canonical.js";

// ── Errors ───────────────────────────────────────────────────────────────────

export class IdempotencyKeyRequiredError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "idempotency_key_required";
  constructor() {
    super("This operation requires an Idempotency-Key header.");
  }
}

export class IdempotencyKeyInvalidError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "idempotency_key_invalid";
  constructor(reason: string) {
    // Names the RULE, never the submitted key — echoing it would put a
    // client-supplied string into logs and error reporting.
    super(`The Idempotency-Key header is not valid: ${reason}`);
  }
}

/** The same key, previously used for a materially different request. */
export class IdempotencyConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "idempotency_key_reused";
  constructor() {
    // Deliberately says nothing about the original: not its body, not its
    // fingerprint, not its result. A caller learning what the first request
    // contained would be an information leak through a retry mechanism.
    super("This idempotency key was already used with a different request.");
  }
}

/** The same operation is executing right now, in another transaction. */
export class IdempotencyInProgressError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "idempotency_in_progress";
  constructor() {
    super("This operation is already in progress. Retry shortly.");
  }
}

// ── Key validation ───────────────────────────────────────────────────────────

/**
 * Long enough to be unguessable-by-accident, short enough not to be a payload.
 *
 * A one-character key is almost certainly a bug — a client that sends `"1"` has
 * not generated a key per operation — and colliding within a scope would make
 * two genuinely different operations look like retries of each other.
 */
const MIN_KEY_LENGTH = 8;

/**
 * Printable ASCII, no whitespace or control characters.
 *
 * Control characters in a header value invite ambiguity in logs and in any
 * downstream system that parses them. Wide enough for UUIDs, base64url and
 * ULIDs, which is every form a client is likely to produce.
 */
const KEY_PATTERN = /^[A-Za-z0-9._~:@/+=-]+$/;

export function assertValidKey(raw: string | undefined): IdempotencyKey {
  if (raw === undefined || raw === "") throw new IdempotencyKeyRequiredError();
  if (raw.length < MIN_KEY_LENGTH) {
    throw new IdempotencyKeyInvalidError(`it must be at least ${String(MIN_KEY_LENGTH)} characters`);
  }
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyInvalidError(
      `it must be at most ${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters`);
  }
  if (!KEY_PATTERN.test(raw)) {
    throw new IdempotencyKeyInvalidError("it contains unsupported characters");
  }
  return raw as IdempotencyKey;
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface IdempotencyPolicy {
  /**
   * How long a completed record is replayable.
   *
   * OPERATIONAL, and unrelated to evidence or document retention. It bounds
   * client retries, not legal history. After it lapses the same key is a new
   * operation — this framework does not promise permanent deduplication.
   */
  readonly retentionMs: number;
}

export interface IdempotentExecutionInput {
  readonly key: IdempotencyKey;
  readonly operation: IdempotentOperation;
  /** Derived from TRUSTED context — a resolved actor or authorized workspace. */
  readonly scope: IdempotencyScope;
  /**
   * The logical request, AFTER schema validation and normalization.
   *
   * Must exclude the session token, the CSRF token, the request ID, the IP and
   * the user-agent. A session rotation between retries must not make the second
   * attempt look like a different business request.
   */
  readonly request: unknown;
  /** Runs only when this call owns the claim. Returns the replayable result. */
  readonly execute: () => Promise<{ statusCode: number; body: unknown }>;
}

export interface IdempotencyDependencies {
  readonly repository: IdempotencyRepository;
  readonly digester: IdempotencyKeyDigester;
  readonly ids: IdempotencyRecordIdGenerator;
  readonly clock: Clock;
  readonly policy: IdempotencyPolicy;
}

export interface ExecutionOutcome {
  readonly statusCode: number;
  readonly body: unknown;
  /** True when the result came from storage. Surfaced as a header, never in the body. */
  readonly replayed: boolean;
}

/**
 * Bounded replay body.
 *
 * A result that does not fit belongs in storage with a reference, not in this
 * table. Failing loudly beats letting one operation store megabytes that every
 * retry then reads.
 */
const MAX_RESULT_BYTES = 64 * 1024;

export function createIdempotencyService(deps: IdempotencyDependencies) {
  const { repository, digester, ids, clock, policy } = deps;

  return {
    /**
     * Executes an operation at most once per identity.
     *
     * **Must be called inside the business transaction.** The repository writes
     * through that transaction, which is what makes the claim and the mutation
     * commit or roll back together.
     */
    async execute(input: IdempotentExecutionInput): Promise<ExecutionOutcome> {
      const now = clock.now();
      const keyDigest = digester.digestKey(input.key);
      // Canonicalized first, so key order and formatting differences between
      // two retries do not produce two fingerprints.
      const requestFingerprint = digester.fingerprint(canonicalRequest(input.request));

      const recordId = ids.nextIdempotencyRecordId();
      const outcome: ClaimOutcome = await repository.claim({
        recordId,
        scope: input.scope,
        operation: input.operation,
        keyDigest,
        requestFingerprint,
        now,
        expiresAt: now + policy.retentionMs,
      });

      switch (outcome.kind) {
        case "conflict":
          // Never executes, never replays. The first request's result belongs
          // to the first request.
          throw new IdempotencyConflictError();

        case "inProgress":
          // Reachable only under the out-of-transaction pattern. With an
          // in-transaction claim a concurrent duplicate blocks on the unique
          // index instead of observing this state.
          throw new IdempotencyInProgressError();

        case "completed":
          return {
            statusCode: outcome.result.statusCode,
            body: outcome.result.body,
            replayed: true,
          };

        case "claimed":
          break;
      }

      // This call owns the claim. Any throw from here propagates and rolls the
      // transaction back — taking the claim row with it, so the key is not
      // poisoned and a retry can execute. That is why there is no try/catch:
      // catching would defeat the mechanism.
      const result = await input.execute();

      const stored: StoredResult = {
        version: 1,
        statusCode: result.statusCode,
        body: result.body,
      };
      assertStorable(stored);

      await repository.complete(recordId, stored, clock.now());

      return { statusCode: result.statusCode, body: result.body, replayed: false };
    },
  };
}

export type IdempotencyService = ReturnType<typeof createIdempotencyService>;

/**
 * Rejects a result that cannot be replayed faithfully.
 *
 * Serializability is checked BEFORE the row is written. A body that fails to
 * serialize after the mutation committed would leave a completed record whose
 * stored result is unreadable, and every retry would then fail.
 */
function assertStorable(result: StoredResult): void {
  if (result.statusCode < 100 || result.statusCode >= 600) {
    throw new TypeError(`Refusing to store an implausible status ${String(result.statusCode)}.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result.body);
  } catch {
    throw new TypeError("An idempotent result body must be JSON-serializable.");
  }
  if (serialized === undefined) {
    // `JSON.stringify(undefined)` returns undefined rather than throwing.
    throw new TypeError("An idempotent result body must not be undefined.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    throw new TypeError(
      `An idempotent result body must be at most ${String(MAX_RESULT_BYTES)} bytes. `
      + "Store the payload and reference it instead.",
    );
  }
}
