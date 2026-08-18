// Finding transport work across tenants: the ordering, the grouping, and what
// the queue payload is allowed to carry.

import { describe, it, expect } from "vitest";
import { dispatchNotifications, type DispatchDependencies } from "./dispatch.js";
import type {
  DispatchRef, NotificationDeliveryId, NotificationScope,
} from "../common/ports/notifications.js";
import type { WorkspaceId, UserId } from "@lagda/contracts";

const AT = 1_760_000_000_000;

const ws = (id: string): NotificationScope =>
  ({ kind: "WORKSPACE", workspaceId: id as WorkspaceId });
const user = (id: string): NotificationScope =>
  ({ kind: "GLOBAL_USER", userId: id as UserId });

const ref = (id: string, scope: NotificationScope): DispatchRef =>
  ({ notificationDeliveryId: id as NotificationDeliveryId, scope });

interface Harness {
  readonly deps: DispatchDependencies;
  readonly order: string[];
  readonly enqueued: unknown[];
  readonly scopesEntered: NotificationScope[];
}

function harness(over: {
  expired?: readonly DispatchRef[];
  due?: readonly DispatchRef[];
  reclaimedPerScope?: number;
  batchSize?: number;
} = {}): Harness {
  const order: string[] = [];
  const enqueued: unknown[] = [];
  const scopesEntered: NotificationScope[] = [];
  const expired = over.expired ?? [];
  const due = over.due ?? [];

  return {
    order, enqueued, scopesEntered,
    deps: {
      transactions: {
        runGlobal: (operation: (uow: never) => Promise<unknown>) => {
          const uow = {
            scope: "global",
            notificationDispatch: {
              listExpiredClaims: () => {
                order.push("listExpired");
                return Promise.resolve(expired);
              },
              listDue: () => {
                order.push("listDue");
                return Promise.resolve(due);
              },
              findByProviderReference: () => Promise.resolve(null),
            },
          };
          return operation(uow as never);
        },
        runForNotificationDelivery: (
          scope: NotificationScope,
          operation: (uow: never) => Promise<unknown>,
        ) => {
          order.push("scoped");
          scopesEntered.push(scope);
          const uow = {
            scope,
            notificationTransport: {
              reclaimExpiredLeases: () => Promise.resolve(
                Array.from({ length: over.reclaimedPerScope ?? 1 },
                  (_, index) => `ndel_reclaimed_${String(index)}`)),
            },
          };
          return operation(uow as never);
        },
      } as unknown as DispatchDependencies["transactions"],
      scheduler: {
        enqueue: (_definition: unknown, payload: unknown) => {
          order.push("enqueue");
          enqueued.push(payload);
          return Promise.resolve({ jobId: "job_1" });
        },
      } as unknown as DispatchDependencies["scheduler"],
      clock: { now: () => AT },
      batchSize: over.batchSize ?? 50,
    },
  };
}

describe("ordering", () => {
  it("reclaims before it enqueues", async () => {
    // A reclaimed lease becomes FAILED_RETRYABLE due immediately, so reading
    // the due list afterwards picks it up in the SAME tick. The other order
    // makes a delivery abandoned by a dead worker wait a full interval,
    // because a container restarted.
    const h = harness({
      expired: [ref("ndel_1", ws("ws_1"))],
      due: [ref("ndel_2", ws("ws_1"))],
    });

    await dispatchNotifications(h.deps)();

    expect(h.order).toEqual(["listExpired", "scoped", "listDue", "enqueue"]);
  });

  it("reads the due list globally and writes only inside a scope", async () => {
    // The whole shape of OD-174's answer: a global read learns a scope, and
    // every mutation happens under ordinary tenancy.
    const h = harness({ expired: [ref("ndel_1", user("usr_1"))] });

    await dispatchNotifications(h.deps)();

    expect(h.scopesEntered).toEqual([user("usr_1")]);
  });
});

describe("grouping", () => {
  it("opens one transaction per scope, not one per delivery", async () => {
    // Forty abandoned leases in one workspace is one transaction. The reclaim
    // statement is scoped by RLS, so entering the workspace once returns all
    // of its expired leases.
    const h = harness({
      expired: [
        ref("ndel_1", ws("ws_1")),
        ref("ndel_2", ws("ws_1")),
        ref("ndel_3", ws("ws_2")),
      ],
    });

    await dispatchNotifications(h.deps)();

    expect(h.scopesEntered).toEqual([ws("ws_1"), ws("ws_2")]);
  });

  it("never collides a workspace id with a user id", async () => {
    // The grouping key is prefixed by kind. Without that, a workspace and a
    // user that happened to share an identifier would be one group, and one of
    // them would never be swept.
    const h = harness({
      expired: [ref("ndel_1", ws("same_id")), ref("ndel_2", user("same_id"))],
    });

    await dispatchNotifications(h.deps)();

    expect(h.scopesEntered).toHaveLength(2);
  });
});

describe("the queue payload", () => {
  it("carries the delivery id and nothing else", async () => {
    // S265. A queue row holding a destination is PII in a structure that is
    // dumped, replayed and inspected casually.
    const h = harness({ due: [ref("ndel_9", ws("ws_1"))] });

    await dispatchNotifications(h.deps)();

    expect(h.enqueued).toEqual([{ notificationDeliveryId: "ndel_9" }]);
  });

  it("enqueues one job per due delivery", async () => {
    const h = harness({
      due: [ref("ndel_1", ws("ws_1")), ref("ndel_2", user("usr_1"))],
    });

    const outcome = await dispatchNotifications(h.deps)();

    expect(outcome.enqueued).toBe(2);
    expect(h.enqueued).toHaveLength(2);
  });
});

describe("truncation", () => {
  it("reports a full batch rather than reading as an empty backlog", async () => {
    // S157. A sweep that silently truncates looks exactly like one with
    // nothing left to do, which is the one wrong answer a backlog monitor must
    // never be given.
    const h = harness({
      due: [ref("ndel_1", ws("ws_1")), ref("ndel_2", ws("ws_1"))],
      batchSize: 2,
    });

    const outcome = await dispatchNotifications(h.deps)();

    expect(outcome.truncated).toBe(true);
  });

  it("does not cry truncation on a partial batch", async () => {
    const h = harness({ due: [ref("ndel_1", ws("ws_1"))], batchSize: 50 });

    const outcome = await dispatchNotifications(h.deps)();

    expect(outcome.truncated).toBe(false);
  });

  it("reports nothing to do without opening a scoped transaction", async () => {
    const h = harness();

    const outcome = await dispatchNotifications(h.deps)();

    expect(outcome).toEqual({ reclaimed: 0, enqueued: 0, truncated: false });
    expect(h.scopesEntered).toEqual([]);
  });
});
