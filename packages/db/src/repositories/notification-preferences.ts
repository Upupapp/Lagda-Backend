// 084. An account's notification preferences. Read and written only by the
// account itself — callers pass the SESSION's user id, never one from a
// request — and read by intent creation in the producer's transaction.
//
// No row-level security (see the migration's header): the table is keyed by
// the account, like `user_avatars`, and the WHERE on `user_id` is the scope.

import type { Kysely, Transaction } from "kysely";
import type {
  NotificationPreferenceRepository, NotificationPreferenceRecord,
  NotificationPreferenceCategory, NotificationPreferencePatch,
} from "@lagda/application";
import type { UserId } from "@lagda/contracts";
import type { Database, UserNotificationPreferencesTable } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";

type PreferenceColumn = Exclude<keyof UserNotificationPreferencesTable, "user_id" | "updated_at">;

/** The one place a category is spelled as a column. */
export const PREFERENCE_COLUMN: Readonly<Record<NotificationPreferenceCategory, PreferenceColumn>> = {
  signerActivity: "signer_activity",
  requestCompleted: "request_completed",
  actionReminders: "action_reminders",
  workspaceRequests: "workspace_requests",
  invitations: "invitations",
};

const CATEGORIES = Object.keys(PREFERENCE_COLUMN) as NotificationPreferenceCategory[];

/**
 * Whether `userId` switched `category` off. False when there is no row.
 *
 * Shared by the preference repository and the notification repository, so the
 * answer intent creation acts on and the answer the settings page shows are
 * the same query.
 */
export async function isNotificationCategoryMuted(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
  category: NotificationPreferenceCategory,
): Promise<boolean> {
  const column = PREFERENCE_COLUMN[category];
  const row = await db.selectFrom("user_notification_preferences")
    .select(column)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  // Only an explicit FALSE mutes. No row, or a TRUE, is "send".
  return row !== undefined && (row as Record<PreferenceColumn, boolean>)[column] === false;
}

export function createNotificationPreferenceRepository(
  db: Kysely<Database> | Transaction<Database>,
): NotificationPreferenceRepository {
  const toRecord = (row: {
    signer_activity: boolean; request_completed: boolean; action_reminders: boolean;
    workspace_requests: boolean; invitations: boolean; updated_at: Date;
  }): NotificationPreferenceRecord => ({
    signerActivity: row.signer_activity,
    requestCompleted: row.request_completed,
    actionReminders: row.action_reminders,
    workspaceRequests: row.workspace_requests,
    invitations: row.invitations,
    updatedAt: row.updated_at.getTime(),
  });

  return {
    async find(userId: UserId) {
      const row = await db.selectFrom("user_notification_preferences")
        .select([
          "signer_activity", "request_completed", "action_reminders",
          "workspace_requests", "invitations", "updated_at",
        ])
        .where("user_id", "=", userId as string)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async apply(userId: UserId, patch: NotificationPreferencePatch, now: number) {
      // Only the NAMED columns, in both the insert and the conflict update:
      // an unnamed switch keeps its column default on the first write and its
      // stored value on every later one. One statement, so two concurrent
      // changes to different switches both land.
      const set: Partial<Record<PreferenceColumn, boolean>> = {};
      for (const category of CATEGORIES) {
        const value = patch[category];
        if (value !== undefined) set[PREFERENCE_COLUMN[category]] = value;
      }
      const updatedAt = new Date(now);
      try {
        const row = await db.insertInto("user_notification_preferences")
          .values({ user_id: userId as string, ...set, updated_at: updatedAt })
          .onConflict(oc => oc.column("user_id").doUpdateSet({ ...set, updated_at: updatedAt }))
          .returning([
            "signer_activity", "request_completed", "action_reminders",
            "workspace_requests", "invitations", "updated_at",
          ])
          .executeTakeFirstOrThrow();
        return toRecord(row);
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
