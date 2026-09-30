// Plans and test-mode upgrade requests (093), in PostgreSQL.
//
// Account-owned tables with no tenant policy: every read names its account.
// The Free allowance is a CONDITIONAL increment — the limit is in the WHERE,
// never in a preceding read — so two concurrent sends cannot both take it.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { UserId } from "@lagda/contracts";
import {
  ResourceConflictError,
  type PlanRepository, type PlanUpgradeRequestRecord, type UserPlanRecord,
  type PlanId, type PlanUpgradeStatus, type RequestablePlanId, type PlanUnitOfWork, type PlanAccount,
} from "@lagda/application";
import type { Database, PlanUpgradeRequestsTable, UserPlansTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { UniqueConstraintViolation, translatePersistenceError } from "../errors.js";
import { createNotificationRepository } from "./notifications.js";

type Db = Kysely<Database> | Transaction<Database>;

const PLANS: readonly string[] = ["free", "personal", "business", "enterprise"];
const REQUESTABLE: readonly string[] = ["personal", "business"];
const STATUSES: readonly string[] = ["pending", "approved", "declined", "expired", "cancelled"];
const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

function toPlan(row: Selectable<UserPlansTable>): UserPlanRecord {
  if (!PLANS.includes(row.plan)) {
    throw new PersistenceMappingError("user_plans", "plan", `"${row.plan}" is not a known plan.`);
  }
  return {
    userId: row.user_id as UserId,
    plan: row.plan as PlanId,
    paidUntil: ms(row.paid_until),
    autoRenew: row.auto_renew,
    freeDocumentsUsed: row.free_documents_used,
    updatedAt: row.updated_at.getTime(),
  };
}

function toRequest(row: Selectable<PlanUpgradeRequestsTable>): PlanUpgradeRequestRecord {
  if (!REQUESTABLE.includes(row.plan)) {
    throw new PersistenceMappingError("plan_upgrade_requests", "plan", `"${row.plan}" is not requestable.`);
  }
  if (!STATUSES.includes(row.status)) {
    throw new PersistenceMappingError("plan_upgrade_requests", "status", `"${row.status}" is not a known status.`);
  }
  return {
    requestId: row.request_id,
    userId: row.user_id as UserId,
    plan: row.plan as RequestablePlanId,
    amountPesos: row.amount_pesos,
    status: row.status as PlanUpgradeStatus,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    decidedAt: ms(row.decided_at),
    decidedBy: row.decided_by as UserId | null,
  };
}

async function accountWhere(db: Db, column: "user_id" | "normalized_email", value: string): Promise<PlanAccount | null> {
  const row = await db.selectFrom("users")
    .select(["user_id", "email", "display_name", "full_name"])
    .where(column, "=", value)
    .executeTakeFirst();
  if (row === undefined) return null;
  const name = (row.full_name ?? "").trim() || (row.display_name ?? "").trim() || row.email;
  return { userId: row.user_id as UserId, email: row.email, displayName: name };
}

/** The Free row, created on first need. Never overwrites an existing plan. */
async function ensureRow(db: Db, userId: UserId, at: number): Promise<void> {
  await db.insertInto("user_plans").values({
    user_id: userId, plan: "free", paid_until: null, auto_renew: false,
    free_documents_used: 0, updated_at: new Date(at),
  }).onConflict(oc => oc.column("user_id").doNothing()).execute();
}

function unitOfWork(trx: Transaction<Database>): PlanUnitOfWork {
  return {
    async setPlan(input) {
      await trx.insertInto("user_plans").values({
        user_id: input.userId, plan: input.plan,
        paid_until: input.paidUntil === null ? null : new Date(input.paidUntil),
        auto_renew: input.autoRenew, free_documents_used: 0, updated_at: new Date(input.at),
      }).onConflict(oc => oc.column("user_id").doUpdateSet({
        plan: input.plan,
        paid_until: input.paidUntil === null ? null : new Date(input.paidUntil),
        auto_renew: input.autoRenew,
        updated_at: new Date(input.at),
      })).execute();
    },

    async insertRequest(r) {
      try {
        await trx.insertInto("plan_upgrade_requests").values({
          request_id: r.requestId, user_id: r.userId, plan: r.plan, amount_pesos: r.amountPesos,
          status: r.status, created_at: new Date(r.createdAt), expires_at: new Date(r.expiresAt),
          decided_at: r.decidedAt === null ? null : new Date(r.decidedAt), decided_by: r.decidedBy,
        }).execute();
      } catch (error) {
        const translated = translatePersistenceError(error);
        if (translated instanceof UniqueConstraintViolation) {
          throw new ResourceConflictError("A request is already waiting for approval.", translated);
        }
        throw translated;
      }
    },

    async decideRequest(input) {
      const result = await trx.updateTable("plan_upgrade_requests")
        .set({ status: input.status, decided_at: new Date(input.at), decided_by: input.decidedBy })
        .where("request_id", "=", input.requestId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    notifications: createNotificationRepository(trx),
    transaction: trx,
  };
}

export function createPlanRepository(db: Kysely<Database>): PlanRepository {
  return {
    async find(userId) {
      const row = await db.selectFrom("user_plans").selectAll().where("user_id", "=", userId).executeTakeFirst();
      return row === undefined ? null : toPlan(row);
    },

    async claimFreeDocument(userId, limit, at) {
      await ensureRow(db, userId, at);
      const result = await db.updateTable("user_plans")
        .set(eb => ({ free_documents_used: eb("free_documents_used", "+", 1), updated_at: new Date(at) }))
        .where("user_id", "=", userId)
        .where("free_documents_used", "<", limit)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async releaseFreeDocument(userId, at) {
      await db.updateTable("user_plans")
        .set(eb => ({ free_documents_used: eb("free_documents_used", "-", 1), updated_at: new Date(at) }))
        .where("user_id", "=", userId)
        .where("free_documents_used", ">", 0)
        .execute();
    },

    async findRequest(requestId) {
      const row = await db.selectFrom("plan_upgrade_requests").selectAll()
        .where("request_id", "=", requestId).executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },

    async findPendingRequest(userId) {
      const row = await db.selectFrom("plan_upgrade_requests").selectAll()
        .where("user_id", "=", userId).where("status", "=", "pending").executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },

    async listPendingRequests() {
      const rows = await db.selectFrom("plan_upgrade_requests").selectAll()
        .where("status", "=", "pending").orderBy("created_at", "asc").limit(200).execute();
      return rows.map(toRequest);
    },

    account: userId => accountWhere(db, "user_id", userId),
    accountByNormalizedEmail: email => accountWhere(db, "normalized_email", email),

    async transact(noticeUserId, operation) {
      return db.transaction().execute(async trx => {
        // The notices written here are this account's own rows (GLOBAL_USER).
        await sql`select set_config('lagda.user_id', ${noticeUserId}, true)`.execute(trx);
        return operation(unitOfWork(trx));
      });
    },
  };
}
