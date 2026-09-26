// Document persistence.
//
// Metadata only. This repository never touches bytes, never resolves a storage
// key, and never imports a PDF library — the artifact repository owns all three.

import type { Selectable, Transaction } from "kysely";
import type { DocumentId, UserId, WorkspaceId } from "@lagda/contracts";
import type {
  ScopedDocumentRepository, DocumentRecord, NewDocument,
  DocumentListQuery, DocumentPage,
} from "@lagda/application";
import type { Database, DocumentsTable } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type DocumentRow = Selectable<DocumentsTable>;

/**
 * Escapes the LIKE metacharacters so a typed `%` means a literal `%`.
 *
 * Without it a search for `%` matches every document in the workspace, and one
 * for `_` matches every single-character difference.
 *
 * Note what this is NOT: it is not SQL-injection defence. The value is a bound
 * parameter and was never interpolated. This is pattern escaping inside an
 * already-safe parameter -- a different and less famous problem.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, match => `\\${match}`);
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    documentId: row.document_id as DocumentId,
    workspaceId: row.workspace_id as WorkspaceId,
    title: row.title,
    originalFilename: row.original_filename,
    createdByUserId: row.created_by_user_id as UserId,
    folderId: row.folder_id,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

const SORT_COLUMNS = {
  createdAt: "created_at",
  title: "title",
} as const;

export function createScopedDocumentRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedDocumentRepository {
  const scoped = () => trx.selectFrom("documents").where("workspace_id", "=", scope);

  return {
    async insert(document: NewDocument): Promise<void> {
      if (document.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("Document", scope, document.workspaceId);
      }
      try {
        // Every column named. A spread would carry any property the record
        // gained later, including computed ones with no column.
        await trx.insertInto("documents").values({
          document_id: document.documentId,
          workspace_id: document.workspaceId,
          title: document.title,
          original_filename: document.originalFilename,
          created_by_user_id: document.createdByUserId,
          created_at: new Date(document.createdAt),
          // Equal to `created_at` on insert. One column answers both "never
          // renamed" and "renamed at T", and a nullable one would leave a new
          // document in an undefined position under any sort that used it.
          updated_at: new Date(document.createdAt),
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async verificationIdsFor(documentIds: readonly DocumentId[]) {
      const found = new Map<DocumentId, string>();
      if (documentIds.length === 0) return found;
      // Scoped by workspace AND by RLS. Oldest first, so the most recent
      // completion of a document overwrites any earlier one.
      const rows = await trx.selectFrom("verification_records")
        .where("workspace_id", "=", scope)
        .where("document_id", "in", [...documentIds])
        .select(["document_id", "verification_id"])
        .orderBy("completed_at").orderBy("verification_id")
        .execute();
      for (const row of rows) found.set(row.document_id as DocumentId, row.verification_id);
      return found;
    },

    async findById(documentId: DocumentId) {
      const row = await scoped()
        .selectAll()
        .where("document_id", "=", documentId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list(query: DocumentListQuery): Promise<DocumentPage> {
      const column = SORT_COLUMNS[query.sort];

      // Built once and reused by the page AND the count, so the two can never
      // apply different filters. A count that disagrees with its page produces
      // pagination that runs off the end or stops early.
      const filtered = <T extends ReturnType<typeof scoped>>(builder: T) => {
        let next = builder;
        if (query.search !== null) {
          // ILIKE, so a search for `retainer` finds `Retainer Agreement`.
          next = next.where(
            "title", "ilike", `%${escapeLikePattern(query.search)}%`) as T;
        }
        if (query.folderId !== null) {
          next = next.where("folder_id", "=", query.folderId) as T;
        }
        return next;
      };

      const rows = await filtered(scoped())
        .selectAll()
        .orderBy(column, query.direction)
        // The tie-breaker, always. Without it two documents sharing a title —
        // or a created_at, since a batch upload writes several in one
        // transaction — have an unspecified relative order, and PostgreSQL may
        // return them differently on page 1 and page 2. That silently drops
        // rows from a paginated listing and duplicates others.
        .orderBy("document_id", "desc")
        .offset(query.offset)
        .limit(query.limit)
        .execute();

      const counted = await filtered(scoped())
        .select(eb => eb.fn.countAll<string>().as("total"))
        .executeTakeFirstOrThrow();

      return { items: rows.map(toRecord), total: Number(counted.total) };
    },

    async file(input) {
      // The workspace predicate is not redundant with RLS: it makes a
      // cross-tenant write a zero-row no-op rather than something RLS has to
      // refuse, and it is the same shape as every other mutation here.
      const result = await trx.updateTable("documents")
        .set({ folder_id: input.folderId, updated_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("document_id", "=", input.documentId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async rename(input) {
      // ONE column, plus the timestamp. Not a patch object — see the port.
      const result = await trx.updateTable("documents")
        .set({ title: input.title, updated_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("document_id", "=", input.documentId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async recordOriginalFilename(input) {
      const result = await trx.updateTable("documents")
        .set({
          original_filename: input.originalFilename,
          updated_at: new Date(input.now),
        })
        .where("workspace_id", "=", scope)
        .where("document_id", "=", input.documentId)
        // Write-once. A second upload cannot rewrite the provenance of the
        // first, and the conditional is what makes that true under concurrency
        // rather than only when the code path is read in order.
        .where("original_filename", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
