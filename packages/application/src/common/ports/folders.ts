// Folder persistence.
//
// Folders were created by migration 040 and the placement rules live in
// `@lagda/core/folders`. Neither had a repository, a use case or a route, so a
// workspace could not list the folders it already had -- which is why the web
// client's folder filter has nothing to populate itself with.
//
// A document is in ONE folder. Filing is not tagging, and the model is a tree
// with a breadcrumb, so this port carries no membership table.

import type { WorkspaceId, UserId } from "@lagda/contracts";

export type FolderId = string & { readonly __brand: "FolderId" };

export interface FolderRecord {
  readonly folderId: FolderId;
  readonly workspaceId: WorkspaceId;
  /** NULL is the workspace root. There is one root and it is the absence of a parent. */
  readonly parentFolderId: FolderId | null;
  readonly name: string;
  readonly createdByUserId: UserId;
  readonly createdAt: number;
  /**
   * Archived, never dropped.
   *
   * Documents reference folders, and a folder that vanished would strand every
   * document filed in it.
   */
  readonly archivedAt: number | null;
}

export interface ScopedFolderRepository {
  /**
   * Every folder in the workspace, including archived ones.
   *
   * The WHOLE tree in one call rather than a page: a folder list is a
   * navigation tree, and a client cannot render a breadcrumb from a page of
   * nodes whose parents may be on another page. Folder counts are small by
   * construction -- `MAX_FOLDER_DEPTH` is 10 and a workspace files documents,
   * not folders.
   *
   * Archived ones are included and flagged rather than filtered here. A client
   * showing "where is this document" needs the folder even when it has been
   * archived, and a caller that wants only live folders can say so.
   */
  list(): Promise<readonly FolderRecord[]>;
}
