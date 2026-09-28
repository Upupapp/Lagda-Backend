// Invitation persistence.
//
// Every state transition is a CONDITIONAL UPDATE whose WHERE clause names the
// four terminal timestamps. That is not defensive styling — it is the
// concurrency control. `SELECT` then `UPDATE` lets two concurrent acceptances
// both observe a pending invitation and both proceed; here the second matches
// zero rows and the caller learns it lost.

import { sql, type RawBuilder, type Transaction } from "kysely";
import type {
  UserId, WorkspaceId, WorkspaceInvitationId, InvitableWorkspaceRole,
} from "@lagda/contracts";
import { INVITABLE_WORKSPACE_ROLES } from "@lagda/contracts";
import type {
  ScopedInvitationRepository, InvitationCredentialLookup,
  WorkspaceInvitationRecord, NewWorkspaceInvitation,
  NormalizedEmail, InviteeInbox,
} from "@lagda/application";
import { assertNormalized, ResourceConflictError } from "@lagda/application";
import type { Database, WorkspaceInvitationsTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import {
  WorkspaceScopeMismatchError, translatePersistenceError, UniqueConstraintViolation,
} from "../errors.js";
import type { Selectable } from "kysely";

type InvitationRow = Selectable<WorkspaceInvitationsTable>;

/** 089. The domain prefix of an invitee digest. Must match migration 089. */
const INVITEE_DIGEST_DOMAIN = "lagda.workspace-invitee:";

/**
 * 089. SQL for the invitee digest of a normalized address — the same
 * expression migration 089's trigger computes for the stored column.
 */
export function inviteeDigestSql(normalizedEmail: string): RawBuilder<string> {
  return sql<string>`encode(sha256(convert_to(${INVITEE_DIGEST_DOMAIN + normalizedEmail}, 'UTF8')), 'hex')`;
}

/**
 * Validated rather than cast.
 *
 * `row.requested_role as InvitableWorkspaceRole` would accept whatever the
 * column happens to hold. The CHECK constraint makes that unlikely; this makes
 * it impossible to pass silently if the constraint is ever dropped or predates
 * a new value.
 */
function toInvitableRole(value: string): InvitableWorkspaceRole {
  const role = INVITABLE_WORKSPACE_ROLES.find(candidate => candidate === value);
  if (role === undefined) {
    throw new PersistenceMappingError(
      "workspace_invitations", "requested_role",
      `"${value}" is not an invitable role.`,
    );
  }
  return role;
}

const instant = (value: Date | null): number | null =>
  value === null ? null : value.getTime();

function toRecord(row: InvitationRow): WorkspaceInvitationRecord {
  return {
    invitationId: row.invitation_id as WorkspaceInvitationId,
    workspaceId: row.workspace_id as WorkspaceId,
    inviteeEmail: row.invitee_email,
    // Re-asserted, not cast. The column has a CHECK that it is lower case, and
    // this is the boundary that would notice if it ever were not.
    inviteeNormalizedEmail: assertNormalized(row.invitee_normalized_email),
    requestedRole: toInvitableRole(row.requested_role),
    invitedByUserId: row.invited_by_user_id as UserId,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    acceptedAt: instant(row.accepted_at),
    acceptedByUserId: row.accepted_by_user_id as UserId | null,
    revokedAt: instant(row.revoked_at),
    declinedAt: instant(row.declined_at),
    declineReason: row.decline_reason,
    supersededAt: instant(row.superseded_at),
  };
}

/**
 * The "still live" predicate, in one place.
 *
 * Four terminal timestamps, all null. It matches the partial unique index
 * exactly, and writing it once is what stops the index and the transitions
 * disagreeing about what "active" means.
 *
 * Deliberately does NOT test `expires_at`. Expiry is a domain judgement made
 * against the application clock (`isInvitationRedeemable`), and putting `now()`
 * in a SQL predicate here would give two different answers to one question —
 * one from the database's clock and one from the application's.
 */
const LIVE = sql<boolean>`
  accepted_at is null
  and revoked_at is null
  and declined_at is null
  and superseded_at is null
`;

export function createScopedInvitationRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedInvitationRepository {
  const scoped = () =>
    trx.selectFrom("workspace_invitations").selectAll().where("workspace_id", "=", scope);

  return {
    async insert(invitation: NewWorkspaceInvitation): Promise<void> {
      if (invitation.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "WorkspaceInvitation", scope, invitation.workspaceId);
      }
      try {
        // Every column named. A spread would carry along any property the
        // record gained later, including computed ones with no column.
        await trx.insertInto("workspace_invitations").values({
          invitation_id: invitation.invitationId,
          workspace_id: invitation.workspaceId,
          invitee_email: invitation.inviteeEmail,
          invitee_normalized_email: invitation.inviteeNormalizedEmail,
          requested_role: invitation.requestedRole,
          invited_by_user_id: invitation.invitedByUserId,
          token_digest: invitation.tokenDigest,
          created_at: new Date(invitation.createdAt),
          expires_at: new Date(invitation.expiresAt),
          accepted_at: null,
          accepted_by_user_id: null,
          revoked_at: null,
          declined_at: null,
          superseded_at: null,
          // OD-184. The raw token, sealed, so the invitation EMAIL can carry
          // it. Absent when no key is configured, which produces an invitation
          // that exists and cannot be mailed -- visible as a SUPPRESSED
          // delivery rather than as silence.
          sealed_secret: invitation.sealedSecret ?? null,
          sealed_key_version: invitation.sealedKeyVersion ?? null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async findById(invitationId: WorkspaceInvitationId) {
      const row = await scoped().where("invitation_id", "=", invitationId).executeTakeFirst();
      // An invitation in another workspace is indistinguishable from one that
      // does not exist. Any difference would confirm it exists elsewhere.
      return row === undefined ? null : toRecord(row);
    },

    async findActiveByNormalizedEmail(email: NormalizedEmail) {
      const row = await scoped()
        .where("invitee_normalized_email", "=", email)
        .where(LIVE)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list() {
      // Explicit ORDER BY. Newest first, with the id as a tie-breaker so two
      // invitations created in one transaction have a stable order.
      const rows = await scoped()
        .orderBy("created_at", "desc")
        .orderBy("invitation_id", "asc")
        .execute();
      return rows.map(toRecord);
    },

    async supersedeActiveForEmail(input) {
      const result = await trx.updateTable("workspace_invitations")
        .set({
          superseded_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("workspace_id", "=", scope)
        .where("invitee_normalized_email", "=", input.email)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async rotateCredentialIfLive(input) {
      try {
        const result = await trx.updateTable("workspace_invitations")
          .set({
            token_digest: input.tokenDigest,
            expires_at: new Date(input.expiresAt),
            // A resend mints a NEW token, so the old ciphertext must go with
            // the old digest. Passing the new sealed value here keeps the two
            // halves of one credential from ever disagreeing.
            sealed_secret: input.sealedSecret ?? null,
            sealed_key_version: input.sealedKeyVersion ?? null,
          })
          .where("workspace_id", "=", scope)
          .where("invitation_id", "=", input.invitationId)
          .where(LIVE)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async revokeIfLive(input) {
      const result = await trx.updateTable("workspace_invitations")
        .set({
          revoked_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async acceptIfLive(input) {
      // THE single-use guarantee. Both timestamps in one statement, both
      // conditional on the invitation still being live — so of two concurrent
      // acceptances, exactly one matches a row.
      const result = await trx.updateTable("workspace_invitations")
        .set({
          accepted_at: new Date(input.now),
          accepted_by_user_id: input.acceptedByUserId,
          // Cleared with the acceptance itself. A CHECK constraint rejects the
          // row otherwise, so a spent invitation left openable is impossible
          // rather than merely unintended.
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async findSealedIfActive(input) {
      // One null for unknown, accepted, revoked, declined, superseded and
      // expired alike. The renderer suppresses the message in every case, and
      // telling it which would hand transport an invitation lifecycle it has
      // no use for.
      const row = await trx.selectFrom("workspace_invitations")
        .select(["sealed_secret", "sealed_key_version"])
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .where("expires_at", ">", new Date(input.now))
        .executeTakeFirst();

      if (row === undefined
        || row.sealed_secret === null
        || row.sealed_key_version === null) {
        return null;
      }
      return { sealed: row.sealed_secret, keyVersion: row.sealed_key_version };
    },

    async declineIfLive(input) {
      const result = await trx.updateTable("workspace_invitations")
        .set({
          declined_at: new Date(input.now),
          decline_reason: input.reason ?? null,
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async withdrawDeclineIfDeclined(input) {
      try {
        const result = await trx.updateTable("workspace_invitations")
          .set({ declined_at: null, decline_reason: null })
          .where("workspace_id", "=", scope)
          .where("invitation_id", "=", input.invitationId)
          .where("declined_at", "is not", null)
          .where("accepted_at", "is", null)
          .where("revoked_at", "is", null)
          .where("superseded_at", "is", null)
          .where("expires_at", ">", new Date(input.now))
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        const translated = translatePersistenceError(error);
        // A newer invitation for this address holds the one live slot.
        if (translated instanceof UniqueConstraintViolation
          && (translated.constraint === undefined || translated.constraint === "uq_workspace_invitations_active")) {
          throw new ResourceConflictError("A newer invitation for this address is live.", error);
        }
        throw translated;
      }
    },

    async verifiedAccountByEmail(email) {
      const row = await trx.selectFrom("users")
        .where("normalized_email", "=", email)
        .where("email_verified_at", "is not", null)
        .select(["user_id", "display_name"])
        .executeTakeFirst();
      return row === undefined ? null : { userId: row.user_id as UserId, displayName: row.display_name };
    },
  };
}

/**
 * 089. The invitee inbox realm's reads: only what 089's FOR SELECT policy
 * shows for the digest the transaction manager set — each query ALSO names
 * the address, so the filter is stated twice. Read only.
 */
export function createInviteeInboxLookup(trx: Transaction<Database>, invitee: InviteeInbox) {
  const mine = () => trx.selectFrom("workspace_invitations").selectAll()
    .where("invitee_normalized_email", "=", invitee.verifiedEmail)
    .where(sql<boolean>`invitee_email_digest = lagda_current_workspace_invitee()`);
  return {
    listInvitations: async (): Promise<readonly WorkspaceInvitationRecord[]> => {
      const rows = await mine().orderBy("created_at", "desc").orderBy("invitation_id", "asc").execute();
      return rows.map(toRecord);
    },
    findInvitation: async (invitationId: string): Promise<WorkspaceInvitationRecord | null> => {
      const row = await mine().where("invitation_id", "=", invitationId).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
  };
}

/**
 * The credential lookup. ONE row, read-only, no workspace scope.
 *
 * The digest is not a parameter to this query and it is not in the WHERE
 * clause: it lives in the transaction-local setting the RLS policy reads. That
 * is deliberate. It means the only invitation this repository can see is the
 * one whose credential the caller supplied, enforced by PostgreSQL rather than
 * by a predicate a future edit could widen.
 *
 * `selectAll()` with no filter returns at most one row here — which is the
 * clearest possible demonstration that the policy is doing the work.
 */
export function createInvitationCredentialLookup(
  trx: Transaction<Database>,
): InvitationCredentialLookup {
  return {
    async find(): Promise<WorkspaceInvitationRecord | null> {
      const rows = await trx
        .selectFrom("workspace_invitations")
        .selectAll()
        // Bounded, so a policy failure surfaces as an error here rather than as
        // an unbounded read. If this ever returns more than one row the policy
        // has been widened and the assumption above no longer holds.
        .limit(2)
        .execute();

      if (rows.length > 1) {
        throw new PersistenceMappingError(
          "workspace_invitations", "token_digest",
          "credential lookup matched more than one invitation.",
        );
      }
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };
}
