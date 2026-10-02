// Plans (093), with fakes: reading a plan (lapse, renewal), the workspace's
// plan being its owner's, the gates, the one Free document, and test-mode
// upgrades end to end — sample account only, the approver's notice, approve
// and decline, expiry, and that nobody else can decide.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  effectivePlan, currentPeriodEnd, addOneMonth, planIncludes, bankMismatches,
  getMyPlan, getWorkspacePlan, requireWorkspacePlan, requireOwnPlan, claimFreeDocumentForSend, assertMayCreateWorkspace,
  requestPlanUpgrade, cancelMyPlanUpgradeRequest, listPendingPlanUpgradeRequests,
  getPlanUpgradeRequest, decidePlanUpgradeRequest, listMyPlanInvoices, getMyPlanInvoice,
  PlanRequiredError, FreeDocumentLimitError, TestBankAccountError, PlanUpgradeConflictError,
  SAMPLE_BANK_ACCOUNT, PLAN_REQUEST_LIFETIME_MS,
  type PlanDependencies,
} from "./plans.js";
import type {
  PlanRepository, UserPlanRecord, PlanUpgradeRequestRecord, PlanAccount, PlanUnitOfWork,
} from "../common/ports/plans.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import { FakeTransactionManager, InMemoryStore, fakeNotifications } from "../test-support/fakes.js";
import { createTemplateRegistry } from "../notifications/template-registry.js";
import { ALL_TEMPLATES } from "../notifications/templates.js";

const AT = Date.parse("2026-09-30T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const WS_A = "ws_a" as WorkspaceId; // Ana's
const WS_B = "ws_b" as WorkspaceId; // the company account's

const ANA = "usr_ana" as UserId;
const BEN = "usr_ben" as UserId;       // a member of Ana's workspace
const BOSS = "usr_boss" as UserId;     // the approver
const actor = (userId: UserId): AuthenticatedActor => ({ actorType: "user", userId, sessionId: "ses_x" as SessionId });

class FakePlans implements PlanRepository {
  plans = new Map<string, UserPlanRecord>();
  requests: PlanUpgradeRequestRecord[] = [];
  accounts = new Map<string, PlanAccount>();
  constructor(private readonly store: InMemoryStore) {}

  find(u: UserId) { return Promise.resolve(this.plans.get(u) ?? null); }
  claimFreeDocument(u: UserId, limit: number, at: number) {
    const row = this.plans.get(u) ?? { userId: u, plan: "free" as const, paidUntil: null, autoRenew: false, freeDocumentsUsed: 0, updatedAt: at };
    if (row.freeDocumentsUsed >= limit) { this.plans.set(u, row); return Promise.resolve(false); }
    this.plans.set(u, { ...row, freeDocumentsUsed: row.freeDocumentsUsed + 1, updatedAt: at });
    return Promise.resolve(true);
  }
  releaseFreeDocument(u: UserId, at: number) {
    const row = this.plans.get(u);
    if (row && row.freeDocumentsUsed > 0) this.plans.set(u, { ...row, freeDocumentsUsed: row.freeDocumentsUsed - 1, updatedAt: at });
    return Promise.resolve();
  }
  findRequest(id: string) { return Promise.resolve(this.requests.find(r => r.requestId === id) ?? null); }
  findPendingRequest(u: UserId) { return Promise.resolve(this.requests.find(r => r.userId === u && r.status === "pending") ?? null); }
  listPendingRequests() { return Promise.resolve(this.requests.filter(r => r.status === "pending")); }
  listApprovedRequests(u: UserId) {
    return Promise.resolve(this.requests.filter(r => r.userId === u && r.status === "approved")
      .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0)));
  }
  account(u: UserId) { return Promise.resolve(this.accounts.get(u) ?? null); }
  accountByNormalizedEmail(e: string) {
    return Promise.resolve([...this.accounts.values()].find(a => a.email.toLowerCase() === e) ?? null);
  }
  async transact<T>(_u: UserId, op: (uow: PlanUnitOfWork) => Promise<T>): Promise<T> {
    const plans = new Map(this.plans);
    const requests = [...this.requests];
    try {
      return await op({
        setPlan: x => {
          const prev = this.plans.get(x.userId);
          this.plans.set(x.userId, { userId: x.userId, plan: x.plan, paidUntil: x.paidUntil, autoRenew: x.autoRenew, freeDocumentsUsed: prev?.freeDocumentsUsed ?? 0, updatedAt: x.at });
          return Promise.resolve();
        },
        insertRequest: r => {
          if (this.requests.some(x => x.userId === r.userId && x.status === "pending")) return Promise.reject(new Error("unique"));
          this.requests.push(r);
          return Promise.resolve();
        },
        decideRequest: x => {
          const i = this.requests.findIndex(r => r.requestId === x.requestId && r.status === "pending");
          if (i < 0) return Promise.resolve(false);
          this.requests[i] = { ...this.requests[i]!, status: x.status, decidedAt: x.at, decidedBy: x.decidedBy };
          return Promise.resolve(true);
        },
        notifications: fakeNotifications(this.store),
        transaction: null,
      });
    } catch (error) {
      this.plans = plans;
      this.requests = requests;
      throw error;
    }
  }
}

let store: InMemoryStore;
let plans: FakePlans;
let clock: { t: number; now(): number };
let deps: PlanDependencies;
let seq = 0;

const setPlan = (u: UserId, plan: UserPlanRecord["plan"], paidUntil: number | null, autoRenew = false) =>
  plans.plans.set(u, { userId: u, plan, paidUntil, autoRenew, freeDocumentsUsed: 0, updatedAt: AT });

beforeEach(() => {
  store = new InMemoryStore();
  plans = new FakePlans(store);
  clock = { t: AT, now() { return this.t; } };
  seq = 0;
  store.workspaces.set(WS_A, { workspaceId: WS_A, name: "Reyes Law", createdAt: AT });
  store.workspaces.set(WS_B, { workspaceId: WS_B, name: "LAGDA", createdAt: AT });
  for (const [userId, ws, role] of [[ANA, WS_A, "owner"], [BEN, WS_A, "member"], [BOSS, WS_B, "owner"]] as const) {
    store.memberships.push({ memberId: `mem_${userId}_${ws}` as WorkspaceMemberId, workspaceId: ws, userId, role, createdAt: AT });
  }
  plans.accounts.set(ANA, { userId: ANA, email: "ana@example.com", displayName: "Ana Reyes" });
  plans.accounts.set(BEN, { userId: BEN, email: "ben@example.com", displayName: "Ben Lim" });
  plans.accounts.set(BOSS, { userId: BOSS, email: "Boss@Example.com", displayName: "Chris Cortes" });
  deps = {
    transactions: new FakeTransactionManager(store),
    clock,
    plans,
    ids: { nextPlanUpgradeRequestId: () => `pur_${String(++seq)}` },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_${String(++seq)}` as never,
      nextNotificationDeliveryId: () => `ndel_${String(++seq)}` as never,
    },
    approverEmail: "boss@example.com",
  };
});

const intents = () => [...store.notificationIntents.values()];

describe("reading a plan", () => {
  it("reads no row, Free, and a lapsed month as Free", () => {
    expect(effectivePlan(null, AT)).toBe("free");
    expect(effectivePlan({ userId: ANA, plan: "business", paidUntil: AT - 1, autoRenew: false, freeDocumentsUsed: 0, updatedAt: AT }, AT)).toBe("free");
    expect(effectivePlan({ userId: ANA, plan: "business", paidUntil: AT + 1, autoRenew: false, freeDocumentsUsed: 0, updatedAt: AT }, AT)).toBe("business");
  });

  it("keeps a renewing plan and rolls its period month by month", () => {
    const record = { userId: BOSS, plan: "business" as const, paidUntil: AT, autoRenew: true, freeDocumentsUsed: 0, updatedAt: AT };
    const later = AT + 45 * DAY;
    expect(effectivePlan(record, later)).toBe("business");
    const end = currentPeriodEnd(record, later)!;
    expect(end).toBeGreaterThan(later);
    expect(end).toBe(addOneMonth(addOneMonth(AT)));
  });

  it("adds calendar months, clamped to the month's end", () => {
    expect(new Date(addOneMonth(Date.parse("2026-01-31T00:00:00Z"))).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(new Date(addOneMonth(AT)).toISOString()).toBe("2026-10-30T09:00:00.000Z");
  });

  it("orders plans", () => {
    expect(planIncludes("business", "personal")).toBe(true);
    expect(planIncludes("personal", "business")).toBe(false);
    expect(planIncludes("free", "personal")).toBe(false);
  });

  it("reports the account's own plan and the Free allowance", async () => {
    const view = await getMyPlan(actor(ANA), deps);
    expect(view).toMatchObject({ plan: "free", freeDocumentsUsed: 0, freeDocumentLimit: 1, pendingRequest: null, approver: false, upgradesAvailable: true });
    expect((await getMyPlan(actor(BOSS), deps)).approver).toBe(true);
  });
});

describe("a workspace's plan is its owner's", () => {
  it("gives a Free member the paid owner's features", async () => {
    setPlan(ANA, "business", AT + 10 * DAY);
    expect(await getWorkspacePlan(actor(BEN), WS_A, deps)).toMatchObject({ plan: "business", ownerIsYou: false, ownerName: "Ana Reyes" });
    await expect(requireWorkspacePlan(WS_A, "business", "Teams", deps, BEN)).resolves.toBeUndefined();
  });

  it("refuses a paid feature on a Free owner's workspace", async () => {
    await expect(requireWorkspacePlan(WS_A, "personal", "Branding", deps, ANA)).rejects.toBeInstanceOf(PlanRequiredError);
    setPlan(ANA, "personal", AT + DAY);
    await expect(requireWorkspacePlan(WS_A, "personal", "Branding", deps, ANA)).resolves.toBeUndefined();
    await expect(requireWorkspacePlan(WS_A, "business", "Teams", deps, ANA)).rejects.toMatchObject({ code: "plan_required", requiredPlan: "business" });
  });

  it("lets a non-member through to the operation's own not-found", async () => {
    await expect(requireWorkspacePlan(WS_A, "business", "Teams", deps, BOSS)).resolves.toBeUndefined();
    await expect(getWorkspacePlan(actor(BOSS), WS_A, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("gates nothing without plan dependencies", async () => {
    await expect(requireWorkspacePlan(WS_A, "business", "Teams", undefined, ANA)).resolves.toBeUndefined();
  });
});

describe("joining another workspace is the person's own plan", () => {
  it("refuses a Free person, whatever workspace they are in", async () => {
    setPlan(ANA, "business", AT + DAY); // Ben's owner is paid; Ben is not.
    await expect(requireOwnPlan(BEN, "personal", "Joining another workspace", deps))
      .rejects.toMatchObject({ code: "plan_required", requiredPlan: "personal" });
  });

  it("lets a paid person join", async () => {
    setPlan(BEN, "personal", AT + DAY);
    await expect(requireOwnPlan(BEN, "personal", "Joining another workspace", deps)).resolves.toBeUndefined();
  });
});

describe("the one Free document", () => {
  it("takes the allowance once, then refuses", async () => {
    expect(await claimFreeDocumentForSend(ANA, ANA, deps)).toBe(ANA);
    await expect(claimFreeDocumentForSend(ANA, ANA, deps)).rejects.toBeInstanceOf(FreeDocumentLimitError);
    expect(plans.plans.get(ANA)?.freeDocumentsUsed).toBe(1);
  });

  it("takes nothing under a paid owner", async () => {
    setPlan(ANA, "business", AT + DAY);
    expect(await claimFreeDocumentForSend(ANA, BEN, deps)).toBeNull();
    expect(plans.plans.get(BEN)).toBeUndefined();
  });

  it("can be given back", async () => {
    await claimFreeDocumentForSend(ANA, ANA, deps);
    await plans.releaseFreeDocument(ANA, AT);
    expect(await claimFreeDocumentForSend(ANA, ANA, deps)).toBe(ANA);
  });
});

describe("creating workspaces", () => {
  it("lets a Free account create its first, not a second", async () => {
    const fresh = "usr_new" as UserId;
    await expect(assertMayCreateWorkspace(actor(fresh), deps)).resolves.toBeUndefined();
    await expect(assertMayCreateWorkspace(actor(ANA), deps)).rejects.toBeInstanceOf(PlanRequiredError);
    setPlan(ANA, "personal", AT + DAY);
    await expect(assertMayCreateWorkspace(actor(ANA), deps)).resolves.toBeUndefined();
  });
});

describe("upgrading in test mode", () => {
  const sample = { ...SAMPLE_BANK_ACCOUNT };

  it("accepts the sample account however it is spaced or cased", () => {
    expect(bankMismatches({ ...sample, accountNumber: "000012345678", swiftCode: " lagdtest " })).toEqual([]);
  });

  it("refuses anything but the sample, and stores nothing", async () => {
    const real = { ...sample, accountNumber: "1234-5678-9012" };
    await expect(requestPlanUpgrade(actor(ANA), { plan: "business", bank: real }, deps))
      .rejects.toBeInstanceOf(TestBankAccountError);
    expect(plans.requests).toEqual([]);
    expect(intents()).toEqual([]);
  });

  it("asks the approver, without any bank detail in the notice", async () => {
    const view = await requestPlanUpgrade(actor(ANA), { plan: "business", bank: sample }, deps);
    expect(view).toMatchObject({ plan: "business", amountPesos: 799, status: "pending" });
    const [notice] = intents();
    expect(notice).toMatchObject({ notificationType: "PLAN_UPGRADE_REQUESTED", audience: { kind: "USER", userId: BOSS } });
    expect(JSON.stringify(notice)).not.toContain(sample.accountNumber);
    expect((await getMyPlan(actor(ANA), deps)).pendingRequest?.requestId).toBe(view.requestId);
    await expect(requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps))
      .rejects.toMatchObject({ code: "plan_upgrade_pending" });
  });

  it("activates a month on approval and tells the requester", async () => {
    const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "business", bank: sample }, deps);
    const decided = await decidePlanUpgradeRequest(actor(BOSS), requestId, "approve", deps);
    expect(decided.status).toBe("approved");
    const mine = await getMyPlan(actor(ANA), deps);
    expect(mine).toMatchObject({ plan: "business", pendingRequest: null });
    expect(mine.paidUntil).toBe(addOneMonth(AT));
    expect(intents().map(i => i.notificationType)).toEqual(["PLAN_UPGRADE_REQUESTED", "PLAN_UPGRADE_APPROVED"]);
    await expect(decidePlanUpgradeRequest(actor(BOSS), requestId, "decline", deps))
      .rejects.toBeInstanceOf(PlanUpgradeConflictError);
  });

  it("changes nothing on decline", async () => {
    const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
    await decidePlanUpgradeRequest(actor(BOSS), requestId, "decline", deps);
    expect((await getMyPlan(actor(ANA), deps)).plan).toBe("free");
    expect(intents().at(-1)?.notificationType).toBe("PLAN_UPGRADE_DECLINED");
  });

  it("lets nobody but the approver see or decide", async () => {
    const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
    await expect(getPlanUpgradeRequest(actor(ANA), requestId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(decidePlanUpgradeRequest(actor(BEN), requestId, "approve", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect((await listPendingPlanUpgradeRequests(actor(BOSS), deps)).map(r => r.requesterName)).toEqual(["Ana Reyes"]);
  });

  describe("self-approve (test mode)", () => {
    beforeEach(() => { deps = { ...deps, selfApprove: true }; });

    it("sends the approval email to the requester, not the approver", async () => {
      await requestPlanUpgrade(actor(ANA), { plan: "business", bank: sample }, deps);
      const [notice] = intents();
      expect(notice).toMatchObject({ notificationType: "PLAN_UPGRADE_REQUESTED", audience: { kind: "USER", userId: ANA } });
    });

    it("lets the requester approve their own request, and only theirs", async () => {
      const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "business", bank: sample }, deps);
      await expect(decidePlanUpgradeRequest(actor(BEN), requestId, "approve", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect((await getPlanUpgradeRequest(actor(ANA), requestId, deps)).requesterName).toBe("Ana Reyes");
      expect((await decidePlanUpgradeRequest(actor(ANA), requestId, "approve", deps)).status).toBe("approved");
      expect((await getMyPlan(actor(ANA), deps)).plan).toBe("business");
    });

    it("the approver can still decide anyone's", async () => {
      const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
      expect((await decidePlanUpgradeRequest(actor(BOSS), requestId, "approve", deps)).status).toBe("approved");
    });

    it("works with no approver configured", async () => {
      deps = { ...deps, approverEmail: null };
      expect((await getMyPlan(actor(ANA), deps)).upgradesAvailable).toBe(true);
      await expect(requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps)).resolves.toMatchObject({ status: "pending" });
    });
  });

  describe("invoices", () => {
    const buy = async (who: UserId, plan: "personal" | "business") => {
      const { requestId } = await requestPlanUpgrade(actor(who), { plan, bank: sample }, deps);
      await decidePlanUpgradeRequest(actor(BOSS), requestId, "approve", deps);
      clock.t += 60_000;
      return requestId;
    };

    it("has none until something is approved, and none for declined or cancelled requests", async () => {
      expect(await listMyPlanInvoices(actor(ANA), deps)).toEqual([]);
      const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
      await decidePlanUpgradeRequest(actor(BOSS), requestId, "decline", deps);
      await requestPlanUpgrade(actor(ANA), { plan: "business", bank: sample }, deps);
      await cancelMyPlanUpgradeRequest(actor(ANA), deps);
      expect(await listMyPlanInvoices(actor(ANA), deps)).toEqual([]);
    });

    it("one per approval: Personal then Business gives two, newest first, numbered in order", async () => {
      await buy(ANA, "personal");
      await buy(ANA, "business");
      const list = await listMyPlanInvoices(actor(ANA), deps);
      expect(list.map(i => [i.number, i.planName, i.amountPesos])).toEqual([
        ["LAGDA-2026-0002", "Business", 799], ["LAGDA-2026-0001", "Personal", 299],
      ]);
      expect(list[0]!.periodEnd).toBe(addOneMonth(list[0]!.issuedAt));
    });

    it("buying a plan again after it lapsed is a new invoice", async () => {
      await buy(ANA, "business");
      clock.t += 40 * 24 * 3600_000; // the month has ended; back to Free
      expect((await getMyPlan(actor(ANA), deps)).plan).toBe("free");
      await buy(ANA, "business");
      expect((await listMyPlanInvoices(actor(ANA), deps)).map(i => i.number)).toEqual(["LAGDA-2026-0002", "LAGDA-2026-0001"]);
    });

    it("gives one invoice's print details to its owner only, with a link into the app", async () => {
      await buy(ANA, "business");
      deps = { ...deps, appBaseUrl: "https://app.example.com/" };
      const doc = await getMyPlanInvoice(actor(ANA), "LAGDA-2026-0001", deps);
      expect(doc.billedTo).toEqual({ name: "Ana Reyes", email: "ana@example.com" });
      expect(doc.url).toBe("https://app.example.com/app/workspace/settings/billing/invoices/LAGDA-2026-0001");
      await expect(getMyPlanInvoice(actor(BEN), "LAGDA-2026-0001", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(getMyPlanInvoice(actor(ANA), "LAGDA-2026-0099", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("shows a person only their own", async () => {
      await buy(ANA, "personal");
      expect(await listMyPlanInvoices(actor(BEN), deps)).toEqual([]);
    });
  });

  it("without self-approve, a requester cannot approve their own", async () => {
    const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
    await expect(decidePlanUpgradeRequest(actor(ANA), requestId, "approve", deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("expires after seven days, and a new request can be made", async () => {
    const { requestId } = await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
    clock.t = AT + PLAN_REQUEST_LIFETIME_MS + 1;
    await expect(decidePlanUpgradeRequest(actor(BOSS), requestId, "approve", deps))
      .rejects.toMatchObject({ code: "plan_upgrade_not_pending" });
    expect((await getMyPlan(actor(ANA), deps)).pendingRequest).toBeNull();
    await expect(requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps)).resolves.toMatchObject({ status: "pending" });
  });

  it("can be cancelled by the requester", async () => {
    await requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps);
    await cancelMyPlanUpgradeRequest(actor(ANA), deps);
    expect((await getMyPlan(actor(ANA), deps)).pendingRequest).toBeNull();
    await expect(cancelMyPlanUpgradeRequest(actor(ANA), deps)).rejects.toMatchObject({ code: "plan_upgrade_not_pending" });
  });

  it("is unavailable without an approver account", async () => {
    deps = { ...deps, approverEmail: "nobody@example.com" };
    await expect(requestPlanUpgrade(actor(ANA), { plan: "personal", bank: sample }, deps))
      .rejects.toMatchObject({ code: "plan_upgrade_unavailable" });
  });
});
