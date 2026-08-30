// Folder persistence.
//
// Every write here is unconditional on the TREE: depth and cycles are decided
// in the use case, against the tree it has already read, so there is one place
// that decides rather than two that can disagree. The compound foreign key
// (workspace_id, parent_folder_id) is the backstop, not the check.

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

    async create(folder: FolderRecord): Promise<void> {
      // The scope's workspace, not the record's. A record carrying another
      // tenant's id cannot smuggle itself in through this repository.
      await trx.insertInto("document_folders").values({
        folder_id: folder.folderId,
        workspace_id: scope,
        parent_folder_id: folder.parentFolderId,
        name: folder.name,
        created_by_user_id: folder.createdByUserId,
        created_at: new Date(folder.createdAt),
        archived_at: folder.archivedAt === null ? null : new Date(folder.archivedAt),
      }).execute();
    },

    async rename(input): Promise<boolean> {
      const result = await trx.updateTable("document_folders")
        .set({ name: input.name })
        .where("workspace_id", "=", scope)
        .where("folder_id", "=", input.folderId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async setArchived(input): Promise<boolean> {
      const result = await trx.updateTable("document_folders")
        .set({ archived_at: input.archivedAt === null ? null : new Date(input.archivedAt) })
        .where("workspace_id", "=", scope)
        .where("folder_id", "=", input.folderId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
