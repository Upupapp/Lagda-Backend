// Idempotency persistence.
//
// The claim is ONE statement. A `SELECT` followed by an `INSERT` is a race two
// processes both lose — both see nothing, both proceed, and the mutation runs
// twice. `INSERT … ON CONFLICT DO NOTHING` plus a follow-up read of the winner
// is the smallest correct construction.

import type { Kysely, Selectable, Transaction } from "kysely";
import type {
  ClaimInput, ClaimOutcome, IdempotencyKeyDigest, IdempotencyRecord,
  IdempotencyRecordId, IdempotencyRepository, IdempotencyScope,
  IdempotentOperation, RequestFingerprint, StoredResult,
} from "@lagda/application";
import { toScopeKey } from "@lagda/application";
import type { Database, IdempotencyRecordsTable } from "../schema/index.js";

type Executor = Kysely<Database> | Transaction<Database>;

function toRecord(row: Selectable<IdempotencyRecordsTable>): IdempotencyRecord {
  return {
    recordId: row.record_id as IdempotencyRecordId,
    // Reconstructed from the stored type and key. The typed union is the
    // application's shape; the two columns are the storage shape.
    scope: fromScopeColumns(row.scope_type, row.scope_key),
    operation: row.operation as IdempotentOperation,
    keyDigest: row.key_digest as IdempotencyKeyDigest,
    requestFingerprint: row.request_fingerprint as RequestFingerprint,
    state: row.state === "completed" ? "completed" : "in-progress",
    ...(row.response_status === null || row.response_body === null
        || row.response_version === null
      ? {}
      : {
          result: {
            version: row.response_version as 1,
            statusCode: row.response_status,
            body: row.response_body,
          },
        }),
    createdAt: row.created_at.getTime(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.getTime() }),
    expiresAt: row.expires_at.getTime(),
  };
}

/**
 * Rebuilds a typed scope from its stored columns.
 *
 * Lossy for `recipient`, whose key packs two identifiers. Acceptable because
 * nothing reads the scope back to make a decision — lookups always supply the
 * scope. If that ever changes, store the parts separately rather than parsing.
 */
function fromScopeColumns(type: string, key: string): IdempotencyScope {
  switch (type) {
    case "workspace":
      return { type: "workspace", workspaceId: key.replace(/^ws:/, "") as never };
    case "user":
      return { type: "user", userId: key.replace(/^usr:/, "") as never };
    case "recipient": {
      const [, signingRequestId = "", recipientId = ""] = key.split(":");
      return { type: "recipient", signingRequestId, recipientId };
    }
    default:
      return { type: "system", operationScope: key.replace(/^sys:/, "") };
  }
}

export function createIdempotencyRepository(db: Executor): IdempotencyRepository {
  const identity = (
    scope: IdempotencyScope, operation: IdempotentOperation, keyDigest: IdempotencyKeyDigest,
  ) => ({ scopeType: scope.type, scopeKey: toScopeKey(scope), operation, keyDigest });

  async function readExisting(
    scope: IdempotencyScope, operation: IdempotentOperation, keyDigest: IdempotencyKeyDigest,
  ): Promise<IdempotencyRecord | null> {
    const { scopeType, scopeKey } = identity(scope, operation, keyDigest);
    // EVERY part of the identity. There is deliberately no method that queries
    // by key alone — a caller must never be able to ask "who else used this".
    const row = await db
      .selectFrom("idempotency_records")
      .selectAll()
      .where("scope_type", "=", scopeType)
      .where("scope_key", "=", scopeKey)
      .where("operation", "=", operation)
      .where("key_digest", "=", keyDigest)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  return {
    async claim(input: ClaimInput): Promise<ClaimOutcome> {
      const { scopeType, scopeKey } = identity(input.scope, input.operation, input.keyDigest);

      // ── One statement ──────────────────────────────────────────────────
      //
      // `ON CONFLICT DO NOTHING` returns a row when this call won the race and
      // nothing when it did not. Under a concurrent duplicate in another
      // transaction, PostgreSQL BLOCKS here on the unique index until that
      // transaction commits or rolls back — which is precisely the
      // serialization this design relies on, provided for free.
      const inserted = await db
        .insertInto("idempotency_records")
        .values({
          record_id: input.recordId,
          scope_type: scopeType,
          scope_key: scopeKey,
          operation: input.operation,
          key_digest: input.keyDigest,
          request_fingerprint: input.requestFingerprint,
          state: "in-progress",
          created_at: new Date(input.now),
          expires_at: new Date(input.expiresAt),
        })
        .onConflict((oc) => oc
          .columns(["scope_type", "scope_key", "operation", "key_digest"])
          .doNothing())
        .returning("record_id")
        .executeTakeFirst();

      if (inserted !== undefined) return { kind: "claimed" };

      // Lost the race, or a record already existed. Read the winner.
      const existing = await readExisting(input.scope, input.operation, input.keyDigest);
      if (existing === null) {
        // The row vanished between the insert and the read — the other
        // transaction rolled back. Retrying the claim is correct: the identity
        // is free again.
        return this.claim(input);
      }

      // ── Expired: reclaim IN PLACE ──────────────────────────────────────
      //
      // Updated rather than deleted-then-inserted. Two statements have a race
      // between them; a conditional UPDATE has none, and `WHERE expires_at <=
      // now` means only one concurrent caller can win it.
      if (existing.expiresAt <= input.now) {
        const reclaimed = await db
          .updateTable("idempotency_records")
          .set({
            record_id: input.recordId,
            request_fingerprint: input.requestFingerprint,
            state: "in-progress",
            response_status: null,
            response_body: null,
            response_version: null,
            completed_at: null,
            created_at: new Date(input.now),
            expires_at: new Date(input.expiresAt),
          })
          .where("scope_type", "=", scopeType)
          .where("scope_key", "=", scopeKey)
          .where("operation", "=", input.operation)
          .where("key_digest", "=", input.keyDigest)
          .where("expires_at", "<=", new Date(input.now))
          .returning("record_id")
          .executeTakeFirst();

        if (reclaimed !== undefined) return { kind: "claimed" };
        // Someone else reclaimed it first; fall through and read their state.
        const current = await readExisting(input.scope, input.operation, input.keyDigest);
        if (current === null) return this.claim(input);
        return classify(current, input.requestFingerprint);
      }

      return classify(existing, input.requestFingerprint);
    },

    async complete(
      recordId: IdempotencyRecordId, result: StoredResult, completedAt: number,
    ): Promise<void> {
      await db
        .updateTable("idempotency_records")
        .set({
          state: "completed",
          response_status: result.statusCode,
          response_body: JSON.stringify(result.body),
          response_version: result.version,
          completed_at: new Date(completedAt),
        })
        .where("record_id", "=", recordId)
        .execute();
    },

    find: readExisting,

    async deleteExpired(before: number, limit: number): Promise<number> {
      // Bounded, so a cleanup job cannot lock the table for an unbounded time.
      // The subquery selects the batch; the delete removes exactly it.
      const result = await db
        .deleteFrom("idempotency_records")
        .where("record_id", "in", (eb) => eb
          .selectFrom("idempotency_records")
          .select("record_id")
          // ONLY expired rows. An in-progress operation whose retention has not
          // lapsed must survive — deleting it would let a duplicate execute.
          .where("expires_at", "<=", new Date(before))
          .limit(limit))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

/** Completed and matching → replay. Fingerprint differs → conflict. */
function classify(
  record: IdempotencyRecord, fingerprint: RequestFingerprint,
): ClaimOutcome {
  if (record.requestFingerprint !== fingerprint) return { kind: "conflict" };
  if (record.state === "completed" && record.result !== undefined) {
    return { kind: "completed", result: record.result };
  }
  return { kind: "inProgress" };
}
