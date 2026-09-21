// The in-app notification feed: what a signed-in account may be shown about
// messages it was sent.
//
// ══════════════════════════════════════════════════════════════════════════
//  WHAT THIS MODULE MUST NEVER SELECT
// ══════════════════════════════════════════════════════════════════════════
//
//  `notification_intents` carries, per migration 030:
//
//      sealed_secret       an AES-256-GCM ciphertext of a credential
//      sealed_key_version  the key that would decrypt it
//      challenge_id        the id of an auth challenge that owns one
//
//  A SIGNING_INVITATION's sealed secret IS the signing link. Selecting these
//  columns into a route response would hand a live credential to the browser,
//  and the sealing layer exists precisely so that never happens.
//
//  Every query here names its columns explicitly. There is no `selectAll`,
//  and a future column is therefore excluded by default rather than included
//  by accident — which is the whole reason the list is spelled out.
//
// ── Why only the USER audience ────────────────────────────────────────────
//
// `audience_kind` is one of USER, SIGNING_REQUEST_RECIPIENT or
// WORKSPACE_INVITEE. Only the first names an account holder.
//
// A SIGNING_REQUEST_RECIPIENT row is addressed to somebody acting in the
// recipient realm, who may hold no account at all. Surfacing those rows in a
// workspace-realm feed is exactly the cross-realm read that migration 051's
// rule forbids, and those are also the rows carrying sealed signing links.
// Two independent reasons, either one sufficient.
//
// So the audience filter is not a convenience for the caller — it is the
// authorization boundary, and it is expressed as `audience_user_id = :userId`
// so that "read another account's notifications" is not a query this module
// can express.

import type { Kysely } from "kysely";
import type { Database } from "../schema/index.js";

/**
 * The types an account holder can be the audience of.
 *
 * SIGNING_INVITATION is deliberately absent: its audience is a recipient, not
 * a user, so it could never match the `audience_user_id` filter anyway. Named
 * here so the omission reads as a decision rather than an oversight.
 */
export type FeedNotificationType =
  | "SIGNING_COMPLETED"
  | "WORKSPACE_INVITATION"
  | "ACCOUNT_EMAIL_VERIFICATION"
  | "PASSWORD_RESET"
  | "MFA_OTP";

export interface FeedNotification {
  readonly notificationIntentId: string;
  readonly notificationType: string;
  readonly workspaceId: string | null;
  readonly sourceKind: string;
  readonly sourceId: string;
  /**
   * The frozen, schema-checked, NON-SECRET template inputs — migration 030's
   * own description of this column. It is the only free-shaped thing returned,
   * and it is bounded by the template registry on the way in.
   */
  readonly templateInput: unknown;
  readonly createdAt: Date;
}

export interface NotificationFeedRepository {
  listForUser: (userId: string, limit: number) => Promise<FeedNotification[]>;
}

export function createNotificationFeedRepository(
  db: Kysely<Database>,
): NotificationFeedRepository {
  return {
    async listForUser(userId, limit) {
      const rows = await db
        .selectFrom("notification_intents")
        // Explicit column list. See the header: a `selectAll` here would ship
        // `sealed_secret` to a browser the first time anyone refactored.
        .select([
          "notification_intent_id",
          "notification_type",
          "workspace_id",
          "source_kind",
          "source_id",
          "template_input",
          "created_at",
        ])
        // The authorization boundary, not a filter.
        .where("audience_kind", "=", "USER")
        .where("audience_user_id", "=", userId)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute();

      return rows.map(row => ({
        notificationIntentId: row.notification_intent_id,
        notificationType: row.notification_type,
        workspaceId: row.workspace_id,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        templateInput: row.template_input,
        createdAt: row.created_at,
      }));
    },
  };
}
