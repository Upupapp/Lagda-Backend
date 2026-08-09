// Who is performing an operation.
//
// Resolved identity, never transport. No cookie, no JWT, no Fastify request, no
// session object — the API layer authenticates and hands over the conclusion.
// That is what lets a worker invoke the same use case without inventing a fake
// HTTP request.
//
// Three kinds, deliberately separate rather than one `RequestContext` with
// optional fields. A signer is NOT a workspace member with fields missing, and
// a scheduled job is NOT a human. Collapsing them would make "who did this?"
// unanswerable in evidence.

import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";

/** An authenticated LAGDA user acting inside a workspace they belong to. */
export interface UserActor {
  readonly kind: "user";
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly membershipId: WorkspaceMemberId;
}

/**
 * An external recipient acting through a signing link.
 *
 * Not a workspace member and never treated as one: they hold access to one
 * transaction, not to a workspace. The access token itself never appears here —
 * the API validates it and passes on the resolved identity, so a secret cannot
 * reach a log through an actor object.
 */
export interface RecipientActor {
  readonly kind: "recipient";
  readonly workspaceId: WorkspaceId;
  readonly transactionId: string;
  readonly assignmentId: string;
}

/**
 * The system itself — scheduled expiry, retries, completion sweeps.
 *
 * Explicit rather than borrowing a human's ID, so evidence can distinguish
 * "the sender cancelled this" from "it expired". `reason` names the job.
 */
export interface SystemActor {
  readonly kind: "system";
  readonly reason: string;
}

export type Actor = UserActor | RecipientActor | SystemActor;

/**
 * Server-observed request metadata, for evidence.
 *
 * Separate from `Actor` because most use cases do not need it, and passing it
 * everywhere would put IP addresses into operations with no reason to see them.
 *
 * **Server-observed only.** A client-declared `ipAddress` in a request body is
 * a claim, not evidence, and must never populate this.
 */
export interface ObservedRequestEvidence {
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly observedAt: number;
}
