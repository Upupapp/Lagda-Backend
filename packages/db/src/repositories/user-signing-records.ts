// Migrations 055 and 056: an account's own signing records, and the handoff
// that lets it continue signing from the app.
//
// Every owner read takes the authenticated user id and filters on it. None
// filters on workspace_id -- see the rule at the top of each migration.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  UserSigningRecordsRepository, UserSignedDocumentRecord, UserSigningInboxRecord,
  SigningResumeIntentRepository, SigningResumeIntentRecord, InboxClosedReason,
} from "@lagda/application";
import type {
  Database, UserSignedDocumentsTable, UserSigningInboxTable, SigningResumeIntentsTable,
} from "../schema/index.js";

type Db = Kysely<Database> | Transaction<Database>;

const toSigned = (row: Selectable<UserSignedDocumentsTable>): UserSignedDocumentRecord => ({
  userId: row.user_id,
  signingRequestId: row.signing_request_id,
  recipientId: row.request_recipient_id,
  workspaceId: row.workspace_id,
  documentTitle: row.document_title,
  senderName: row.sender_name,
  senderEmail: row.sender_email,
  workspaceName: row.workspace_name,
  signedAt: row.signed_at.getTime(),
  recordedAt: row.recorded_at.getTime(),
});

const toInbox = (row: Selectable<UserSigningInboxTable>): UserSigningInboxRecord => ({
  userId: row.user_id,
  signingRequestId: row.signing_request_id,
  recipientId: row.request_recipient_id,
  workspaceId: row.workspace_id,
  recipientNormalizedEmail: row.recipient_normalized_email,
  grantCredentialDigest: row.grant_credential_digest,
  documentTitle: row.document_title,
  senderName: row.sender_name,
  senderEmail: row.sender_email,
  workspaceName: row.workspace_name,
  invitedAt: row.invited_at.getTime(),
  expiresAt: row.expires_at.getTime(),
  closedAt: row.closed_at === null ? null : row.closed_at.getTime(),
  closedReason: row.closed_reason as InboxClosedReason | null,
});

const toIntent = (row: Selectable<SigningResumeIntentsTable>): SigningResumeIntentRecord => ({
  intentDigest: row.intent_digest,
  userId: row.user_id,
  signingRequestId: row.signing_request_id,
  recipientId: row.request_recipient_id,
  grantCredentialDigest: row.grant_credential_digest,
  signingSessionId: row.signing_session_id,
  createdAt: row.created_at.getTime(),
  expiresAt: row.expires_at.getTime(),
});

export function createUserSigningRecordsRepository(db: Db): UserSigningRecordsRepository {
  return {
    async findVerifiedAccountByEmail(normalizedEmail) {
      const row = await db.selectFrom("users")
        .select("user_id")
        .where("normalized_email", "=", normalizedEmail)
        // Verified, checked here and again when the account asks to
        // continue. An unverified account with someone else's address must
        // never be shown their documents.
        .where("email_verified_at", "is not", null)
        .executeTakeFirst();
      return row === undefined ? null : { userId: row.user_id };
    },

    async findUserContact(userId) {
      const row = await db.selectFrom("users")
        .select(["display_name", "email"])
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row === undefined ? null : { name: row.display_name, email: row.email };
    },

    async openInboxEntry(entry) {
      await db.insertInto("user_signing_inbox")
        .values({
          user_id: entry.userId,
          signing_request_id: entry.signingRequestId,
          request_recipient_id: entry.recipientId,
          workspace_id: entry.workspaceId,
          recipient_normalized_email: entry.recipientNormalizedEmail,
          grant_credential_digest: entry.grantCredentialDigest,
          document_title: entry.documentTitle,
          sender_name: entry.senderName,
          sender_email: entry.senderEmail,
          workspace_name: entry.workspaceName,
          invited_at: new Date(entry.invitedAt),
          expires_at: new Date(entry.expiresAt),
          closed_at: null,
          closed_reason: null,
        })
        // A re-issued grant refreshes an OPEN entry. A closed one stays closed.
        .onConflict(oc => oc.columns(["signing_request_id", "request_recipient_id"])
          .doUpdateSet(eb => ({
            // An owner, once known, is kept; an unclaimed row gains one.
            user_id: sql<string | null>`coalesce(user_signing_inbox.user_id, excluded.user_id)`,
            grant_credential_digest: eb.ref("excluded.grant_credential_digest"),
            expires_at: eb.ref("excluded.expires_at"),
            invited_at: eb.ref("excluded.invited_at"),
          }))
          .where("user_signing_inbox.closed_at", "is", null))
        .execute();
    },

    async claimInboxForAddress(userId, normalizedEmail) {
      const result = await db.updateTable("user_signing_inbox")
        .set({ user_id: userId })
        .where("user_id", "is", null)
        .where("recipient_normalized_email", "=", normalizedEmail)
        .where("closed_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async closeInboxForRequest(signingRequestId, reason, at) {
      await db.updateTable("user_signing_inbox")
        .set({ closed_at: new Date(at), closed_reason: reason })
        .where("signing_request_id", "=", signingRequestId)
        .where("closed_at", "is", null)
        .execute();
    },

    async findInboxEntryForRecipient(signingRequestId, recipientId) {
      const row = await db.selectFrom("user_signing_inbox").selectAll()
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      return row === undefined ? null : toInbox(row);
    },

    async closeInboxForRecipient(signingRequestId, recipientId, reason, at) {
      await db.updateTable("user_signing_inbox")
        .set({ closed_at: new Date(at), closed_reason: reason })
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .where("closed_at", "is", null)
        .execute();
    },

    async recordSigned(record) {
      await db.insertInto("user_signed_documents")
        .values({
          user_id: record.userId,
          signing_request_id: record.signingRequestId,
          request_recipient_id: record.recipientId,
          workspace_id: record.workspaceId,
          document_title: record.documentTitle,
          sender_name: record.senderName,
          sender_email: record.senderEmail,
          workspace_name: record.workspaceName,
          signed_at: new Date(record.signedAt),
          recorded_at: new Date(record.recordedAt),
        })
        // Written once. A replayed submission must not fail on its own record.
        .onConflict(oc => oc.columns(["signing_request_id", "request_recipient_id"]).doNothing())
        .execute();
    },

    async listSignedForUser(userId, limit) {
      const rows = await db.selectFrom("user_signed_documents").selectAll()
        .where("user_id", "=", userId)
        .orderBy("signed_at", "desc")
        .limit(limit)
        .execute();
      return rows.map(toSigned);
    },

    async listOpenInboxForUser(userId, now, limit) {
      const rows = await db.selectFrom("user_signing_inbox").selectAll()
        .where("user_id", "=", userId)
        .where("closed_at", "is", null)
        .where("expires_at", ">", new Date(now))
        .orderBy("invited_at", "desc")
        .limit(limit)
        .execute();
      return rows.map(toInbox);
    },

    async findOpenInboxEntry(userId, signingRequestId, recipientId, now) {
      const row = await db.selectFrom("user_signing_inbox").selectAll()
        .where("user_id", "=", userId)
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .where("closed_at", "is", null)
        .where("expires_at", ">", new Date(now))
        .executeTakeFirst();
      return row === undefined ? null : toInbox(row);
    },
  };
}

export function createSigningResumeIntentRepository(db: Db): SigningResumeIntentRepository {
  return {
    async create(intent) {
      await db.insertInto("signing_resume_intents").values({
        intent_digest: intent.intentDigest,
        user_id: intent.userId,
        signing_request_id: intent.signingRequestId,
        request_recipient_id: intent.recipientId,
        grant_credential_digest: intent.grantCredentialDigest,
        signing_session_id: intent.signingSessionId,
        created_at: new Date(intent.createdAt),
        expires_at: new Date(intent.expiresAt),
        consumed_at: null,
      }).execute();
    },

    async consume(intentDigest, now) {
      // Conditional: unconsumed and unexpired, or nothing. Two racing
      // requests for one code produce exactly one winner.
      const row = await db.updateTable("signing_resume_intents")
        .set({ consumed_at: new Date(now) })
        .where("intent_digest", "=", intentDigest)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", new Date(now))
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toIntent(row);
    },
  };
}
