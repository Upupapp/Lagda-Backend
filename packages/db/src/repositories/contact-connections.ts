// Contact connections and discovery settings (091). Account-owned tables with
// no row-level security — see the migration's header. Every statement that
// reads or changes a request names the SESSION's user id as a party to it.

import type { Kysely, Selectable, Transaction } from "kysely";
import type { UserId, WorkspaceId, ContactId } from "@lagda/contracts";
import {
  ResourceConflictError,
  type ContactConnectionRepository, type ContactConnectionRecord, type ContactConnectionStatus,
  type PeopleDirectory, type DirectoryPerson,
} from "@lagda/application";
import type { ContactConnectionsTable, Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { UniqueConstraintViolation, translatePersistenceError } from "../errors.js";

type Row = Selectable<ContactConnectionsTable>;
type Db = Kysely<Database> | Transaction<Database>;

const STATUSES: readonly string[] = ["pending", "accepted", "declined", "cancelled"];
const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

function toRecord(row: Row): ContactConnectionRecord {
  if (!STATUSES.includes(row.status)) {
    throw new PersistenceMappingError("contact_connections", "status", `"${row.status}" is not a known status.`);
  }
  return {
    connectionId: row.connection_id,
    requesterUserId: row.requester_user_id as UserId,
    requesterWorkspaceId: row.requester_workspace_id as WorkspaceId,
    requesterWorkspaceName: row.requester_workspace_name,
    recipientUserId: row.recipient_user_id as UserId,
    recipientWorkspaceId: row.recipient_workspace_id as WorkspaceId | null,
    status: row.status as ContactConnectionStatus,
    requesterContactId: row.requester_contact_id as ContactId | null,
    recipientContactId: row.recipient_contact_id as ContactId | null,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    acceptedAt: ms(row.accepted_at),
    declinedAt: ms(row.declined_at),
    cancelledAt: ms(row.cancelled_at),
  };
}

export function createContactConnectionRepository(db: Db): ContactConnectionRepository {
  return {
    async insert(c) {
      try {
        await db.insertInto("contact_connections").values({
          connection_id: c.connectionId,
          requester_user_id: c.requesterUserId,
          requester_workspace_id: c.requesterWorkspaceId,
          requester_workspace_name: c.requesterWorkspaceName,
          recipient_user_id: c.recipientUserId,
          recipient_workspace_id: null,
          status: c.status,
          requester_contact_id: null,
          recipient_contact_id: null,
          created_at: new Date(c.createdAt),
          updated_at: new Date(c.createdAt),
          accepted_at: null,
          declined_at: c.declinedAt === null ? null : new Date(c.declinedAt),
          cancelled_at: null,
        }).execute();
      } catch (error) {
        const translated = translatePersistenceError(error);
        if (translated instanceof UniqueConstraintViolation) {
          throw new ResourceConflictError("A request between these two people is already waiting.", translated);
        }
        throw translated;
      }
    },

    async findForParticipant(connectionId, userId) {
      const row = await db.selectFrom("contact_connections").selectAll()
        .where("connection_id", "=", connectionId)
        .where(eb => eb.or([eb("requester_user_id", "=", userId), eb("recipient_user_id", "=", userId)]))
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async listBetween(userId, otherUserId) {
      const rows = await db.selectFrom("contact_connections").selectAll()
        .where(eb => eb.or([
          eb.and([eb("requester_user_id", "=", userId), eb("recipient_user_id", "=", otherUserId)]),
          eb.and([eb("requester_user_id", "=", otherUserId), eb("recipient_user_id", "=", userId)]),
        ]))
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toRecord);
    },

    async listReceived(userId) {
      const rows = await db.selectFrom("contact_connections").selectAll()
        .where("recipient_user_id", "=", userId)
        .where("status", "=", "pending")
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toRecord);
    },

    async listSent(userId) {
      const rows = await db.selectFrom("contact_connections").selectAll()
        .where("requester_user_id", "=", userId)
        .where("status", "in", ["pending", "declined"])
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toRecord);
    },

    async markAccepted(input) {
      const at = new Date(input.at);
      const result = await db.updateTable("contact_connections")
        .set({ status: "accepted", recipient_workspace_id: input.recipientWorkspaceId, accepted_at: at, updated_at: at })
        .where("connection_id", "=", input.connectionId)
        .where("recipient_user_id", "=", input.recipientUserId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async setContacts(input) {
      await db.updateTable("contact_connections")
        .set({
          requester_contact_id: input.requesterContactId,
          recipient_contact_id: input.recipientContactId,
          updated_at: new Date(input.at),
        })
        .where("connection_id", "=", input.connectionId)
        .where("status", "=", "accepted")
        .execute();
    },

    async markDeclined(input) {
      const at = new Date(input.at);
      const result = await db.updateTable("contact_connections")
        .set({ status: "declined", declined_at: at, updated_at: at })
        .where("connection_id", "=", input.connectionId)
        .where("recipient_user_id", "=", input.recipientUserId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async markCancelled(input) {
      const at = new Date(input.at);
      const result = await db.updateTable("contact_connections")
        .set({ status: "cancelled", cancelled_at: at, updated_at: at })
        .where("connection_id", "=", input.connectionId)
        .where("requester_user_id", "=", input.requesterUserId)
        .where("status", "in", ["pending", "declined"])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async accountsForContacts(workspaceId, contactIds) {
      const out = new Map<string, UserId>();
      if (contactIds.length === 0) return out;
      const rows = await db.selectFrom("contact_connections")
        .select(["requester_workspace_id", "requester_contact_id", "requester_user_id",
          "recipient_workspace_id", "recipient_contact_id", "recipient_user_id"])
        .where("status", "=", "accepted")
        .where(eb => eb.or([
          eb.and([eb("requester_workspace_id", "=", workspaceId), eb("requester_contact_id", "in", contactIds)]),
          eb.and([eb("recipient_workspace_id", "=", workspaceId), eb("recipient_contact_id", "in", contactIds)]),
        ]))
        .execute();
      for (const r of rows) {
        // Each side's contact stands for the OTHER side's account.
        if (r.requester_workspace_id === workspaceId && r.requester_contact_id !== null) {
          out.set(r.requester_contact_id, r.recipient_user_id as UserId);
        }
        if (r.recipient_workspace_id === workspaceId && r.recipient_contact_id !== null) {
          out.set(r.recipient_contact_id, r.requester_user_id as UserId);
        }
      }
      return out;
    },
  };
}

const PERSON_COLUMNS = ["user_id", "email", "display_name", "job_title", "organization"] as const;

function toPerson(row: { user_id: string; email: string; display_name: string; job_title: string | null; organization: string | null }): DirectoryPerson {
  return {
    userId: row.user_id as UserId,
    email: row.email,
    displayName: row.display_name,
    jobTitle: row.job_title,
    organization: row.organization,
  };
}

/**
 * The account facts a lookup and an accepted request need. `users` carries no
 * tenant policy; the bound on what leaves is `DirectoryPerson`.
 */
export function createPeopleDirectory(db: Db): PeopleDirectory {
  return {
    async findVerifiedByEmail(normalizedEmail) {
      const row = await db.selectFrom("users").select(PERSON_COLUMNS)
        .where("normalized_email", "=", normalizedEmail)
        .where("email_verified_at", "is not", null)
        .executeTakeFirst();
      return row === undefined ? null : toPerson(row);
    },

    async findById(userId) {
      const row = await db.selectFrom("users").select(PERSON_COLUMNS)
        .where("user_id", "=", userId).executeTakeFirst();
      return row === undefined ? null : toPerson(row);
    },

    async findManyById(userIds) {
      const out = new Map<string, DirectoryPerson>();
      if (userIds.length === 0) return out;
      const rows = await db.selectFrom("users").select(PERSON_COLUMNS)
        .where("user_id", "in", [...new Set(userIds)]).execute();
      for (const row of rows) out.set(row.user_id, toPerson(row));
      return out;
    },

    async isDiscoverable(userId) {
      const row = await db.selectFrom("contact_discovery_settings").select("discoverable")
        .where("user_id", "=", userId).executeTakeFirst();
      return row?.discoverable ?? true;
    },

    async setDiscoverable(userId, discoverable, at) {
      const values = { discoverable, updated_at: new Date(at) };
      await db.insertInto("contact_discovery_settings")
        .values({ user_id: userId, ...values })
        .onConflict(oc => oc.column("user_id").doUpdateSet(values))
        .execute();
    },
  };
}

/** Photo versions for many accounts in one read (072's digest). */
export async function avatarVersionsOf(db: Db, userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  const rows = await db.selectFrom("user_avatars").select(["user_id", "digest"])
    .where("user_id", "in", [...new Set(userIds)]).execute();
  for (const r of rows) out.set(r.user_id, r.digest);
  return out;
}

