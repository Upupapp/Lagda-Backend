// Applying a confirmed provider event.
//
// ── Where this sits in the pipeline ────────────────────────────────────────
//
//   callback arrives      untrusted, always (S31)
//   authenticate          fixed-time credential comparison
//   CONFIRM               against the provider's own API, by message reference
//   ── this use case ──   resolve a scope, move one delivery, and stop
//
// It takes a state that has already been confirmed and knows nothing about how.
// That is the point of the seam: no provider vocabulary reaches here, no raw
// payload, no HTTP type (S199, S201).
//
// ── What it is structurally incapable of ───────────────────────────────────
//
// Touching anything but transport. It resolves a scope from the dispatch index
// and enters `runForNotificationDelivery`, whose unit of work carries two
// notification repositories and nothing else — so a webhook cannot reach a
// SigningRequest, a recipient, a submission, a completion or an evidence event
// (S37, S38). The guarantee is the transaction's contents, not a reviewer's
// care.

import type { TransactionManager, Clock } from "../common/ports/index.js";

export interface ApplyProviderEventDependencies {
  readonly transactions: Pick<
    TransactionManager, "runGlobal" | "runForNotificationDelivery"
  >;
  readonly clock: Clock;
}

export interface ConfirmedProviderEvent {
  readonly providerMessageReference: string;
  /** Only these two. Acceptance is established by the send call, not a callback. */
  readonly state: "DELIVERED" | "BOUNCED";
}

export type ProviderEventOutcome =
  /** The delivery moved. */
  | { readonly result: "APPLIED"; readonly state: "DELIVERED" | "BOUNCED" }
  /** No delivery carries that reference. Never an error, never a new row. */
  | { readonly result: "UNKNOWN_REFERENCE" }
  /** Found, but the transition table forbids the move. Duplicate, or late. */
  | { readonly result: "NOT_APPLICABLE" };

export function applyProviderEvent(deps: ApplyProviderEventDependencies) {
  return async (event: ConfirmedProviderEvent): Promise<ProviderEventOutcome> => {
    // By REFERENCE, never by the destination the provider reports (S39). An
    // attacker who guesses an address must not reach the delivery belonging to
    // it, and the lookup takes no address to be tempted by.
    const ref = await deps.transactions.runGlobal(uow =>
      uow.notificationDispatch.findByProviderReference(
        event.providerMessageReference));

    // S40. No phantom delivery is created, and this is not an error: a
    // reference LAGDA has never heard of is the ordinary shape of a forged or
    // stale callback, and erroring would invite the provider to retry it.
    if (ref === null) return { result: "UNKNOWN_REFERENCE" };

    const moved = await deps.transactions.runForNotificationDelivery(
      ref.scope,
      uow => uow.notificationTransport.applyConfirmedProviderEvent({
        notificationDeliveryId: ref.notificationDeliveryId,
        state: event.state,
        now: deps.clock.now(),
      }, uow));

    // False is ordinary. A duplicate callback, one arriving out of order, and
    // one about a delivery that already reached a terminal state all land here
    // (S41, S42, S45) — and all of them are correct outcomes rather than
    // failures to report.
    return moved
      ? { result: "APPLIED", state: event.state }
      : { result: "NOT_APPLICABLE" };
  };
}
