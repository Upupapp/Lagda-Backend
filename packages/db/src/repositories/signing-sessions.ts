// Recipient signing access and session persistence.
//
// Two lookup repositories on the CREDENTIAL path — no workspace context, one
// row each, `FOR SELECT` policies behind them — and one scoped write repository
// that runs after the credential has established tenant context.

import type { Transaction } from "kysely";
import type { WorkspaceId, SigningRequestState } from "@lagda/contracts";
import { SIGNING_REQUEST_STATES } from "@lagda/contracts";
import type {
  SigningAccessLookupRepository, RecipientSessionLookupRepository,
  ScopedRecipientSessionRepository, NewRecipientSigningSession,
  ResolvedSigningAccess, ResolvedRecipientSession,
  RecipientAuthenticationMethod, RecipientSessionDigest, RecipientCsrfDigest,
  RecipientSigningSessionId, SigningAccessDigest, SigningAccessGrantId,
  SigningRequestId, SigningRequestRecipientId, RecipientActivationState,
} from "@lagda/application";
import { RECIPIENT_AUTHENTICATION_METHODS } from "@lagda/application";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

const ACTIVATION_STATES: readonly RecipientActivationState[] = ["waiting", "active"];

function oneOf<T extends string>(
  allowed: readonly T[], table: string, column: string, value: string,
): T {
  const found = allowed.find(candidate => candidate === value);
  if (found === undefined) {
    throw new PersistenceMappingError(table, column, `"${value}" is not permitted here.`);
  }
  return found;
}

/**
 * Resolves a bootstrap credential.
 *
 * ── One query, four tables, and every join is the policy's own ─────────────
 *
 * The RLS policies from migration 021 make each of these tables show exactly
 * the row this credential names. The joins here are not the security boundary —
 * they are how the four rows arrive together — but they are written to match
 * the policies exactly, so a reader can see that no wider set is reachable.
 *
 * LEFT JOIN on activation deliberately: send writes a row for every recipient,
 * but a grant that somehow predates one must resolve to "not eligible" rather
 * than to nothing at all, so the caller can distinguish it from an unknown
 * credential.
 */
export function createSigningAccessLookupRepository(
  trx: Transaction<Database>,
): SigningAccessLookupRepository {
  return {
    async findByCredentialDigest(digest: SigningAccessDigest) {
      const row = await trx.selectFrom("signing_access_grants as g")
        .innerJoin("signing_requests as r", join => join
          .onRef("r.workspace_id", "=", "g.workspace_id")
          .onRef("r.signing_request_id", "=", "g.signing_request_id"))
        .innerJoin("signing_request_recipients as p", join => join
          .onRef("p.workspace_id", "=", "g.workspace_id")
          .onRef("p.signing_request_id", "=", "g.signing_request_id")
          .onRef("p.request_recipient_id", "=", "g.request_recipient_id"))
        .leftJoin("signing_request_recipient_activation as a", join => join
          .onRef("a.workspace_id", "=", "g.workspace_id")
          .onRef("a.signing_request_id", "=", "g.signing_request_id")
          .onRef("a.request_recipient_id", "=", "g.request_recipient_id"))
        .select([
          "g.grant_id", "g.workspace_id", "g.signing_request_id",
          "g.request_recipient_id", "g.expires_at", "g.revoked_at",
          "r.state", "r.document_title",
          "p.name", "p.email",
          "a.recipient_state",
        ])
        .where("g.credential_digest", "=", digest)
        .executeTakeFirst();

      if (row === undefined) return null;

      return {
        grantId: row.grant_id as SigningAccessGrantId,
        workspaceId: row.workspace_id as WorkspaceId,
        signingRequestId: row.signing_request_id as SigningRequestId,
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        grantExpiresAt: row.expires_at.getTime(),
        grantRevokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(),
        requestState: oneOf<SigningRequestState>(
          SIGNING_REQUEST_STATES, "signing_requests", "state", row.state),
        documentTitle: row.document_title,
        recipientName: row.name,
        recipientEmail: row.email,
        activationState: row.recipient_state === null
          ? null
          : oneOf<RecipientActivationState>(
              ACTIVATION_STATES, "signing_request_recipient_activation",
              "recipient_state", row.recipient_state),
      } satisfies ResolvedSigningAccess;
    },
  };
}

/** Resolves an established session's cookie. Same narrow shape. */
export function createRecipientSessionLookupRepository(
  trx: Transaction<Database>,
): RecipientSessionLookupRepository {
  return {
    async findByTokenDigest(digest: RecipientSessionDigest) {
      const row = await trx.selectFrom("recipient_signing_sessions")
        .selectAll()
        .where("token_digest", "=", digest)
        .executeTakeFirst();
      if (row === undefined) return null;

      return {
        signingSessionId: row.signing_session_id as RecipientSigningSessionId,
        workspaceId: row.workspace_id as WorkspaceId,
        signingRequestId: row.signing_request_id as SigningRequestId,
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        sourceGrantId: row.source_grant_id as SigningAccessGrantId,
        csrfTokenDigest: row.csrf_token_digest as RecipientCsrfDigest,
        authenticationMethod: oneOf<RecipientAuthenticationMethod>(
          RECIPIENT_AUTHENTICATION_METHODS, "recipient_signing_sessions",
          "authentication_method", row.authentication_method),
        authenticatedAt: row.authenticated_at.getTime(),
        expiresAt: row.expires_at.getTime(),
        revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(),
      } satisfies ResolvedRecipientSession;
    },
  };
}

/** Writing a session. Runs only after the credential established tenant context. */
export function createScopedRecipientSessionRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedRecipientSessionRepository {
  return {
    async insert(session: NewRecipientSigningSession): Promise<void> {
      if (session.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "RecipientSigningSession", scope, session.workspaceId);
      }
      try {
        await trx.insertInto("recipient_signing_sessions").values({
          signing_session_id: session.signingSessionId,
          workspace_id: session.workspaceId,
          signing_request_id: session.signingRequestId,
          request_recipient_id: session.recipientId,
          source_grant_id: session.sourceGrantId,
          // Digests. The raw values went to the browser and nowhere else.
          token_digest: session.tokenDigest,
          csrf_token_digest: session.csrfTokenDigest,
          authentication_method: session.authenticationMethod,
          authenticated_at: new Date(session.authenticatedAt),
          created_at: new Date(session.createdAt),
          expires_at: new Date(session.expiresAt),
          revoked_at: null,
          revocation_reason: null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async revoke(input) {
      try {
        const revoked = await trx.updateTable("recipient_signing_sessions")
          .set({
            revoked_at: new Date(input.now),
            revocation_reason: input.reason,
          })
          .where("workspace_id", "=", scope)
          .where("signing_session_id", "=", input.signingSessionId)
          // Already-revoked stays revoked with its original reason. A second
          // revocation must not rewrite why the first happened.
          .where("revoked_at", "is", null)
          .executeTakeFirst();
        return Number(revoked.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
