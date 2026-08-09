// Durable idempotency.
//
// Transport-independent: nothing here mentions HTTP, Fastify or a cookie. A
// worker retrying a job uses the same claim semantics as an HTTP retry, which
// is the point of putting it in the application layer rather than in a
// middleware.

import type { WorkspaceId, UserId, IdempotencyKey } from "@lagda/contracts";

/** SHA-256 of the client key, domain-separated. The raw key is never stored. */
export type IdempotencyKeyDigest = string & { readonly __brand: "IdempotencyKeyDigest" };

/**
 * SHA-256 of the CANONICAL logical request.
 *
 * A distinct type from `Sha256Digest` deliberately. A document hash identifies
 * bytes someone signed; this identifies what a caller asked for. Making them
 * interchangeable would let one be compared against the other.
 */
export type RequestFingerprint = string & { readonly __brand: "RequestFingerprint" };

export type IdempotencyRecordId = string & { readonly __brand: "IdempotencyRecordId" };

/**
 * Who a key belongs to.
 *
 * A raw idempotency key is NOT globally unique — two unrelated clients can both
 * send `"1"`, or the same UUID. Identity must therefore carry the caller, and a
 * discriminated union makes each variant carry exactly the identifiers its
 * scope needs rather than four nullable columns.
 *
 * `recipient` exists because signature submission (BACKEND-36) is performed by
 * an external signer with no workspace session — the framework must not depend
 * on `AuthenticatedActor.userId`.
 */
export type IdempotencyScope =
  | { readonly type: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly type: "user"; readonly userId: UserId }
  | { readonly type: "recipient"; readonly recipientId: string;
      readonly signingRequestId: string }
  | { readonly type: "system"; readonly operationScope: string };

/**
 * Operations that require a key, from handoff §28.
 *
 * A closed union, so a feature command cannot invent an operation name by
 * typo — `signingRequest.send` and `signing_request.send` would be two
 * different namespaces sharing one table.
 *
 * Deliberately NOT every future mutation. These five are what the handoff
 * names; feature commands extend this union when they arrive.
 */
export const IDEMPOTENT_OPERATIONS = [
  "signingRequest.send",
  "workspace.invitation.create",
  "billing.plan.change",
  "signature.submit",
  "otp.deliver",
  /**
   * Workspace creation (BACKEND-25).
   *
   * Added because a lost response is indistinguishable from a failure to the
   * browser that sent it, and the natural reaction — retry — creates a SECOND
   * TENANT. Unlike most duplicates that is not a cosmetic problem: the user now
   * has two workspaces with the same name, no way to tell which the first
   * request produced, and no deletion endpoint to remove the wrong one.
   *
   * Scoped to `user`, not `workspace`: the workspace does not exist when the key
   * is claimed, so there is nothing else to scope by.
   */
  "workspace.create",
] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

/**
 * A stored replayable result.
 *
 * `version` is not decoration: records outlive a deployment inside the
 * retention window, so a parser must be able to read yesterday's row. Bumped
 * only when this SHAPE changes.
 *
 * Deliberately absent: headers of any kind. No `Set-Cookie`, no CORS, no
 * security headers, no `X-Request-Id`. Those are produced fresh by the current
 * response pipeline — replaying a stored `Set-Cookie` would re-issue an old
 * session.
 */
export interface StoredResult {
  readonly version: 1;
  readonly statusCode: number;
  readonly body: unknown;
}

export interface IdempotencyRecord {
  readonly recordId: IdempotencyRecordId;
  readonly scope: IdempotencyScope;
  readonly operation: IdempotentOperation;
  readonly keyDigest: IdempotencyKeyDigest;
  readonly requestFingerprint: RequestFingerprint;
  readonly state: "in-progress" | "completed";
  readonly result?: StoredResult;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt: number;
}

export interface ClaimInput {
  readonly recordId: IdempotencyRecordId;
  readonly scope: IdempotencyScope;
  readonly operation: IdempotentOperation;
  readonly keyDigest: IdempotencyKeyDigest;
  readonly requestFingerprint: RequestFingerprint;
  readonly now: number;
  readonly expiresAt: number;
}

/**
 * What a claim attempt resolved to.
 *
 * A typed union rather than a boolean. `true`/`false` cannot express the
 * difference between "you own this, go execute", "someone already did this,
 * replay it" and "this key was used for something else, refuse" — and those
 * three lead to completely different behaviour.
 */
export type ClaimOutcome =
  | { readonly kind: "claimed" }
  | { readonly kind: "completed"; readonly result: StoredResult }
  | { readonly kind: "inProgress" }
  | { readonly kind: "conflict" };

/**
 * Idempotency persistence.
 *
 * **Mixed typed scope, and no RLS** — the second deliberate exception to the
 * tenancy rule after sessions. A workspace-only policy would have to decide
 * what `workspace_id IS NULL` means for user and recipient scopes, and
 * "unrestricted" is the dangerous answer.
 *
 * Safety comes from identity instead: every method takes the FULL identity, and
 * there is no method that queries by key alone. A caller cannot ask "who else
 * used this key".
 */
export interface IdempotencyRepository {
  /**
   * Atomically claims the identity, or reports what already holds it.
   *
   * Implemented as a single conditional INSERT. A `SELECT` followed by an
   * `INSERT` is a race two processes both lose: both see nothing and both
   * proceed.
   */
  claim(input: ClaimInput): Promise<ClaimOutcome>;

  /** Marks the claimed record complete. Runs in the SAME transaction as the mutation. */
  complete(
    recordId: IdempotencyRecordId, result: StoredResult, completedAt: number,
  ): Promise<void>;

  find(
    scope: IdempotencyScope, operation: IdempotentOperation, keyDigest: IdempotencyKeyDigest,
  ): Promise<IdempotencyRecord | null>;

  /** Deletes expired rows. Bounded, and never on the request path. */
  deleteExpired(before: number, limit: number): Promise<number>;
}

export interface IdempotencyKeyDigester {
  digestKey(key: IdempotencyKey): IdempotencyKeyDigest;
  fingerprint(canonical: string): RequestFingerprint;
}

export interface IdempotencyRecordIdGenerator {
  nextIdempotencyRecordId(): IdempotencyRecordId;
}

/**
 * The deterministic scope key stored in the database.
 *
 * Derived from the typed scope, never accepted from a client. Each variant
 * carries its type prefix so a workspace whose ID happened to equal a user's
 * could not collide.
 */
export function toScopeKey(scope: IdempotencyScope): string {
  switch (scope.type) {
    case "workspace": return `ws:${scope.workspaceId}`;
    case "user": return `usr:${scope.userId}`;
    // Both parts, because the same recipient may act on several signing
    // requests and those are different logical scopes.
    case "recipient": return `rcp:${scope.signingRequestId}:${scope.recipientId}`;
    case "system": return `sys:${scope.operationScope}`;
  }
}
