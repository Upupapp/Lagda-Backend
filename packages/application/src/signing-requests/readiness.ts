// The review state: marking a request ready to send, and taking it back.
//
// ── Read out of the product, not designed here ─────────────────────────────
//
// `status-map.ts` calls it "Ready to Send" -- "Document is prepared and ready
// to send to recipients" -- and `transaction-detail.service.ts` computes
// `isDraft = status === "draft" || status === "ready-to-send"`, so it is a
// sub-state of not-yet-sent. The same things stay editable.
//
// ── Why it is worth having at all ──────────────────────────────────────────
//
// `signing-request.create` and `signing-request.send` have been separate
// capabilities since BACKEND-33, which recorded the reason: "create-without-send
// is the FIRST differentiation a real deployment is likely to want -- an
// assistant who assembles the document and a partner who releases it". Without
// this state the assistant has no way to say they are finished. With it, the
// handover is a fact in the database rather than a message in a chat.
//
// So marking ready takes `signing-request.create` -- the assembler's authority,
// not the releaser's. Someone who may build a request may declare it built.
//
// ── OPTIONAL, and that is core's rule ──────────────────────────────────────
//
// `isEditableForSend` accepts `draft` and `ready-to-send` alike, so send still
// works straight from a draft. Making the step mandatory would break every
// existing send to buy a review nobody asked for.

import type { WorkspaceId } from "@lagda/contracts";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { SigningRequestId } from "../common/ports/signing-requests.js";
import { ApplicationError, ResourceNotFoundError } from "../common/errors/index.js";
import { authorize, type SigningRequestDependencies } from "./signing-requests.js";

/**
 * The request is not in a state this transition can act on.
 *
 * `conflict`, not validation: the request exists and the caller may act on it;
 * it has simply moved. One error for both directions, because "it was already
 * marked" and "it has been sent" are the same answer to a client whose view is
 * stale -- re-read and look.
 */
export class SigningRequestNotInExpectedStateError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_request_state_conflict";

  constructor(message: string) {
    super(message);
  }
}

export interface ReadinessInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
}

/**
 * Marks a draft ready to send.
 *
 * COMMITS NOBODY TO ANYTHING. No credential is minted, no recipient is told,
 * nothing leaves the building -- which is exactly why it is safe for the
 * assembler to do and safe to take back.
 */
export async function markSigningRequestReadyToSend(
  input: ReadinessInput,
  deps: SigningRequestDependencies,
): Promise<{ readonly state: "ready-to-send" }> {
  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.create");

    const applied = await uow.signingRequests.markReadyToSendIfDraft({
      signingRequestId: input.signingRequestId,
      now: deps.clock.now(),
    });
    if (applied) return { state: "ready-to-send" as const };

    // Zero rows. Absent and another tenant's are the same hidden 404 as
    // everywhere else; a request that exists and has moved gets the conflict,
    // because telling a stale client to re-read is useful and telling them the
    // request does not exist is a lie.
    const request = await uow.signingRequests.find(input.signingRequestId);
    if (request === null) throw new ResourceNotFoundError("Signing request");
    throw new SigningRequestNotInExpectedStateError(
      "Only a draft can be marked ready to send.");
  });
}

/**
 * Returns a request from review to draft.
 *
 * Only from `ready-to-send`. A SENT request is not retractable this way --
 * `cancel` is the operation for that, and unlike this one it tells recipients.
 */
export async function returnSigningRequestToDraft(
  input: ReadinessInput,
  deps: SigningRequestDependencies,
): Promise<{ readonly state: "draft" }> {
  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.create");

    const applied = await uow.signingRequests.returnToDraftIfReady({
      signingRequestId: input.signingRequestId,
      now: deps.clock.now(),
    });
    if (applied) return { state: "draft" as const };

    const request = await uow.signingRequests.find(input.signingRequestId);
    if (request === null) throw new ResourceNotFoundError("Signing request");
    throw new SigningRequestNotInExpectedStateError(
      "Only a request awaiting send can be returned to draft.");
  });
}
