// Signing access provisioning persistence.
//
// Three tables, one repository, because they are only ever written together:
// a grant without an intent is a credential nobody receives, and an intent
// without a grant is an email nobody can act on.

import type { Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import { RECIPIENT_WORKFLOW_STATES } from "@lagda/contracts";
import type {
  ScopedSigningAccessRepository, NewSigningAccessGrant, NewDeliveryIntent,
  RecipientActivationState,
  SigningRequestId, SigningRequestRecipientId,
  SigningAccessDigest,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

// The canonical four. Imported rather than restated: a second list here would
// be a second answer to "which states exist", and this one decides whether a
// persisted row is readable at all.
const ACTIVATION_STATES: readonly RecipientActivationState[] =
  RECIPIENT_WORKFLOW_STATES;

export function createScopedSigningAccessRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedSigningAccessRepository {
  return {
    async insertGrant(grant: NewSigningAccessGrant): Promise<void> {
      if (grant.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "SigningAccessGrant", scope, grant.workspaceId);
      }
      try {
        await trx.insertInto("signing_access_grants").values({
          grant_id: grant.grantId,
          workspace_id: grant.workspaceId,
          signing_request_id: grant.signingRequestId,
          request_recipient_id: grant.recipientId,
          // The digest. An architecture guard asserts no raw value is written
          // anywhere in this file.
          credential_digest: grant.credentialDigest,
          created_at: new Date(grant.createdAt),
          expires_at: new Date(grant.expiresAt),
          revoked_at: null,
        }).execute();
      } catch (error) {
        // A unique violation here is the one-active-grant index firing: a
        // second activation for a recipient that already holds a live
        // credential. The use case converts it; the index is what makes the
        // rule race-safe.
        throw translatePersistenceError(error);
      }
    },

    async insertDeliveryIntent(intent: NewDeliveryIntent): Promise<void> {
      if (intent.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "SigningDeliveryIntent", scope, intent.workspaceId);
      }
      try {
        await trx.insertInto("signing_delivery_intents").values({
          delivery_intent_id: intent.deliveryIntentId,
          workspace_id: intent.workspaceId,
          signing_request_id: intent.signingRequestId,
          request_recipient_id: intent.recipientId,
          grant_id: intent.grantId,
          purpose: intent.purpose,
          recipient_email: intent.recipientEmail,
          recipient_name: intent.recipientName,
          document_title: intent.documentTitle,
          sender_display_name: intent.senderDisplayName,
          workspace_name: intent.workspaceName,
          sealed_credential: intent.sealedCredential,
          sealed_key_version: intent.sealedKeyVersion,
          created_at: new Date(intent.createdAt),
          dispatched_at: null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async insertActivations(input): Promise<void> {
      if (input.activations.length === 0) return;
      try {
        await trx.insertInto("signing_request_recipient_activation").values(
          input.activations.map(activation => ({
            workspace_id: scope,
            signing_request_id: input.signingRequestId,
            request_recipient_id: activation.recipientId,
            recipient_state: activation.state,
            activated_at:
              activation.activatedAt === null ? null : new Date(activation.activatedAt),
            created_at: new Date(input.createdAt),
          })),
        ).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async listActivations(signingRequestId: SigningRequestId) {
      const rows = await trx.selectFrom("signing_request_recipient_activation")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .orderBy("request_recipient_id", "asc")
        .execute();

      return rows.map(row => ({
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        // Validated rather than cast. Persisted state is untrusted input, and
        // an unrecognised activation state would decide whether someone can
        // reach a legal document.
        state: toActivationState(row.recipient_state),
        activatedAt: row.activated_at === null ? null : row.activated_at.getTime(),
      }));
    },
  };
}

function toActivationState(value: string): RecipientActivationState {
  const found = ACTIVATION_STATES.find(candidate => candidate === value);
  if (found === undefined) {
    throw new PersistenceMappingError(
      "signing_request_recipient_activation", "recipient_state",
      `"${value}" is not an activation state.`);
  }
  return found;
}

/** Unused here; exported so the digest brand has one import site in this package. */
export type { SigningAccessDigest };
