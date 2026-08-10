// PostgreSQL unit of work.
//
// Three responsibilities, and they are deliberately in one place:
//
//   1. `@lagda/application` never learns what a Kysely transaction is.
//   2. A scoped transaction establishes RLS context — and only here, because
//      `SET LOCAL` issued anywhere else reopens the pooling hazard.
//   3. Every repository in one operation is built on the SAME transaction, so
//      "atomic" means atomic rather than looking like it.
//
// ── Three scopes, each asked for by name ───────────────────────────────────
//
//   runForWorkspace  tenant context. The ordinary path.
//   runForUser       the caller's own membership edges. Read-only by policy.
//   runGlobal        no context. Accounts, sessions, system records.
//
// Never one method with an optional argument. With `run(workspaceId?)`, omitting
// the argument would silently mean unrestricted access — the most dangerous
// possible default.

import { sql, type Kysely, type Transaction } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type {
  TransactionManager, WorkspaceUnitOfWork, GlobalUnitOfWork, UserUnitOfWork,
  InvitationCredentialUnitOfWork, InvitationTokenDigest,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import {
  createScopedWorkspaceRepository, createScopedMembershipRepository,
  createUserMembershipRepository,
} from "../repositories/workspaces.js";
import {
  createEvidenceRepository,
  createArtifactRepository,
  createFinalizationRepository,
} from "../repositories/evidence.js";
import { createUploadRepository } from "../repositories/uploads.js";
import { createIdempotencyRepository } from "../repositories/idempotency.js";
import {
  createScopedInvitationRepository, createInvitationCredentialLookup,
} from "../repositories/invitations.js";
import { createScopedContactRepository } from "../repositories/contacts.js";
import { createScopedDocumentRepository } from "../repositories/documents.js";
import { createScopedPreparationRepository } from "../repositories/preparation.js";
import { createScopedRecipientRepository } from "../repositories/recipients.js";

/** The setting names RLS policies read. Must match migrations 002 and 013. */
const WORKSPACE_SETTING = "lagda.workspace_id";
const USER_SETTING = "lagda.user_id";
const INVITATION_DIGEST_SETTING = "lagda.invitation_digest";

/**
 * Builds the repository set for one transaction and one workspace.
 *
 * Repositories are constructed here and nowhere else. If a caller could build
 * one independently it might hold the pool rather than this transaction, and
 * the resulting write would survive a rollback that was supposed to discard it.
 */
function buildUnitOfWork(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
): WorkspaceUnitOfWork {
  return {
    workspaceId,
    workspaces: createScopedWorkspaceRepository(trx, workspaceId),
    memberships: createScopedMembershipRepository(trx, workspaceId),
    evidence: createEvidenceRepository(trx, workspaceId),
    artifacts: createArtifactRepository(trx, workspaceId),
    finalizations: createFinalizationRepository(trx, workspaceId),
    uploads: createUploadRepository(trx, workspaceId),
    // On the SAME transaction as the business writes. That is the entire
    // idempotency guarantee: the claim commits with the mutation or dies with
    // it, so there is no lease, no reclaim job and no poisoned key.
    idempotency: createIdempotencyRepository(trx),
    invitations: createScopedInvitationRepository(trx, workspaceId),
    contacts: createScopedContactRepository(trx, workspaceId),
    documents: createScopedDocumentRepository(trx, workspaceId),
    preparations: createScopedPreparationRepository(trx, workspaceId),
    recipients: createScopedRecipientRepository(trx, workspaceId),
  };
}

export function createTransactionManager(db: Kysely<Database>): TransactionManager {
  return {
    async runForWorkspace<T>(
      workspaceId: WorkspaceId,
      operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // SET LOCAL, always — transaction-local, gone at COMMIT or ROLLBACK.
        // Session-level `SET` would ride a pooled connection into the next
        // request. Parameterized through `set_config` so a workspace ID can
        // never be concatenated into SQL, which `SET LOCAL x = '...'` cannot do.
        await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`.execute(trx);
        return operation(buildUnitOfWork(trx, workspaceId));
      });
    },

    async runForUser<T>(
      userId: UserId,
      operation: (uow: UserUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // USER context and NO workspace context. Both halves matter:
        //
        //   set    — the `member_self_read` and `member_workspace_read`
        //            policies (migration 013) can match, so the caller's own
        //            memberships and their workspaces become readable.
        //   unset  — `lagda_current_workspace()` returns NULL, so the
        //            tenant-isolation policies match nothing. Combined with
        //            those two policies being FOR SELECT, this transaction is
        //            incapable of writing to either table.
        //
        // The same transaction-local mechanism as tenant context (§89): never a
        // session-level SET, which would leak onto the next pooled request.
        await sql`select set_config(${USER_SETTING}, ${userId}, true)`.execute(trx);
        return operation({
          userId,
          memberships: createUserMembershipRepository(trx, userId),
        });
      });
    },

    async runForInvitationCredential<T>(
      tokenDigest: InvitationTokenDigest,
      operation: (uow: InvitationCredentialUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // CREDENTIAL context and no workspace context. The
        // `invitation_credential_read` policy (migration 014) matches on
        // equality against the UNIQUE digest column, so at most one row is
        // visible — and the policy is FOR SELECT, so this scope cannot write to
        // the invitations table at all until tenant context is established.
        await sql`select set_config(${INVITATION_DIGEST_SETTING}, ${tokenDigest}, true)`
          .execute(trx);

        return operation({
          invitation: createInvitationCredentialLookup(trx),

          // The tenant transition, on the SAME transaction.
          //
          // Two transactions would leave a window in which the invitation is
          // consumed and the membership is not — or the reverse. Adding tenant
          // context here means the whole acceptance ceremony commits or rolls
          // back together.
          //
          // The workspace comes from the RESOLVED invitation. There is no
          // parameter a request body could reach, which is what makes workspace
          // tampering unexpressible rather than merely rejected.
          async enterWorkspace<R>(
            workspaceId: WorkspaceId,
            inner: (uow: WorkspaceUnitOfWork) => Promise<R>,
          ): Promise<R> {
            await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`
              .execute(trx);
            return inner(buildUnitOfWork(trx, workspaceId));
          },
        });
      });
    },

    async runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
      return db.transaction().execute(async () => {
        // No tenant context, no user context and no tenant repositories. Under
        // RLS, workspace tables are invisible from here — global mode is for
        // user accounts and system records, and if it strays into tenant data
        // it fails closed rather than seeing everything.
        return operation({ scope: "global" });
      });
    },
  };
}
