// Final-copy download grants (073). Shaped like `signing-access.ts`, in its
// own file so the digest-only rule and the realm are checked separately.

import type { Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type {
  ScopedFinalCopyRepository, NewFinalCopyGrant,
  FinalCopyCredentialLookupRepository, ResolvedFinalCopyGrant,
  FinalCopyGrantId, SigningRequestId, SigningRequestRecipientId,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

export function createScopedFinalCopyRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedFinalCopyRepository {
  return {
    async insertGrant(grant: NewFinalCopyGrant): Promise<boolean> {
      if (grant.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("FinalCopyGrant", scope, grant.workspaceId);
      }
      try {
        // ON CONFLICT on the one-per-recipient key: a re-driven completion
        // converges on the grant that exists rather than minting a second key.
        const result = await trx.insertInto("final_copy_grants").values({
          grant_id: grant.grantId,
          workspace_id: grant.workspaceId,
          signing_request_id: grant.signingRequestId,
          request_recipient_id: grant.recipientId,
          // The DIGEST. Never the raw credential.
          credential_digest: grant.credentialDigest,
          created_at: new Date(grant.createdAt),
          expires_at: new Date(grant.expiresAt),
          revoked_at: null,
        })
          .onConflict(oc => oc
            .columns(["workspace_id", "signing_request_id", "request_recipient_id"])
            .doNothing())
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async isGrantUsable(grantId: string, now: number) {
      const row = await trx.selectFrom("final_copy_grants")
        .select("grant_id")
        .where("grant_id", "=", grantId)
        .where("workspace_id", "=", scope)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", new Date(now))
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

/**
 * The credential realm's one read. The `final_copy_credential_read` policy
 * shows exactly the grant whose digest was set on this transaction; the
 * WHERE says the same thing again so a mis-set policy still cannot widen it.
 */
export function createFinalCopyLookupRepository(
  trx: Transaction<Database>,
): FinalCopyCredentialLookupRepository {
  return {
    async findByCredentialDigest(digest): Promise<ResolvedFinalCopyGrant | null> {
      const row = await trx.selectFrom("final_copy_grants")
        .select([
          "grant_id", "workspace_id", "signing_request_id", "request_recipient_id",
          "expires_at", "revoked_at",
        ])
        .where("credential_digest", "=", digest)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        grantId: row.grant_id as FinalCopyGrantId,
        workspaceId: row.workspace_id as WorkspaceId,
        signingRequestId: row.signing_request_id as SigningRequestId,
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        expiresAt: row.expires_at.getTime(),
        revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(),
      };
    },
  };
}
