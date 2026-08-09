// An in-memory idempotency repository.
//
// Faithful to the ONE property the framework depends on: `claim` is atomic
// against the full identity. A fake that resolved conflicts differently from
// the unique index would let a use case be written against behaviour PostgreSQL
// refuses.
//
// Deliberately NOT transactional. The real claim dies with a rolled-back
// transaction; this one does not, because the fake transaction manager restores
// a snapshot of the workspace store and not of this map. `FakeTransactionManager`
// therefore proves "a duplicate key does not create a second workspace" and
// leaves "a rollback frees the key" to the PostgreSQL suite, which is where that
// property actually lives.

import type {
  ClaimInput, ClaimOutcome, IdempotencyKeyDigest, IdempotencyRecord,
  IdempotencyRecordId, IdempotencyRepository, IdempotencyScope,
  IdempotentOperation, StoredResult,
} from "../common/ports/idempotency.js";
import { toScopeKey } from "../common/ports/idempotency.js";

/** The full identity, exactly as the unique index defines it. */
function identity(
  scope: IdempotencyScope, operation: IdempotentOperation, keyDigest: IdempotencyKeyDigest,
): string {
  return `${toScopeKey(scope)}|${operation}|${keyDigest}`;
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>();

  claim(input: ClaimInput): Promise<ClaimOutcome> {
    const key = identity(input.scope, input.operation, input.keyDigest);
    const existing = this.records.get(key);

    if (existing !== undefined && existing.expiresAt > input.now) {
      // Same key, materially different request. Never executes, never replays.
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return Promise.resolve({ kind: "conflict" });
      }
      if (existing.state === "completed" && existing.result !== undefined) {
        return Promise.resolve({ kind: "completed", result: existing.result });
      }
      return Promise.resolve({ kind: "inProgress" });
    }

    // Absent, or expired and therefore a NEW operation rather than a replay.
    this.records.set(key, {
      recordId: input.recordId,
      scope: input.scope,
      operation: input.operation,
      keyDigest: input.keyDigest,
      requestFingerprint: input.requestFingerprint,
      state: "in-progress",
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
    return Promise.resolve({ kind: "claimed" });
  }

  complete(
    recordId: IdempotencyRecordId, result: StoredResult, completedAt: number,
  ): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.recordId !== recordId) continue;
      this.records.set(key, { ...record, state: "completed", result, completedAt });
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  find(
    scope: IdempotencyScope, operation: IdempotentOperation, keyDigest: IdempotencyKeyDigest,
  ): Promise<IdempotencyRecord | null> {
    return Promise.resolve(this.records.get(identity(scope, operation, keyDigest)) ?? null);
  }

  deleteExpired(before: number, limit: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (removed >= limit) break;
      if (record.expiresAt >= before) continue;
      this.records.delete(key);
      removed++;
    }
    return Promise.resolve(removed);
  }
}
