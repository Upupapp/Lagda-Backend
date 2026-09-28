// 090. Read and dismissed state on the account's PERSONAL feed
// (`GET /me/notifications`) — the notices addressed to the account itself.
//
// The document feed's state (071) is per workspace and keyed on evidence;
// this one is per account and keyed on the notification intent. The rules are
// the same four acts: mark read or unread, dismiss or restore.

import type { UserId } from "@lagda/contracts";
import type { DocumentNotificationStateChange } from "../common/ports/index.js";

/** One call changes at most a feed page — the most any honest client holds. */
export const MAX_MY_NOTIFICATION_STATE_IDS = 100;

/** The change: `read` and/or `dismissed`. Absent leaves that flag alone. */
export type MyNotificationStateChange = DocumentNotificationStateChange;

export interface MyNotificationStateRepository {
  /**
   * Applies `change` to those of `ids` that are notices addressed to
   * `userId`. Anything else — another account's notice, an id that does not
   * exist — is skipped without an error, so the answer never says whether a
   * foreign id is real. Returns how many rows changed or were created.
   */
  setStates: (
    userId: UserId, ids: readonly string[], change: MyNotificationStateChange,
  ) => Promise<number>;
}

export interface SetMyNotificationStateInput {
  /** The SESSION's user. Never a request field. */
  readonly userId: UserId;
  readonly ids: readonly string[];
  readonly read?: boolean;
  readonly dismissed?: boolean;
}

export type SetMyNotificationStateResult =
  | { readonly outcome: "updated"; readonly updated: number }
  /** Neither `read` nor `dismissed` was given: nothing to change. */
  | { readonly outcome: "empty-change" };

/**
 * Changes the caller's own state on their own notices.
 *
 * Ids are de-duplicated and bounded here as well as by the route's schema,
 * so a caller that is not the route cannot widen the write.
 */
export async function setMyNotificationState(
  input: SetMyNotificationStateInput,
  deps: { readonly states: MyNotificationStateRepository },
): Promise<SetMyNotificationStateResult> {
  if (input.read === undefined && input.dismissed === undefined) {
    return { outcome: "empty-change" };
  }
  const ids = [...new Set(input.ids.filter(id => id.length > 0))]
    .slice(0, MAX_MY_NOTIFICATION_STATE_IDS);
  if (ids.length === 0) return { outcome: "updated", updated: 0 };
  const change: MyNotificationStateChange = {
    ...(input.read === undefined ? {} : { read: input.read }),
    ...(input.dismissed === undefined ? {} : { dismissed: input.dismissed }),
  };
  const updated = await deps.states.setStates(input.userId, ids, change);
  return { outcome: "updated", updated };
}
