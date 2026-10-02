// Messages from the public website (095), in PostgreSQL.
//
// A table with no tenant policy: its rows are written by visitors with no
// account. Insert and select only — the application role cannot change or
// remove a message once it is received.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { UserId } from "@lagda/contracts";
import type {
  PublicInquiryInboxAccount, PublicInquiryKind, PublicInquiryRecord,
  PublicInquiryRepository, PublicInquiryUnitOfWork,
} from "@lagda/application";
import type { Database, PublicInquiriesTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { createNotificationRepository } from "./notifications.js";

type Db = Kysely<Database> | Transaction<Database>;

const KINDS: readonly string[] = ["demo", "contact", "waitlist"];

function toInquiry(row: Selectable<PublicInquiriesTable>): PublicInquiryRecord {
  if (!KINDS.includes(row.kind)) {
    throw new PersistenceMappingError("public_inquiries", "kind", `"${row.kind}" is not a known kind.`);
  }
  return {
    inquiryId: row.inquiry_id,
    kind: row.kind as PublicInquiryKind,
    name: row.name,
    email: row.email,
    organization: row.organization,
    role: row.role,
    organizationSize: row.organization_size,
    industry: row.industry,
    phone: row.phone,
    topic: row.topic,
    subject: row.subject,
    message: row.message,
    createdAt: row.created_at.getTime(),
  };
}

async function insertInquiry(db: Db, i: PublicInquiryRecord): Promise<void> {
  await db.insertInto("public_inquiries").values({
    inquiry_id: i.inquiryId, kind: i.kind, name: i.name, email: i.email,
    organization: i.organization, role: i.role, organization_size: i.organizationSize,
    industry: i.industry, phone: i.phone, topic: i.topic, subject: i.subject,
    message: i.message, created_at: new Date(i.createdAt),
  }).execute();
}

async function accountWhere(
  db: Db, column: "user_id" | "normalized_email", value: string,
): Promise<PublicInquiryInboxAccount | null> {
  const row = await db.selectFrom("users")
    .select(["user_id", "email", "display_name", "full_name"])
    .where(column, "=", value)
    .executeTakeFirst();
  if (row === undefined) return null;
  const name = (row.full_name ?? "").trim() || (row.display_name ?? "").trim() || row.email;
  return { userId: row.user_id as UserId, email: row.email, displayName: name };
}

function unitOfWork(trx: Transaction<Database>): PublicInquiryUnitOfWork {
  return {
    insert: inquiry => insertInquiry(trx, inquiry),
    notifications: createNotificationRepository(trx),
    transaction: trx,
  };
}

export function createPublicInquiryRepository(db: Kysely<Database>): PublicInquiryRepository {
  return {
    insert: inquiry => insertInquiry(db, inquiry),

    async find(inquiryId) {
      const row = await db.selectFrom("public_inquiries").selectAll()
        .where("inquiry_id", "=", inquiryId).executeTakeFirst();
      return row === undefined ? null : toInquiry(row);
    },

    async list({ kind, limit }) {
      let query = db.selectFrom("public_inquiries").selectAll();
      if (kind !== null) query = query.where("kind", "=", kind);
      const rows = await query.orderBy("created_at", "desc").orderBy("inquiry_id", "desc").limit(limit).execute();
      return rows.map(toInquiry);
    },

    async countByKind() {
      const rows = await db.selectFrom("public_inquiries")
        .select(["kind", eb => eb.fn.countAll().as("total")])
        .groupBy("kind").execute();
      const counts: Record<PublicInquiryKind, number> = { demo: 0, contact: 0, waitlist: 0 };
      for (const row of rows) {
        if (KINDS.includes(row.kind)) counts[row.kind as PublicInquiryKind] = Number(row.total);
      }
      return counts;
    },

    account: userId => accountWhere(db, "user_id", userId),
    accountByNormalizedEmail: email => accountWhere(db, "normalized_email", email),

    async transact(noticeUserId, operation) {
      return db.transaction().execute(async trx => {
        // The notice written here is this account's own row (GLOBAL_USER).
        await sql`select set_config('lagda.user_id', ${noticeUserId}, true)`.execute(trx);
        return operation(unitOfWork(trx));
      });
    },
  };
}
