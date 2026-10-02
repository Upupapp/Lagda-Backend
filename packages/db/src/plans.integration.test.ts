// Plans (093) on real PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. The grants: select/insert/update for `lagda_app`, and NO delete or
//      truncate on either table.
//   2. The release: every existing account becomes Free, the company account
//      Business renewing monthly, and every allowance starts at zero.
//   3. The Free allowance is a conditional increment the database enforces.
//   4. One pending request per account (the partial unique index).
//   5. A request and its notice to the approver commit together under the
//      approver's own user context (GLOBAL_USER rows under row-level security),
//      and an approval sets the plan and tells the requester.
//   6. The migration goes down and back up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId } from "@lagda/contracts";
import {
  ResourceConflictError, requestPlanUpgrade, decidePlanUpgradeRequest, getMyPlan,
  SAMPLE_BANK_ACCOUNT, createTemplateRegistry, ALL_TEMPLATES,
  type PlanDependencies, type SessionId,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createPlanRepository } from "./repositories/plans.js";
import { migrateDown, migrateToLatest } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-30T09:00:00.000Z");
const ANA = "usr_pl_ana" as UserId;
const BOSS = "usr_pl_boss" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: "ses_pl" as SessionId });

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("plans (runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, ANA, { email: "ana@example.com" });
    await seedUser(owner, BOSS, { email: "11corteschristopher@gmail.com" });
  });

  const repo = () => createPlanRepository(app.db);
  let seq = 0;
  const deps = (): PlanDependencies => ({
    plans: repo(),
    transactions: createTransactionManager(app.db),
    clock: { now: () => AT },
    ids: { nextPlanUpgradeRequestId: () => `pur_pl_${String(++seq)}` },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_pl_${String(++seq)}` as never,
      nextNotificationDeliveryId: () => `ndel_pl_${String(++seq)}` as never,
    },
    approverEmail: "11corteschristopher@gmail.com",
  });

  it("grants select, insert and update, and never delete or truncate", async () => {
    for (const table of ["user_plans", "plan_upgrade_requests"]) {
      const r = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>`
        select has_table_privilege('lagda_app', ${table}, 'SELECT') as s,
               has_table_privilege('lagda_app', ${table}, 'INSERT') as i,
               has_table_privilege('lagda_app', ${table}, 'UPDATE') as u,
               has_table_privilege('lagda_app', ${table}, 'DELETE') as d,
               has_table_privilege('lagda_app', ${table}, 'TRUNCATE') as t
      `.execute(owner.db);
      expect(r.rows[0]).toEqual({ s: true, i: true, u: true, d: false, t: false });
    }
  });

  it("releases everyone as Free and the company account as renewing Business", async () => {
    // Re-run 093 over the two accounts seeded above.
    for (const name of ["095_public_inquiries", "094_team_deletion"]) {
      expect((await migrateDown(owner.db)).applied).toEqual([name]);
    }
    expect((await migrateDown(owner.db)).applied).toEqual(["093_user_plans"]);
    expect((await migrateToLatest(owner.db)).error).toBeUndefined();
    const rows = await owner.db.selectFrom("user_plans").selectAll().orderBy("user_id").execute();
    expect(rows.map(r => [r.user_id, r.plan, r.auto_renew, r.free_documents_used])).toEqual([
      [ANA, "free", false, 0],
      [BOSS, "business", true, 0],
    ]);
    expect(rows[1]?.paid_until).not.toBeNull();
    expect((await getMyPlan(actor(BOSS), deps())).plan).toBe("business");
  });

  it("takes the Free allowance once, even for an account with no row", async () => {
    expect(await repo().claimFreeDocument(ANA, 1, AT)).toBe(true);
    expect(await repo().claimFreeDocument(ANA, 1, AT)).toBe(false);
    await repo().releaseFreeDocument(ANA, AT);
    expect((await repo().find(ANA))?.freeDocumentsUsed).toBe(0);
    await repo().releaseFreeDocument(ANA, AT);
    expect((await repo().find(ANA))?.freeDocumentsUsed).toBe(0);
  });

  it("holds one pending request per account", async () => {
    const row = {
      userId: ANA, plan: "personal" as const, amountPesos: 299, status: "pending" as const,
      createdAt: AT, expiresAt: AT + 1000, decidedAt: null, decidedBy: null,
    };
    await repo().transact(ANA, uow => uow.insertRequest({ ...row, requestId: "pur_a" }));
    await expect(repo().transact(ANA, uow => uow.insertRequest({ ...row, requestId: "pur_b" })))
      .rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("asks the approver and activates the plan on approval", async () => {
    const view = await requestPlanUpgrade(actor(ANA), { plan: "business", bank: { ...SAMPLE_BANK_ACCOUNT } }, deps());
    const notices = await owner.db.selectFrom("notification_intents")
      .select(["notification_type", "audience_user_id", "user_id"]).execute();
    expect(notices).toEqual([{ notification_type: "PLAN_UPGRADE_REQUESTED", audience_user_id: BOSS, user_id: BOSS }]);

    await decidePlanUpgradeRequest(actor(BOSS), view.requestId, "approve", deps());
    expect(await repo().find(ANA)).toMatchObject({ plan: "business", autoRenew: false });
    expect((await getMyPlan(actor(ANA), deps())).plan).toBe("business");
    const types = (await owner.db.selectFrom("notification_intents").select("notification_type").execute())
      .map(r => r.notification_type).sort();
    expect(types).toEqual(["PLAN_UPGRADE_APPROVED", "PLAN_UPGRADE_REQUESTED"]);
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    for (const name of ["095_public_inquiries", "094_team_deletion"]) {
      const newer = await migrateDown(owner.db);
      expect(newer.error).toBeUndefined();
      expect(newer.applied).toEqual([name]);
    }
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["093_user_plans"]);
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables where tablename in ('user_plans', 'plan_upgrade_requests')
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    expect((await migrateToLatest(owner.db)).error).toBeUndefined();
  });
});
