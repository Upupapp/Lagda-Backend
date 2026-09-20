// The two-request account binding: intents, and the links they become.
//
// ── Why these live in global scope ────────────────────────────────────────
//
// Neither table has row-level security, and neither is reachable from a
// workspace or recipient scope. That is the point: the intent is a message
// BETWEEN two credential realms, and a message that only one side can read is
// not a message. It carries everything the consuming side needs — including
// the recipient's address — so that side never has to read a recipient-realm
// table to find out who it is being asked about.
//
// ── The read this module does NOT offer ───────────────────────────────────
//
// There is no `listByUser`. `signing_account_links` answers exactly one
// question — "is this recipient bound, and to whom" — and a lookup by user is
// the query an inbox would need. Migration 051 sets out at length why that
// query must not arrive as a side effect of this table existing; the way to
// keep a rule like that is to not write the method.

import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema/index.js";

export interface SigningLinkIntentRecord {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly recipientNormalizedEmail: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface CreateSigningLinkIntentInput {
  readonly intentDigest: string;
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly recipientNormalizedEmail: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CreateSigningAccountLinkInput {
  readonly signingAccountLinkId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly matchedNormalizedEmail: string;
  readonly linkedAt: Date;
}

export interface SigningAccountLinkRecord {
  readonly userId: string;
  readonly matchedNormalizedEmail: string;
  readonly linkedAt: Date;
}

export interface SigningAccountLinkRepository {
  createIntent: (input: CreateSigningLinkIntentInput) => Promise<void>;
  /** Marks the intent consumed and returns it, or null if it cannot be used. */
  claimIntent: (intentDigest: string, now: Date) => Promise<SigningLinkIntentRecord | null>;
  createLink: (input: CreateSigningAccountLinkInput) => Promise<void>;
  findLinkForRecipient: (
    signingRequestId: string, recipientId: string,
  ) => Promise<SigningAccountLinkRecord | null>;
}

export function createSigningAccountLinkRepository(
  db: Kysely<Database> | Transaction<Database>,
): SigningAccountLinkRepository {
  return {
    async createIntent(input): Promise<void> {
      await db.insertInto("signing_link_intents").values({
        intent_digest: input.intentDigest,
        workspace_id: input.workspaceId,
        signing_request_id: input.signingRequestId,
        request_recipient_id: input.recipientId,
        recipient_normalized_email: input.recipientNormalizedEmail,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        consumed_at: null,
      }).execute();
    },

    async claimIntent(intentDigest, now): Promise<SigningLinkIntentRecord | null> {
      // Claimed with a conditional UPDATE rather than read-then-write.
      //
      // Two requests presenting the same code race otherwise, and both would
      // read an unconsumed row before either wrote. Here the database decides:
      // exactly one UPDATE matches `consumed_at is null`, and the loser gets
      // no row back and is told the code is unusable — which it is, because
      // the winner just used it.
      const row = await db.updateTable("signing_link_intents")
        .set({ consumed_at: now })
        .where("intent_digest", "=", intentDigest)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", now)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        workspaceId: row.workspace_id,
        signingRequestId: row.signing_request_id,
        recipientId: row.request_recipient_id,
        recipientNormalizedEmail: row.recipient_normalized_email,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      };
    },

    async createLink(input): Promise<void> {
      await db.insertInto("signing_account_links").values({
        signing_account_link_id: input.signingAccountLinkId,
        user_id: input.userId,
        workspace_id: input.workspaceId,
        signing_request_id: input.signingRequestId,
        request_recipient_id: input.recipientId,
        matched_normalized_email: input.matchedNormalizedEmail,
        linked_at: input.linkedAt,
      }).execute();
    },

    async findLinkForRecipient(signingRequestId, recipientId): Promise<SigningAccountLinkRecord | null> {
      const row = await db.selectFrom("signing_account_links")
        .select(["user_id", "matched_normalized_email", "linked_at"])
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        userId: row.user_id,
        matchedNormalizedEmail: row.matched_normalized_email,
        linkedAt: row.linked_at,
      };
    },
  };
}
