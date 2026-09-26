// 084. Which OPTIONAL emails an account wants, per account (not per
// workspace). One row per account, absent until the first change — absence
// means "everything on", never an error.
//
// Security and transactional mail is not in this vocabulary at all, so no
// switch can express "stop sending me password resets". Which notification
// types each category governs is decided in ONE table,
// `NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE` in `notifications/preferences.ts`.

import type { UserId } from "@lagda/contracts";

export const NOTIFICATION_PREFERENCE_CATEGORIES = [
  "signerActivity",
  "requestCompleted",
  "actionReminders",
  "workspaceRequests",
  "invitations",
] as const;
export type NotificationPreferenceCategory =
  (typeof NOTIFICATION_PREFERENCE_CATEGORIES)[number];

export type NotificationPreferenceSettings = {
  readonly [K in NotificationPreferenceCategory]: boolean;
};

export interface NotificationPreferenceRecord extends NotificationPreferenceSettings {
  readonly updatedAt: number;
}

/** A partial change: an ABSENT key leaves that switch as it is. */
export type NotificationPreferencePatch = Partial<NotificationPreferenceSettings>;

/**
 * The account's own row, by the SESSION's user id. Callers never pass an id
 * taken from a request.
 */
export interface NotificationPreferenceRepository {
  find(userId: UserId): Promise<NotificationPreferenceRecord | null>;
  /**
   * Applies `patch` atomically — one upsert that sets ONLY the named columns,
   * so two concurrent changes to different switches cannot overwrite each
   * other — and returns the row as stored.
   */
  apply(
    userId: UserId, patch: NotificationPreferencePatch, now: number,
  ): Promise<NotificationPreferenceRecord>;
}
