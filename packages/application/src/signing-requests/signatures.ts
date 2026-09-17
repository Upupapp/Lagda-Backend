// Who signed a request, and when.
//
// ── Why this is not part of `getSigningRequest` ────────────────────────────
//
// That view is the immutable SNAPSHOT: who was named, where they sign, as
// frozen at creation. Its own guard test asserts it exposes no ceremony
// state at all — `signedAt`, `viewedAt`, `declinedAt`, `sentAt` are all
// refused there on purpose, because mixing "what was agreed" with "what has
// happened since" into one payload makes it impossible to tell, at any call
// site, which half you are looking at.
//
// So progress gets its own surface rather than widening that one. The
// snapshot answers "what is this request"; this answers "how far has it
// got". Both read the same two tables; only this one joins them.
//
// ── Where the signing time comes from ──────────────────────────────────────
//
// `signing_request_recipient_activation.signed_at`, which is written from
// `recipient_submissions.accepted_at` — the instant the recipient's own
// submission was accepted. Never a second clock, and never the request's
// `completedAt` (that is finalization, and is always later).

import type { WorkspaceId, SigningDeclineReason, RecipientWorkflowState } from "@lagda/contracts";
import { ResourceNotFoundError } from "../common/errors/index.js";
import { authorize } from "./signing-requests.js";
import type {
  SigningRequestId, TransactionManager, SigningRequestRecipientRecord,
} from "../common/ports/index.js";
import type { WorkflowRecipientRecord } from "../common/ports/signing-workflow.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { SigningRequestState } from "@lagda/contracts";

export interface SigningRequestSignaturesDependencies {
  readonly transactions: TransactionManager;
}

/**
 * One participant's standing.
 *
 * Carries the identity fields a human needs to read the list (a name and an
 * address, both already visible to anyone holding `signing-request.view`)
 * and nothing that identifies them as an ACCOUNT: no `userId`, no
 * `normalizedEmail`, no session or credential of any kind. A recipient is a
 * party to a document, not a user of the product.
 */
export interface SignatoryView {
  readonly recipientId: string;
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
  readonly type: SigningRequestRecipientRecord["type"];
  readonly isRequired: boolean;
  /** Equal values mean parallel: two people at step 1 both act first. */
  readonly routingOrder: number;
  readonly state: RecipientWorkflowState;
  /** The instant they signed. Null unless `state` is `signed`. */
  readonly signedAt: number | null;
  readonly declinedAt: number | null;
  readonly declineReason: SigningDeclineReason | null;
}

export interface SigningRequestSignaturesView {
  readonly signingRequestId: string;
  readonly state: SigningRequestState;
  /**
   * Required participants who have signed, out of the required total.
   *
   * REQUIRED ones only, because they are what the request waits on — a list
   * that counted optional recipients would read as incomplete forever on a
   * request that is legally finished.
   */
  readonly signedCount: number;
  readonly requiredCount: number;
  readonly signatories: readonly SignatoryView[];
}

export async function getSigningRequestSignatures(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  signingRequestId: SigningRequestId,
  deps: SigningRequestSignaturesDependencies,
): Promise<SigningRequestSignaturesView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    // The same capability as reading the request at all. Seeing who signed a
    // document you can already see the parties to discloses nothing new.
    await authorize(uow, actor, "signing-request.view");

    const request = await uow.signingRequests.find(signingRequestId);
    // Another tenant's request is indistinguishable from an absent one, the
    // same answer `getSigningRequest` gives.
    if (request === null) throw new ResourceNotFoundError("SigningRequest");

    const [recipients, workflow] = await Promise.all([
      uow.signingRequests.listRecipients(signingRequestId),
      uow.signingWorkflow.listRecipientStates(signingRequestId),
    ]);

    const progress = new Map<string, WorkflowRecipientRecord>(
      workflow.map(row => [String(row.recipientId), row]));

    // Driven by the SNAPSHOT, not by the workflow rows: a recipient later in
    // the routing order has no activation row yet, and iterating the workflow
    // instead would silently drop them from the list of parties.
    const signatories = recipients.map((recipient): SignatoryView => {
      const row = progress.get(recipient.recipientId) ?? null;
      return {
        recipientId: recipient.recipientId,
        name: recipient.name,
        email: recipient.email,
        organization: recipient.organization,
        type: recipient.type,
        isRequired: recipient.isRequired,
        routingOrder: recipient.routingOrder,
        // No row means not yet activated. Read as `waiting` rather than as
        // any kind of action, so an un-provisioned party can never present
        // as one who did something.
        state: row?.state ?? "waiting",
        signedAt: row?.signedAt ?? null,
        declinedAt: row?.declinedAt ?? null,
        declineReason: row?.declineReason ?? null,
      };
    });

    const required = signatories.filter(signatory => signatory.isRequired);

    return {
      signingRequestId: request.signingRequestId,
      state: request.state,
      signedCount: required.filter(signatory => signatory.state === "signed").length,
      requiredCount: required.length,
      signatories,
    };
  });
}
