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
  SigningCredentialUnitOfWork, RecipientWorkspaceUnitOfWork,
  RecipientSessionUnitOfWork, SigningAccessDigest, RecipientSessionDigest,
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
import { createScopedSigningRequestRepository } from "../repositories/signing-requests.js";
import { createScopedSigningAccessRepository } from "../repositories/signing-access.js";
import { createRecipientCeremonyRepository } from "../repositories/signing-ceremony.js";
import { createRecipientSubmissionRepository } from "../repositories/signing-submission.js";
import type {
  RecipientCeremonyUnitOfWork, SigningRequestId, SigningRequestRecipientId,
} from "@lagda/application";
import {
  createSigningAccessLookupRepository, createRecipientSessionLookupRepository,
  createScopedRecipientSessionRepository,
} from "../repositories/signing-sessions.js";
import {
  createRecipientWorkflowRepository, createScopedSigningWorkflowRepository,
  createSigningWorkflowReconciliationRepository,
} from "../repositories/signing-workflow.js";
import {
  createScopedCompletionRepository, createCompletionReconciliationRepository,
} from "../repositories/completion.js";

/** The setting names RLS policies read. Must match migrations 002 and 013. */
const WORKSPACE_SETTING = "lagda.workspace_id";
const USER_SETTING = "lagda.user_id";
const INVITATION_DIGEST_SETTING = "lagda.invitation_digest";
/** BACKEND-34. A signing bootstrap credential, resolving its own workspace. */
const SIGNING_ACCESS_DIGEST_SETTING = "lagda.signing_access_digest";
/** BACKEND-34. An established recipient session cookie. A THIRD realm. */
const RECIPIENT_SESSION_DIGEST_SETTING = "lagda.recipient_session_digest";

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
    signingRequests: createScopedSigningRequestRepository(trx, workspaceId),
    signingAccess: createScopedSigningAccessRepository(trx, workspaceId),
    signingWorkflow: createScopedSigningWorkflowRepository(trx, workspaceId),
    completion: createScopedCompletionRepository(trx, workspaceId),
    completionReconciliation:
      createCompletionReconciliationRepository(trx, workspaceId),
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

    async runForSigningCredential<T>(
      credentialDigest: SigningAccessDigest,
      operation: (uow: SigningCredentialUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // The same shape `runForInvitationCredential` established, for the same
        // reason: a recipient has no workspace context, so the credential must
        // supply one.
        //
        // The `signing_access_credential_read` policy (migration 021) matches
        // equality on the UNIQUE digest column, so at most one grant is
        // visible — and the three companion policies show only the request,
        // the ONE recipient and the ONE activation row that grant names.
        //
        // Every policy is FOR SELECT. This scope cannot write anything until
        // tenant context is established below.
        await sql`select set_config(${SIGNING_ACCESS_DIGEST_SETTING}, ${credentialDigest}, true)`
          .execute(trx);

        return operation({
          access: createSigningAccessLookupRepository(trx),

          // The tenant transition, on the SAME transaction. Two transactions
          // would leave a window in which a session exists and the grant it
          // came from has been revoked.
          //
          // The workspace comes from the RESOLVED grant. There is no parameter
          // a request body could reach, which is what makes workspace tampering
          // unexpressible rather than merely rejected.
          async enterWorkspace<R>(
            workspaceId: WorkspaceId,
            inner: (uow: RecipientWorkspaceUnitOfWork) => Promise<R>,
          ): Promise<R> {
            await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`
              .execute(trx);
            // A NARROW unit of work. Not `buildUnitOfWork` — a recipient has no
            // business reaching contacts, documents, memberships or
            // preparations, and the way to guarantee that is not to hand them
            // over.
            return inner({
              workspaceId,
              recipientSessions:
                createScopedRecipientSessionRepository(trx, workspaceId),
            });
          },
        });
      });
    },

    async runForRecipientSession<T>(
      sessionDigest: RecipientSessionDigest,
      operation: (uow: RecipientSessionUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return db.transaction().execute(async trx => {
        // A THIRD credential realm, with its own setting. A bootstrap
        // credential and a session cookie must never resolve through the same
        // door: one travels in an email that may be forwarded, the other is
        // HttpOnly and same-site.
        await sql`select set_config(${RECIPIENT_SESSION_DIGEST_SETTING}, ${sessionDigest}, true)`
          .execute(trx);
        return operation({
          session: createRecipientSessionLookupRepository(trx),

          // The tenant transition, on the SAME transaction, exactly as the
          // credential scope does it.
          //
          // The scope comes from the RESOLVED session, so there is no
          // parameter a request body could reach. With both settings live,
          // migration 022's restrictive policies bind every ceremony read to
          // this one recipient - tenant isolation alone would not, because
          // permissive policies OR together.
          async enterWorkspace<R>(
            scope: {
              readonly workspaceId: WorkspaceId;
              readonly signingRequestId: SigningRequestId;
              readonly recipientId: SigningRequestRecipientId;
            },
            inner: (uow: RecipientCeremonyUnitOfWork) => Promise<R>,
          ): Promise<R> {
            await sql`select set_config(${WORKSPACE_SETTING}, ${scope.workspaceId}, true)`
              .execute(trx);
            return inner({
              workspaceId: scope.workspaceId,
              signingRequestId: scope.signingRequestId,
              recipientId: scope.recipientId,
              ceremony: createRecipientCeremonyRepository(trx, scope),
              submissions: createRecipientSubmissionRepository(trx, scope),
              // BACKEND-37. The recipient's OWN state, committing with their
              // submission. It can reach no other recipient - by migration
              // 024's restrictive policy and by having no method that could.
              workflow: createRecipientWorkflowRepository(trx, scope),
              // The idempotency framework, on the SAME transaction. A key
              // completed in a different transaction from the mutation it
              // guards would replay a submission that rolled back.
              idempotency: createIdempotencyRepository(trx),
            });
          },
        });
      });
    },

    async runGlobal<T>(operation: (uow: GlobalUnitOfWork) => Promise<T>): Promise<T> {
      return db.transaction().execute(async trx => {
        // No tenant context, no user context and no tenant repositories. Under
        // RLS, workspace tables are invisible from here — global mode is for
        // user accounts and system records, and if it strays into tenant data
        // it fails closed rather than seeing everything.
        return operation({
          scope: "global",
          // Identifiers only, from the one table that carries no policy
          // because a cross-tenant scan cannot have one without BYPASSRLS.
          signingWorkflowReconciliation:
            createSigningWorkflowReconciliationRepository(trx),
        });
      });
    },
  };
}
