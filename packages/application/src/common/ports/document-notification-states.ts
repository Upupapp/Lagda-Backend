// Per-user read and dismissed state for the document notification feed (071).
//
// Written by the reader, about themselves, and nothing else. It is not
// evidence and must not become any — who opened a notification is not a fact
// about the document it describes.

import type { UserId } from "@lagda/contracts";

export interface DocumentNotificationState {
  readonly read: boolean;
  readonly dismissed: boolean;
}

/** What to change. An absent key leaves that half of the state alone. */
export interface DocumentNotificationStateChange {
  readonly read?: boolean;
  readonly dismissed?: boolean;
}

export interface ScopedDocumentNotificationStateRepository {
  /**
   * This user's state for each of `eventIds` in this workspace. An id with no
   * row is absent from the map — the caller reads that as unread and not
   * dismissed. An empty input is a no-op, not a query for every row.
   */
  readonly listStates: (
    userId: UserId, eventIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DocumentNotificationState>>;
  /**
   * Applies `change` to each id for this user. An id that is not a real
   * evidence event in this workspace is skipped rather than refused, so a
   * stale client cannot fail the whole call. Returns how many ids were
   * affected.
   */
  readonly setState: (
    userId: UserId, eventIds: readonly string[], change: DocumentNotificationStateChange,
  ) => Promise<number>;
}
