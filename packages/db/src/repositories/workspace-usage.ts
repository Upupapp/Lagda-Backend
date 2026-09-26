// A workspace's usage counts. Read-only, on the unit of work's transaction.
//
// Every query names `workspace_id = :scope` explicitly AND runs under the
// transaction's tenant context, so row-level security would hide another
// workspace's rows even if a predicate were ever dropped. One statement, so
// the figures are taken at one instant and agree with each other.

import { sql, type Kysely, type Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type { ScopedWorkspaceUsageRepository } from "@lagda/application";
import type { Database } from "../schema/index.js";

type Db = Kysely<Database> | Transaction<Database>;

/** Sent and not yet finished. `completion-ready` is still being sealed. */
const IN_PROGRESS_STATES = ["sent", "partially-completed", "completion-ready"] as const;

interface UsageRow {
  documents_total: string;
  documents_this_month: string;
  sent_this_month: string;
  sent_total: string;
  in_progress: string;
  completed_this_month: string;
  completed_total: string;
  members: string;
  templates: string;
  contacts: string;
  storage_bytes: string;
}

export function createScopedWorkspaceUsageRepository(
  db: Db, workspaceId: WorkspaceId,
): ScopedWorkspaceUsageRepository {
  return {
    async summarize({ periodStart, periodEndExclusive, callerUserId }) {
      const from = new Date(periodStart);
      const to = new Date(periodEndExclusive);
      const inProgress = sql.join(IN_PROGRESS_STATES.map(state => sql.lit(state)), sql`, `);

      const result = await sql<UsageRow>`
        select
          (select count(*) from documents d
             where d.workspace_id = ${workspaceId} and d.deleted_at is null)       as documents_total,
          (select count(*) from documents d
             where d.workspace_id = ${workspaceId}
               and d.created_at >= ${from} and d.created_at < ${to})              as documents_this_month,
          (select count(*) from signing_requests sr
             where sr.workspace_id = ${workspaceId}
               and sr.sent_at >= ${from} and sr.sent_at < ${to})                  as sent_this_month,
          (select count(*) from signing_requests sr
             where sr.workspace_id = ${workspaceId} and sr.sent_at is not null)  as sent_total,
          (select count(*) from signing_requests sr
             where sr.workspace_id = ${workspaceId}
               and sr.state in (${inProgress}))                                   as in_progress,
          (select count(*) from signing_requests sr
             where sr.workspace_id = ${workspaceId} and sr.state = 'completed'
               and sr.completed_at >= ${from} and sr.completed_at < ${to})        as completed_this_month,
          (select count(*) from signing_requests sr
             where sr.workspace_id = ${workspaceId} and sr.state = 'completed')  as completed_total,
          (select count(*) from workspace_memberships m
             where m.workspace_id = ${workspaceId})                               as members,
          (select count(*) from workspace_workflow_templates t
             where t.workspace_id = ${workspaceId})                               as templates,
          (select count(*) from contacts c
             where c.workspace_id = ${workspaceId} and c.archived_at is null
               and (c.scope = 'workspace'
                    or (c.scope = 'personal' and c.owner_user_id = ${callerUserId})))
                                                                                  as contacts,
          (select coalesce(sum(a.size_bytes), 0) from document_artifacts a
             where a.workspace_id = ${workspaceId})                               as storage_bytes
      `.execute(db);

      const row = result.rows[0];
      if (row === undefined) throw new Error("usage summary returned no row");
      const n = (value: string) => Number(value);
      return {
        documents: { total: n(row.documents_total), uploadedThisMonth: n(row.documents_this_month) },
        signingRequests: {
          sentThisMonth: n(row.sent_this_month),
          sentTotal: n(row.sent_total),
          inProgress: n(row.in_progress),
          completedThisMonth: n(row.completed_this_month),
          completedTotal: n(row.completed_total),
        },
        members: n(row.members),
        templates: n(row.templates),
        contacts: n(row.contacts),
        storageBytes: n(row.storage_bytes),
      };
    },
  };
}
