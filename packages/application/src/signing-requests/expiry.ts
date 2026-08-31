// Deadlines on signing requests, and the sweep that acts on them (BACKEND-46).
//
// ── Everything here was read out of the product, not chosen ────────────────
//
// The SHAPE comes from `ExpirationSettings` in `transaction-detail.ts`:
// per-request, opt-in (`enabled`), and an absolute `expiresAt` rather than a
// period. So there is no workspace default and no duration-from-send, because
// inventing either would expire requests nobody asked to expire.
//
// The AUTHORITY comes from `transaction-detail.service.ts`, which computes
// `avail("edit-expiration", isActive && canPrepare)` -- identical to its rule
// for `cancel`. `signing-request.cancel` is therefore the capability, held by
// exactly the roles with `document.prepare`. Not a new capability: the product
// draws no line between withdrawing a request and scheduling its withdrawal.
//
// The STATES come from `@lagda/core`'s transition table, which defines `expire`
// out of `sent` and `partially-completed` and deliberately not out of
// `completion-ready` -- a deadline that passes after the last signature does
// not un-sign anything.

import type { WorkspaceId } from "@lagda/contracts";
import { EXPIRABLE_SIGNING_REQUEST_STATES } from "@lagda/core";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { SigningRequestId } from "../common/ports/signing-requests.js";
import { ApplicationError, ResourceNotFoundError } from "../common/errors/index.js";
import { authorize, type SigningRequestDependencies } from "./signing-requests.js";

/**
 * A deadline was asked for on a request that can no longer use one.
 *
 * `conflict`, not validation: the request exists and the instant is well
 * formed; the workspace is simply not in a state where a deadline means
 * anything. The product says the same thing in its own words -- "Cannot change
 * expiration on a closed transaction."
 */
export class SigningRequestNotExpirableError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_request_not_expirable";

  constructor() {
    super("Cannot change the expiry of a closed signing request.");
  }
}

/** The deadline is in the past, or before the request existed. */
export class ExpiryNotInFutureError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "expiry_not_in_future";

  constructor() {
    super("An expiry date must be in the future.");
  }
}

export interface SetExpiryInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  /** NULL clears the deadline. Null is "no deadline", never "leave it alone". */
  readonly expiresAt: number | null;
}

/**
 * Sets or clears a request's deadline.
 *
 * Refuses a deadline in the PAST rather than accepting one and letting the
 * sweep act on it moments later. A user who types yesterday's date has made a
 * mistake, and expiring their request immediately is not a helpful reading of
 * it -- the database refuses `expires_at <= created_at` as a backstop, but this
 * is the check that produces a sentence the user can act on.
 *
 * The index is NOT written here. A trigger maintains it, so this cannot be the
 * caller that forgets.
 */
export async function setSigningRequestExpiry(
  input: SetExpiryInput,
  deps: SigningRequestDependencies,
): Promise<{ readonly expiresAt: number | null }> {
  const now = deps.clock.now();
  if (input.expiresAt !== null && input.expiresAt <= now) {
    throw new ExpiryNotInFutureError();
  }

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.cancel");

    const request = await uow.signingRequests.find(input.signingRequestId);
    // Absent or another tenant. Deliberately one answer.
    if (request === null) throw new ResourceNotFoundError("Signing request");

    const expirable: readonly string[] = EXPIRABLE_SIGNING_REQUEST_STATES;
    if (!expirable.includes(request.state)) throw new SigningRequestNotExpirableError();

    const applied = await uow.signingRequests.setExpiry({
      signingRequestId: input.signingRequestId,
      expiresAt: input.expiresAt,
      now,
    });
    if (!applied) throw new ResourceNotFoundError("Signing request");
    return { expiresAt: input.expiresAt };
  });
}

export interface ExpirySweepResult {
  readonly examined: number;
  readonly expired: number;
  /** Found due, then no longer due by the time the workspace was entered. */
  readonly skipped: number;
  readonly failed: number;
}

export interface ExpirySweepDependencies {
  readonly transactions: SigningRequestDependencies["transactions"];
  readonly clock: SigningRequestDependencies["clock"];
  readonly policy: { readonly batchSize: number };
}

/**
 * Expires every request whose deadline has passed, across every tenant.
 *
 * Mirrors `reconcileSigningWorkflow` deliberately rather than inventing a
 * second shape: it reads IDENTIFIERS from a table with no tenancy policy, then
 * enters each workspace properly and does the work under normal RLS.
 *
 * ── `skipped` is a real outcome, not a failure ─────────────────────────────
 *
 * The index is read OUTSIDE the workspace transaction, so between the read and
 * the write a request may have been signed, cancelled, or had its deadline
 * extended. `expireIfDue` carries both conditions in its own statement and
 * matches zero rows when that happens -- which is the request being rescued,
 * exactly as intended, and is counted rather than logged as a problem.
 *
 * A failure on one request does not stop the sweep. It is counted and the next
 * is attempted, because one workspace's trouble must not hold every other
 * workspace's deadlines.
 */
export async function expireDueSigningRequests(
  deps: ExpirySweepDependencies,
): Promise<ExpirySweepResult> {
  const now = deps.clock.now();
  const due = await deps.transactions.runGlobal(uow =>
    uow.signingRequestExpiryIndex.listDue({ now, limit: deps.policy.batchSize }));

  let expired = 0;
  let skipped = 0;
  let failed = 0;

  for (const ref of due) {
    try {
      const applied = await deps.transactions.runForWorkspace(ref.workspaceId, uow =>
        uow.signingRequests.expireIfDue({
          signingRequestId: ref.signingRequestId,
          // The SAME instant the index was read at. Re-reading the clock per
          // request would make the batch's meaning drift across its own run.
          now,
        }));
      if (applied) expired++;
      else skipped++;
    } catch {
      // Swallowed without the error object, following the reconciliation
      // sweep: an exception message is unbounded text that could carry a value
      // from the row it failed on, and this loop must not be the one place
      // that leaks it.
      failed++;
    }
  }

  return { examined: due.length, expired, skipped, failed };
}
