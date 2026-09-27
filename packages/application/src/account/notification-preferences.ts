// 084. Reading and changing the account's own notification preferences.
//
// Per ACCOUNT, not per workspace, and by the SESSION's user id only — the
// route has no `:userId`, so "user A edits user B" is not expressible.
//
// Absence is a real state: an account that never changed a switch has no
// row, and reads as every switch ON with `updatedAt: null`.

import type { UserId } from "@lagda/contracts";
import type { Clock } from "../common/ports/index.js";
import type {
  NotificationPreferenceRepository, NotificationPreferencePatch,
  NotificationPreferenceSettings,
} from "../common/ports/notification-preferences.js";
import { NOTIFICATION_PREFERENCE_CATEGORIES } from "../common/ports/notification-preferences.js";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferenceSettings = {
  signerActivity: true,
  requestCompleted: true,
  actionReminders: true,
  workspaceRequests: true,
  invitations: true,
};

export interface NotificationPreferencesView extends NotificationPreferenceSettings {
  /** Null until the account first changes a switch. */
  readonly updatedAt: number | null;
}

export interface GetNotificationPreferencesDependencies {
  readonly preferences: NotificationPreferenceRepository;
}

export interface UpdateNotificationPreferencesDependencies {
  readonly preferences: NotificationPreferenceRepository;
  readonly clock: Clock;
}

export async function getNotificationPreferences(
  userId: UserId, deps: GetNotificationPreferencesDependencies,
): Promise<NotificationPreferencesView> {
  const stored = await deps.preferences.find(userId);
  return stored === null
    ? { ...DEFAULT_NOTIFICATION_PREFERENCES, updatedAt: null }
    : pick(stored, stored.updatedAt);
}

/**
 * Applies any subset of the switches and returns the full set.
 *
 * Absent keys are left alone. An EMPTY patch writes nothing — there is no
 * change to timestamp — and returns the current state.
 */
export async function updateNotificationPreferences(
  userId: UserId,
  patch: NotificationPreferencePatch,
  deps: UpdateNotificationPreferencesDependencies,
): Promise<NotificationPreferencesView> {
  const named: { -readonly [K in keyof NotificationPreferencePatch]: boolean } = {};
  for (const category of NOTIFICATION_PREFERENCE_CATEGORIES) {
    const value = patch[category];
    if (typeof value === "boolean") named[category] = value;
  }
  if (Object.keys(named).length === 0) return getNotificationPreferences(userId, deps);

  const stored = await deps.preferences.apply(userId, named, deps.clock.now());
  return pick(stored, stored.updatedAt);
}

/** Exactly the five switches — never a stored row spread onto the wire. */
function pick(
  settings: NotificationPreferenceSettings, updatedAt: number | null,
): NotificationPreferencesView {
  return {
    signerActivity: settings.signerActivity,
    requestCompleted: settings.requestCompleted,
    actionReminders: settings.actionReminders,
    workspaceRequests: settings.workspaceRequests,
    invitations: settings.invitations,
    updatedAt,
  };
}
