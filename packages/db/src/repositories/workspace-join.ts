// 078. Join tickets and join requests, and the one-ticket credential lookup.

import { type Kysely, type Selectable, type Transaction } from "kysely";
import type { UserId, WorkspaceId, WorkspaceRole } from "@lagda/contracts";
import type {
  JoinRequestId, JoinRequestRecord, JoinRequestState, JoinTicketCredentialLookup,
  JoinTicketDigest, JoinTicketId, JoinTicketRecord, JoinTicketState,
  ScopedJoinRequestRepository, ScopedJoinTicketRepository,
} from "@lagda/application";
import type { Database, WorkspaceJoinRequestsTable, WorkspaceJoinTicketsTable } from "../schema/index.js";

type Db = Kysely<Database> | Transaction<Database>;
const ms = (d: Date | null) => (d === null ? null : d.getTime());

function toTicket(row: Selectable<WorkspaceJoinTicketsTable>): JoinTicketRecord {
  return {
    ticketId: row.ticket_id as JoinTicketId,
    workspaceId: row.workspace_id as WorkspaceId,
    label: row.label,
    recipientEmail: row.recipient_email,
    state: row.state as JoinTicketState,
    tokenDigest: row.token_digest as JoinTicketDigest | null,
    sealedToken: row.sealed_token,
    sealedKeyVersion: row.sealed_key_version,
    workspaceName: row.workspace_name,
    sentByName: row.sent_by_name,
    sentByUserId: row.sent_by_user_id as UserId | null,
    sentAt: ms(row.sent_at),
    withdrawnAt: ms(row.withdrawn_at),
    usedAt: ms(row.used_at),
    usedByUserId: row.used_by_user_id as UserId | null,
    createdByUserId: row.created_by_user_id as UserId,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function toRequest(row: Selectable<WorkspaceJoinRequestsTable>): JoinRequestRecord {
  return {
    requestId: row.request_id as JoinRequestId,
    workspaceId: row.workspace_id as WorkspaceId,
    sourceKind: row.source_kind as "ticket" | "invitation",
    ticketId: row.ticket_id as JoinTicketId | null,
    invitationId: row.invitation_id,
    userId: row.user_id as UserId,
    fullName: row.full_name,
    email: row.email,
    reason: row.reason,
    requestedRole: row.requested_role as WorkspaceRole,
    state: row.state as JoinRequestState,
    decidedByUserId: row.decided_by_user_id as UserId | null,
    decidedAt: ms(row.decided_at),
    createdAt: row.created_at.getTime(),
  };
}

export function createScopedJoinTicketRepository(trx: Db, scope: WorkspaceId): ScopedJoinTicketRepository {
  const table = () => trx.updateTable("workspace_join_tickets")
    .where("workspace_id", "=", scope);
  return {
    async insert(t) {
      await trx.insertInto("workspace_join_tickets").values({
        ticket_id: t.ticketId, workspace_id: t.workspaceId, label: t.label,
        recipient_email: t.recipientEmail, state: t.state, token_digest: t.tokenDigest,
        sealed_token: t.sealedToken, sealed_key_version: t.sealedKeyVersion,
        workspace_name: t.workspaceName, sent_by_name: t.sentByName, sent_by_user_id: t.sentByUserId,
        sent_at: t.sentAt === null ? null : new Date(t.sentAt),
        withdrawn_at: t.withdrawnAt === null ? null : new Date(t.withdrawnAt),
        used_at: t.usedAt === null ? null : new Date(t.usedAt), used_by_user_id: t.usedByUserId,
        created_by_user_id: t.createdByUserId, created_at: new Date(t.createdAt),
        updated_at: new Date(t.updatedAt),
      }).execute();
    },
    async find(ticketId) {
      const row = await trx.selectFrom("workspace_join_tickets").selectAll()
        .where("workspace_id", "=", scope).where("ticket_id", "=", ticketId).executeTakeFirst();
      return row === undefined ? null : toTicket(row);
    },
    async list() {
      const rows = await trx.selectFrom("workspace_join_tickets").selectAll()
        .where("workspace_id", "=", scope).orderBy("created_at", "desc").orderBy("ticket_id").execute();
      return rows.map(toTicket);
    },
    async updateDraft(input) {
      const r = await table().set({
        label: input.label, recipient_email: input.recipientEmail, updated_at: new Date(input.now),
      }).where("ticket_id", "=", input.ticketId).where("state", "=", "draft").executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },
    async markSent(input) {
      const r = await table().set({
        state: "sent", token_digest: input.tokenDigest, sealed_token: input.sealedToken,
        sealed_key_version: input.sealedKeyVersion, workspace_name: input.workspaceName,
        sent_by_name: input.sentByName, sent_by_user_id: input.sentByUserId,
        sent_at: new Date(input.now), withdrawn_at: null, used_at: null, used_by_user_id: null,
        updated_at: new Date(input.now),
      }).where("ticket_id", "=", input.ticketId).where("state", "in", ["draft", "withdrawn"]).executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },
    async withdraw(input) {
      const r = await table().set({
        state: "withdrawn", token_digest: null, sealed_token: null, sealed_key_version: null,
        withdrawn_at: new Date(input.now), updated_at: new Date(input.now),
      }).where("ticket_id", "=", input.ticketId).where("state", "in", ["draft", "sent"]).executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },
    async markUsedIfUnused(input) {
      const r = await table().set({
        used_at: new Date(input.now), used_by_user_id: input.userId, updated_at: new Date(input.now),
      }).where("ticket_id", "=", input.ticketId).where("state", "=", "sent")
        .where("used_at", "is", null).executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },
  };
}

export function createScopedJoinRequestRepository(trx: Db, scope: WorkspaceId): ScopedJoinRequestRepository {
  return {
    async insert(q) {
      await trx.insertInto("workspace_join_requests").values({
        request_id: q.requestId, workspace_id: q.workspaceId, source_kind: q.sourceKind,
        ticket_id: q.ticketId, invitation_id: q.invitationId, user_id: q.userId,
        full_name: q.fullName, email: q.email, reason: q.reason, requested_role: q.requestedRole,
        state: q.state, decided_by_user_id: q.decidedByUserId,
        decided_at: q.decidedAt === null ? null : new Date(q.decidedAt), created_at: new Date(q.createdAt),
      }).execute();
    },
    async find(requestId) {
      const row = await trx.selectFrom("workspace_join_requests").selectAll()
        .where("workspace_id", "=", scope).where("request_id", "=", requestId).executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },
    async list(state) {
      let q = trx.selectFrom("workspace_join_requests").selectAll().where("workspace_id", "=", scope);
      if (state !== null) q = q.where("state", "=", state);
      const rows = await q.orderBy("created_at", "desc").orderBy("request_id").execute();
      return rows.map(toRequest);
    },
    async findPendingForUser(userId) {
      const row = await trx.selectFrom("workspace_join_requests").selectAll()
        .where("workspace_id", "=", scope).where("user_id", "=", userId)
        .where("state", "=", "pending").executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },
    async decideIfPending(input) {
      const r = await trx.updateTable("workspace_join_requests").set({
        state: input.state, decided_by_user_id: input.decidedByUserId, decided_at: new Date(input.now),
      }).where("workspace_id", "=", scope).where("request_id", "=", input.requestId)
        .where("state", "=", "pending").executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },
  };
}

/**
 * The one ticket whose digest this transaction's setting holds. No WHERE on
 * the digest is needed — 078's policy shows at most that row — but it is
 * stated anyway, so a missing setting reads as "not found", never "any".
 */
export function createJoinTicketCredentialLookup(trx: Db, digest: JoinTicketDigest): JoinTicketCredentialLookup {
  return {
    async find() {
      const row = await trx.selectFrom("workspace_join_tickets").selectAll()
        .where("token_digest", "=", digest).executeTakeFirst();
      return row === undefined ? null : toTicket(row);
    },
  };
}
