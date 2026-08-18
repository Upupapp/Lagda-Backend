// Applying a confirmed provider event: the lookup key, the scope, and the
// three outcomes.

import { describe, it, expect } from "vitest";
import {
  applyProviderEvent, type ApplyProviderEventDependencies,
} from "./provider-event.js";
import type {
  DispatchRef, NotificationDeliveryId, NotificationScope,
} from "../common/ports/notifications.js";
import type { WorkspaceId } from "@lagda/contracts";

const AT = 1_760_000_000_000;
const WS: NotificationScope =
  { kind: "WORKSPACE", workspaceId: "ws_1" as WorkspaceId };

const found: DispatchRef = {
  notificationDeliveryId: "ndel_1" as NotificationDeliveryId,
  scope: WS,
};

interface Harness {
  readonly deps: ApplyProviderEventDependencies;
  readonly lookups: string[];
  readonly scopesEntered: NotificationScope[];
  readonly applied: unknown[];
}

function harness(over: {
  ref?: DispatchRef | null;
  moved?: boolean;
} = {}): Harness {
  const lookups: string[] = [];
  const scopesEntered: NotificationScope[] = [];
  const applied: unknown[] = [];
  const ref = over.ref === undefined ? found : over.ref;

  return {
    lookups, scopesEntered, applied,
    deps: {
      transactions: {
        runGlobal: (operation: (uow: never) => Promise<unknown>) => operation({
          scope: "global",
          notificationDispatch: {
            findByProviderReference: (reference: string) => {
              lookups.push(reference);
              return Promise.resolve(ref);
            },
          },
        } as never),
        runForNotificationDelivery: (
          scope: NotificationScope,
          operation: (uow: never) => Promise<unknown>,
        ) => {
          scopesEntered.push(scope);
          return operation({
            scope,
            notificationTransport: {
              applyConfirmedProviderEvent: (input: unknown) => {
                applied.push(input);
                return Promise.resolve(over.moved ?? true);
              },
            },
          } as never);
        },
      } as unknown as ApplyProviderEventDependencies["transactions"],
      clock: { now: () => AT },
    },
  };
}

describe("the lookup", () => {
  it("binds by provider message reference and nothing else", async () => {
    // S39. The destination the provider reports is never a lookup key, so an
    // attacker who guesses an address cannot reach the delivery belonging to
    // it. The use case takes no address to be tempted by.
    const h = harness();

    await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-1", state: "DELIVERED",
    });

    expect(h.lookups).toEqual(["pm-1"]);
  });

  it("enters the delivery's own scope before touching anything", async () => {
    // The global read learns a scope; the write happens under ordinary
    // tenancy. A webhook never writes from an unscoped connection.
    const h = harness();

    await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-1", state: "BOUNCED",
    });

    expect(h.scopesEntered).toEqual([WS]);
  });
});

describe("outcomes", () => {
  it("applies a confirmed delivery", async () => {
    const h = harness();

    const outcome = await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-1", state: "DELIVERED",
    });

    expect(outcome).toEqual({ result: "APPLIED", state: "DELIVERED" });
    expect(h.applied).toEqual([{
      notificationDeliveryId: "ndel_1", state: "DELIVERED", now: AT,
    }]);
  });

  it("creates nothing for a reference it has never heard of", async () => {
    // S40. A forged or stale callback is the ordinary shape of this, and no
    // phantom delivery is invented to hang it on. It is not an error either:
    // erroring invites the provider to retry a callback about a message LAGDA
    // does not have.
    const h = harness({ ref: null });

    const outcome = await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-ghost", state: "DELIVERED",
    });

    expect(outcome).toEqual({ result: "UNKNOWN_REFERENCE" });
    expect(h.scopesEntered).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it("reports a forbidden transition as ordinary, not as a failure", async () => {
    // S41, S42, S45. A duplicate callback, one arriving out of order, and one
    // about a delivery that already reached a terminal state all land here,
    // and all three are correct outcomes rather than problems to report.
    const h = harness({ moved: false });

    const outcome = await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-1", state: "DELIVERED",
    });

    expect(outcome).toEqual({ result: "NOT_APPLICABLE" });
  });
});

describe("what it cannot do", () => {
  it("carries no state other than DELIVERED or BOUNCED", async () => {
    // PROVIDER_ACCEPTED is established synchronously by the send call. A
    // callback claiming it would be a provider narrating LAGDA's own past, and
    // the input type has no way to say it.
    const h = harness();

    await applyProviderEvent(h.deps)({
      providerMessageReference: "pm-1", state: "BOUNCED",
    });

    const states = h.applied.map(input => (input as { state: string }).state);
    expect(states.every(state => state === "DELIVERED" || state === "BOUNCED"))
      .toBe(true);
  });
});
