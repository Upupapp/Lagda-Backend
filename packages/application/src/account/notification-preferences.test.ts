// 084. Reading and changing the account's own notification preferences.

import { describe, it, expect } from "vitest";
import type { UserId } from "@lagda/contracts";
import { fakeNotificationPreferences } from "../test-support/fakes.js";
import {
  getNotificationPreferences, updateNotificationPreferences, DEFAULT_NOTIFICATION_PREFERENCES,
} from "./notification-preferences.js";

const USER = "usr_1" as UserId;
const OTHER = "usr_2" as UserId;
const AT = 1_700_000_000_000;
const clock = { now: () => AT };

describe("notification preferences", () => {
  it("defaults to everything on, never changed, when no row exists", async () => {
    const preferences = fakeNotificationPreferences();
    await expect(getNotificationPreferences(USER, { preferences })).resolves.toEqual({
      signerActivity: true, requestCompleted: true, actionReminders: true,
      workspaceRequests: true, invitations: true, updatedAt: null,
    });
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      signerActivity: true, requestCompleted: true, actionReminders: true,
      workspaceRequests: true, invitations: true,
    });
  });

  it("applies a subset, leaves the rest alone, and returns the full set", async () => {
    const preferences = fakeNotificationPreferences();
    const first = await updateNotificationPreferences(
      USER, { requestCompleted: false }, { preferences, clock });
    expect(first).toEqual({ ...DEFAULT_NOTIFICATION_PREFERENCES, requestCompleted: false, updatedAt: AT });

    const second = await updateNotificationPreferences(
      USER, { invitations: false, requestCompleted: true }, { preferences, clock });
    expect(second).toEqual({ ...DEFAULT_NOTIFICATION_PREFERENCES, invitations: false, updatedAt: AT });

    // Only the named keys reach the repository.
    expect(preferences.writes.map(w => w.patch)).toEqual([
      { requestCompleted: false }, { invitations: false, requestCompleted: true },
    ]);
  });

  it("an empty change writes nothing and returns the current state", async () => {
    const preferences = fakeNotificationPreferences();
    await expect(updateNotificationPreferences(USER, {}, { preferences, clock }))
      .resolves.toMatchObject({ updatedAt: null });
    expect(preferences.writes).toHaveLength(0);
  });

  it("drops any key that is not one of the five switches", async () => {
    const preferences = fakeNotificationPreferences();
    const view = await updateNotificationPreferences(
      USER, { passwordReset: false, invitations: false } as never, { preferences, clock });
    expect(preferences.writes[0]?.patch).toEqual({ invitations: false });
    expect(Object.keys(view).sort()).toEqual([
      "actionReminders", "invitations", "requestCompleted", "signerActivity",
      "updatedAt", "workspaceRequests",
    ]);
  });

  it("is per account", async () => {
    const preferences = fakeNotificationPreferences();
    await updateNotificationPreferences(USER, { signerActivity: false }, { preferences, clock });
    expect((await getNotificationPreferences(OTHER, { preferences })).signerActivity).toBe(true);
    expect((await getNotificationPreferences(USER, { preferences })).signerActivity).toBe(false);
  });
});
