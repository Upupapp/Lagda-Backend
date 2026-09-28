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

import { sql, type Kysely } from "kysely";
import type { UserId } from "@lagda/contracts";
import type { MyNotificationStateChange } from "@lagda/application";
import type { Database } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";

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

/** USER-audience types that exist only to carry an emailed code. */
const EMAIL_ONLY_TYPES = ["SHARED_DOCUMENT_ACCESS_CODE"] as const;

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
  /** 090. When THIS account marked it read, or null. */
  readonly readAt: Date | null;
  /** 090. When THIS account dismissed it, or null. */
  readonly dismissedAt: Date | null;
}

export interface FeedListOptions {
  /** 090. Whether dismissed notices are returned. Defaults to true here; the
   *  route asks for them only when the client does. */
  readonly includeDismissed?: boolean;
}

export interface NotificationFeedRepository {
  listForUser: (
    userId: string, limit: number, options?: FeedListOptions,
  ) => Promise<FeedNotification[]>;
  /**
   * 090. Read / dismissed state on this account's OWN notices. Ids that are
   * not USER-audience notices addressed to `userId` are skipped silently.
   * Returns the number of state rows created or changed.
   */
  setStates: (
    userId: UserId, ids: readonly string[], change: MyNotificationStateChange,
  ) => Promise<number>;
}

/** No honest call names more than a feed page; the route bounds it to 100. */
const MAX_STATE_IDS_PER_CALL = 200;

/**
 * The new value of one timestamp column on conflict. Setting a flag that is
 * already set keeps its first timestamp, so a repeated "mark read" is a no-op
 * rather than a new read time.
 */
function stateColumn(flag: boolean | undefined, column: "read_at" | "dismissed_at") {
  const existing = sql.ref(`user_notification_states.${column}`);
  if (flag === undefined) return existing;
  return flag ? sql`coalesce(${existing}, now())` : sql`null`;
}

export function createNotificationFeedRepository(
  db: Kysely<Database>,
): NotificationFeedRepository {
  return {
    async listForUser(userId, limit, options = {}) {
      const includeDismissed = options.includeDismissed ?? true;
      // 087. The account's OWN realm (`lagda.user_id`, transaction-local):
      // with no context the runtime role sees no intent at all, and a notice
      // about another workspace's document is readable only through 087's
      // `notification_audience_user_read` policy, which matches this account
      // as the audience and nothing else.
      const rows = await db.transaction().execute(async trx => {
        await sql`select set_config('lagda.user_id', ${userId}, true)`.execute(trx);
        let query = trx
          .selectFrom("notification_intents as ni")
          // 090. This account's own state, and only its own: the join names
          // the user, so another account's state row can never attach.
          .leftJoin("user_notification_states as st", join => join
            .onRef("st.notification_intent_id", "=", "ni.notification_intent_id")
            .on("st.user_id", "=", userId))
          // Explicit column list. See the header: a `selectAll` here would ship
          // `sealed_secret` to a browser the first time anyone refactored.
          .select([
            "ni.notification_intent_id",
            "ni.notification_type",
            "ni.workspace_id",
            "ni.source_kind",
            "ni.source_id",
            "ni.template_input",
            "ni.created_at",
            "st.read_at",
            "st.dismissed_at",
          ])
          // The authorization boundary, not a filter.
          .where("ni.audience_kind", "=", "USER")
          .where("ni.audience_user_id", "=", userId)
          // 087. An emailed one-time code is not an in-app notice.
          .where("ni.notification_type", "not in", [...EMAIL_ONLY_TYPES]);
        // Filtered in SQL, before the limit, so hiding dismissed notices
        // never shortens a page.
        if (!includeDismissed) query = query.where("st.dismissed_at", "is", null);
        return query
          .orderBy("ni.created_at", "desc")
          .orderBy("ni.notification_intent_id", "desc")
          .limit(limit)
          .execute();
      });

      return rows.map(row => ({
        notificationIntentId: row.notification_intent_id,
        notificationType: row.notification_type,
        workspaceId: row.workspace_id,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        templateInput: row.template_input,
        createdAt: row.created_at,
        readAt: row.read_at ?? null,
        dismissedAt: row.dismissed_at ?? null,
      }));
    },

    async setStates(userId, ids, change) {
      const bounded = [...new Set(ids)].slice(0, MAX_STATE_IDS_PER_CALL);
      if (bounded.length === 0) return 0;
      if (change.read === undefined && change.dismissed === undefined) return 0;
      try {
        return await db.transaction().execute(async trx => {
          // The account's own realm, as the feed read: the SELECT below can
          // see only intents 087's audience policy matches to this account.
          await sql`select set_config('lagda.user_id', ${userId}, true)`.execute(trx);
          // INSERT ... SELECT from the intents, not INSERT ... VALUES: only ids
          // that are this account's own notices are written at all. This is
          // the ONLY existence check; there is deliberately no foreign key to
          // notification_intents (see migration 090).
          const result = await trx
            .insertInto("user_notification_states")
            .columns(["user_id", "notification_intent_id", "read_at", "dismissed_at"])
            .expression(eb => eb
              .selectFrom("notification_intents")
              .select([
                eb.val(userId as string).as("user_id"),
                "notification_intent_id",
                (change.read === true ? sql<Date>`now()` : sql<Date | null>`null`).as("read_at"),
                (change.dismissed === true ? sql<Date>`now()` : sql<Date | null>`null`).as("dismissed_at"),
              ])
              .where("audience_kind", "=", "USER")
              .where("audience_user_id", "=", userId as string)
              .where("notification_type", "not in", [...EMAIL_ONLY_TYPES])
              .where("notification_intent_id", "in", bounded))
            .onConflict(oc => oc
              .columns(["user_id", "notification_intent_id"])
              .doUpdateSet({
                read_at: stateColumn(change.read, "read_at") as never,
                dismissed_at: stateColumn(change.dismissed, "dismissed_at") as never,
                updated_at: sql`now()` as never,
              }))
            .executeTakeFirst();
          return Number(result.numInsertedOrUpdatedRows ?? 0n);
        });
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
