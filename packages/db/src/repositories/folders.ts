// Folder persistence.
//
// Reads only. Creating, renaming and archiving folders are separate operations
// with their own rules -- `checkFolderPlacement` in `@lagda/core/folders`
// enforces depth and cycles -- and adding a write here without them would let a
// caller build a tree the domain forbids.

import type { Selectable, Transaction } from "kysely";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type {
  ScopedFolderRepository, FolderRecord, FolderId,
} from "@lagda/application";
import type { Database, DocumentFoldersTable } from "../schema/index.js";

type FolderRow = Selectable<DocumentFoldersTable>;

function toRecord(row: FolderRow): FolderRecord {
  return {
    folderId: row.folder_id as FolderId,
    workspaceId: row.workspace_id as WorkspaceId,
    parentFolderId: row.parent_folder_id === null
      ? null : (row.parent_folder_id as FolderId),
    name: row.name,
    createdByUserId: row.created_by_user_id as UserId,
    createdAt: row.created_at.getTime(),
    archivedAt: row.archived_at === null ? null : row.archived_at.getTime(),
  };
}

export function createScopedFolderRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedFolderRepository {
  return {
    async list(): Promise<readonly FolderRecord[]> {
      const rows = await trx.selectFrom("document_folders")
        .selectAll()
        .where("workspace_id", "=", scope)
        // Parents before children where possible, then by name. A client
        // building a tree does not depend on this, but a human reading the
        // response or a log line does.
        .orderBy("parent_folder_id", "asc")
        .orderBy("name", "asc")
        .execute();
      return rows.map(toRecord);
    },
  };
}
