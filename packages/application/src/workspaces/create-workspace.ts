// CreateWorkspace — the tenant-creation use case.
//
// ── The invariant this file is responsible for ─────────────────────────────
//
//   workspace committed  ⇔  creator's OWNER membership committed
//
// Neither half is meaningful alone. A workspace with no membership is an
// inaccessible orphan: nobody can read it, nobody can rename it, nobody can
// transfer it, and no endpoint in the system can ever reach it again. A
// membership with no workspace violates a foreign key. One transaction, both
// writes, no exceptions.
//
// ── Why nothing external happens in here ───────────────────────────────────
//
// No bucket is created, no billing customer is registered, no email is sent, no
// job is enqueued (§95–§99). Every one of those would either hold a PostgreSQL
// transaction open across a network call, or happen outside it and be lost on
// rollback. There is no product requirement for any of them, so the correct
// amount of machinery is none.

import type { WorkspaceId, IdempotencyKey } from "@lagda/contracts";
import { assertExactlyOneOwner, validateWorkspaceName, type MembershipView } from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceIdGenerator, WorkspaceMemberIdGenerator,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import { ApplicationValidationError } from "../common/errors/index.js";
import {
  createIdempotencyService, type IdempotencyDependencies,
} from "../idempotency/service.js";

export interface CreateWorkspaceInput {
  /**
   * The authenticated caller. **The only source of the creator's identity.**
   *
   * An `ownerUserId` field would be a request DTO that accepts owner identity,
   * which §21 and §239 forbid outright: any client could then create a workspace
   * owned by someone else, and the owner would never know. There is no such
   * field on this type and none on the route schema, so the attack is not
   * expressible rather than being rejected by a check that could be forgotten.
   */
  readonly actor: AuthenticatedActor;
  readonly name: string;
  /**
   * Client-supplied retry key.
   *
   * Optional at this layer and REQUIRED at the HTTP boundary. A worker or a
   * future integration invoking this directly is not a browser retrying a
   * request whose response was lost, and forcing it to invent a key would be
   * ceremony. The route supplies one for every caller that can double-submit.
   */
  readonly idempotencyKey?: IdempotencyKey;
}

export interface CreateWorkspaceResult {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /**
   * The creator's own role, always `owner`.
   *
   * Safe to return: it is the caller's own authorization state in a workspace
   * they just created, not a disclosure about anyone else (§109).
   */
  readonly role: "owner";
  readonly createdAt: number;
}

export interface CreateWorkspaceDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly workspaceIds: WorkspaceIdGenerator;
  readonly memberIds: WorkspaceMemberIdGenerator;
  /**
   * Everything the idempotency service needs EXCEPT the repository, which comes
   * from the unit of work so the claim shares the business transaction.
   */
  readonly idempotency: Omit<IdempotencyDependencies, "repository">;
}

export class CreateWorkspace {
  constructor(private readonly deps: CreateWorkspaceDependencies) {}

  async execute(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    // Cheap validation first. Nothing is generated and nothing is written until
    // the input is known to be usable — the general rule that no irreversible
    // work precedes a check that could have prevented it.
    const validated = validateWorkspaceName(input.name);
    if (!validated.ok) {
      throw new ApplicationValidationError(nameMessage(validated.reason), ["name"]);
    }
    const name = validated.value;

    // Identity and time come from ports, never from `crypto.randomUUID()` or
    // `Date.now()`. Generating the ID here rather than letting the database
    // assign one is what lets the workspace and its membership be built and
    // written together — and it is why the tenant context can be bound to the
    // new workspace before either row exists.
    //
    // The ID is generated SERVER-SIDE and is not derived from the name, the
    // creator, an email or a sequence (§4). A client cannot choose it: there is
    // no input field for one (§169).
    const workspaceId = this.deps.workspaceIds.nextWorkspaceId();
    const memberId = this.deps.memberIds.nextWorkspaceMemberId();
    const createdAt = this.deps.clock.now();

    const workspace: WorkspaceRecord = { workspaceId, name, createdAt };
    const ownerMembership: WorkspaceMembershipRecord = {
      memberId,
      workspaceId,
      // From the ACTOR. This line is the whole of §21.
      userId: input.actor.userId,
      role: "owner",
      createdAt,
    };

    // The domain invariant, checked against the state about to be written.
    // Application does not re-implement it — "exactly one owner" is a business
    // rule and it lives in core.
    const members: MembershipView[] = [{ memberId, role: "owner" }];
    assertExactlyOneOwner(members);

    const result: CreateWorkspaceResult = {
      workspaceId, name, role: "owner", createdAt,
    };

    // Bound to the workspace being created. Because the ID was generated first,
    // the tenant context matches the rows about to be written and RLS's
    // WITH CHECK permits them — creating a tenant needs no global escape, no
    // BYPASSRLS and no privileged repository (§84, §85).
    const committed = await this.deps.transactions.runForWorkspace(workspaceId, async uow => {
      const write = async (): Promise<{ statusCode: number; body: unknown }> => {
        // Both repositories come from the unit of work, so both write through
        // the same transaction. Independently constructed repositories could
        // hold the pool instead, and the resulting write would survive a
        // rollback that was supposed to discard it.
        await uow.workspaces.insert(workspace);
        await uow.memberships.insert(ownerMembership);
        return { statusCode: 201, body: result };
      };

      if (input.idempotencyKey === undefined) {
        await write();
        return result;
      }

      // The claim is inserted INSIDE this transaction. A rollback takes it with
      // it, so a failed attempt does not poison the key; a concurrent duplicate
      // blocks on the unique index rather than creating a second tenant.
      //
      // Scoped to the USER, not the workspace: the workspace does not exist yet,
      // so there is no tenant to scope by, and the retrying caller is the one
      // stable identity in the operation (§25).
      const outcome = await createIdempotencyService({
        ...this.deps.idempotency,
        repository: uow.idempotency,
      }).execute({
        key: input.idempotencyKey,
        operation: "workspace.create",
        scope: { type: "user", userId: input.actor.userId },
        // The VALIDATED, normalized name — so `"  Acme  "` and `"Acme"` are one
        // logical request and a retry that differs only in whitespace replays
        // rather than conflicting. The session token, CSRF token, request ID and
        // IP are deliberately absent: a session rotation between retries must
        // not make the second attempt look like a different business request.
        request: { name },
        execute: write,
      });

      // On a REPLAY the stored body wins, and returning the locally-built
      // `result` instead would be the bug this whole mechanism exists to
      // prevent: the caller would receive a workspace ID that was generated for
      // this attempt and never written, while the workspace their first request
      // created sat under a different ID they never learn.
      //
      // Nothing was written on this path, so the transaction commits empty. The
      // generated IDs are simply discarded — they are random, not a sequence.
      return outcome.body as CreateWorkspaceResult;
    });

    // No event is published here. Publishing before the commit is durable would
    // let the world learn about a workspace that does not exist; publishing
    // after the transaction, with no outbox, drops the event if the process dies
    // in between. The route emits the security event once the call returns.
    return committed;
  }
}

/** Names the RULE, never the submitted value (§3 of API_CONVENTIONS). */
function nameMessage(reason: "empty" | "too-long" | "control-characters"): string {
  switch (reason) {
    case "empty": return "A workspace name is required.";
    case "too-long": return "That workspace name is too long.";
    case "control-characters":
      return "That workspace name contains unsupported characters.";
  }
}

/**
 * Deliberately absent from this module.
 *
 * There is no `CreateWorkspaceQuotaExceededError` and no plan check. Entitlement
 * limits belong to BACKEND-50, and inventing an error for a rule nobody has
 * written would be a refusal nobody can explain to a customer (§24, §73, §207).
 * The rate limit at the route bounds abuse; it is not a product limit.
 */
export type CreateWorkspaceEntitlementSeam = never;
