// Document folders: the tree, and the two lifecycle states.
//
// The nesting arithmetic is shared with organization units — see
// `../hierarchy`. What lives here is what a FOLDER means, which is different: a
// unit is who an organization is, a folder is where a document sits.

import {
  checkPlacement, descendantIds,
  type HierarchyNode, type PlacementRejection,
} from "../hierarchy/index.js";

/**
 * How deep a filing tree may go.
 *
 * Deeper than the org chart on purpose. An org chart mirrors an institution and
 * flattens out; a filing system mirrors how people think about their work and
 * routinely goes "2026 / Contracts / Vendors / Acme / Amendments". Ten is past
 * anything observed and still short of a path nobody can read.
 */
export const MAX_FOLDER_DEPTH = 10;

export const FOLDER_NAME_MAX_LENGTH = 120;

export type FolderPlacementRejection = PlacementRejection;

export interface FolderNode {
  readonly folderId: string;
  readonly workspaceId: string;
  readonly parentFolderId: string | null;
}

const toHierarchy = (folder: FolderNode): HierarchyNode => ({
  nodeId: folder.folderId,
  workspaceId: folder.workspaceId,
  parentId: folder.parentFolderId,
});

export function checkFolderPlacement(
  folderId: string | null,
  parentFolderId: string | null,
  workspaceId: string,
  folders: readonly FolderNode[],
): FolderPlacementRejection | null {
  return checkPlacement(
    folderId, parentFolderId, workspaceId,
    folders.map(toHierarchy), MAX_FOLDER_DEPTH);
}

/**
 * Every folder at or below `rootId`, the root included.
 *
 * "Documents in this folder" means the folder and everything under it, which is
 * what somebody looking at a breadcrumb expects.
 */
export function folderSubtree(
  rootId: string,
  folders: readonly FolderNode[],
): readonly string[] {
  return descendantIds(rootId, folders.map(toHierarchy));
}

/**
 * Where a document is in its life.
 *
 * Derived from two timestamps rather than stored, so the two can never
 * disagree with a status column somebody forgot to update.
 */
export const DOCUMENT_LIFECYCLE_STATES = ["active", "archived", "trashed"] as const;
export type DocumentLifecycleState = (typeof DOCUMENT_LIFECYCLE_STATES)[number];

export function lifecycleStateOf(document: {
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
}): DocumentLifecycleState {
  // Trash wins if both are somehow set. The database forbids it with a CHECK
  // constraint; this decides rather than throws, because a read path that
  // crashes on impossible data takes down a list view for everybody.
  if (document.deletedAt !== null) return "trashed";
  if (document.archivedAt !== null) return "archived";
  return "active";
}

export type LifecycleAction = "archive" | "restore" | "trash" | "delete";

/**
 * The complete transition table. Anything absent is forbidden.
 *
 * ── Read the terminal row ──────────────────────────────────────────────────
 *
 * `trashed` can go back to `active` and nowhere else. It cannot go straight to
 * `archived`: restoring is putting something back where it was, and where it
 * was is the folder. Archiving it afterwards is a second, deliberate act.
 *
 * ── Why `delete` appears and produces nothing ──────────────────────────────
 *
 * Permanent deletion is not a state, it is the absence of a row, and it is only
 * reachable FROM trash. The handbook is explicit: do not delete permanently
 * unless the lifecycle supports it. Modelling it as a transition to a state
 * would invent a fourth state that means "gone", which is what the missing row
 * already means.
 */
const TRANSITIONS: Record<
  DocumentLifecycleState,
  Partial<Record<LifecycleAction, DocumentLifecycleState | null>>
> = {
  active: { archive: "archived", trash: "trashed" },
  archived: { restore: "active", trash: "trashed" },
  // `delete: null` -- permitted, and produces no state because the row goes.
  trashed: { restore: "active", delete: null },
};

export function canApplyLifecycle(
  from: DocumentLifecycleState,
  action: LifecycleAction,
): boolean {
  return action in TRANSITIONS[from];
}

/**
 * The state an action produces, `null` for deletion, or `undefined` when the
 * table forbids it.
 *
 * Three outcomes and they are genuinely different: a new state, no state, and
 * not allowed. Collapsing "deleted" into "not allowed" would make permanent
 * deletion look like a refusal to every caller.
 */
export function applyLifecycle(
  from: DocumentLifecycleState,
  action: LifecycleAction,
): DocumentLifecycleState | null | undefined {
  if (!canApplyLifecycle(from, action)) return undefined;
  return TRANSITIONS[from][action] ?? null;
}
