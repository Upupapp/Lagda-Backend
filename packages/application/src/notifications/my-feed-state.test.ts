// 090. The personal feed's state change: the session's user only, a bounded
// and de-duplicated id list, and an empty change refused before any write.

import { describe, it, expect } from "vitest";
import type { UserId } from "@lagda/contracts";
import {
  setMyNotificationState, MAX_MY_NOTIFICATION_STATE_IDS,
  type MyNotificationStateChange,
} from "./my-feed-state.js";

const USER = "usr_me" as UserId;

function recorder(result = 1) {
  const calls: { userId: string; ids: readonly string[]; change: MyNotificationStateChange }[] = [];
  return {
    calls,
    states: {
      setStates: (userId: UserId, ids: readonly string[], change: MyNotificationStateChange) => {
        calls.push({ userId, ids, change });
        return Promise.resolve(result);
      },
    },
  };
}

describe("setMyNotificationState", () => {
  it("refuses a change that names neither read nor dismissed, without writing", async () => {
    const r = recorder();
    await expect(setMyNotificationState({ userId: USER, ids: ["ntf_1"] }, r))
      .resolves.toEqual({ outcome: "empty-change" });
    expect(r.calls).toEqual([]);
  });

  it("passes only the flags that were given", async () => {
    const r = recorder(2);
    await expect(setMyNotificationState({ userId: USER, ids: ["a", "b"], read: true }, r))
      .resolves.toEqual({ outcome: "updated", updated: 2 });
    expect(r.calls).toEqual([{ userId: USER, ids: ["a", "b"], change: { read: true } }]);

    await setMyNotificationState({ userId: USER, ids: ["a"], dismissed: false }, r);
    expect(r.calls[1]?.change).toEqual({ dismissed: false });

    await setMyNotificationState({ userId: USER, ids: ["a"], read: false, dismissed: true }, r);
    expect(r.calls[2]?.change).toEqual({ read: false, dismissed: true });
  });

  it("de-duplicates, drops empty ids and bounds the list", async () => {
    const r = recorder();
    const many = Array.from({ length: MAX_MY_NOTIFICATION_STATE_IDS + 20 }, (_, i) => `ntf_${i}`);
    await setMyNotificationState({ userId: USER, ids: ["x", "x", "", ...many], read: true }, r);
    const ids = r.calls[0]?.ids ?? [];
    expect(ids).toHaveLength(MAX_MY_NOTIFICATION_STATE_IDS);
    expect(ids[0]).toBe("x");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes nothing when no usable id remains", async () => {
    const r = recorder();
    await expect(setMyNotificationState({ userId: USER, ids: [""], read: true }, r))
      .resolves.toEqual({ outcome: "updated", updated: 0 });
    expect(r.calls).toEqual([]);
  });
});
