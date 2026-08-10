// Invitation persistence.
//
// Every state transition is a CONDITIONAL UPDATE whose WHERE clause names the
// four terminal timestamps. That is not defensive styling — it is the
// concurrency control. `SELECT` then `UPDATE` lets two concurrent acceptances
// both observe a pending invitation and both proceed; here the second matches
// zero rows and the caller learns it lost.

import { sql, type Transaction } from "kysely";
import type {
  UserId, WorkspaceId, WorkspaceInvitationId, InvitableWorkspaceRole,
} from "@lagda/contracts";
import { INVITABLE_WORKSPACE_ROLES } from "@lagda/contracts";
import type {
  ScopedInvitationRepository, InvitationCredentialLookup,
  WorkspaceInvitationRecord, NewWorkspaceInvitation,
  NormalizedEmail,
} from "@lagda/application";
import { assertNormalized } from "@lagda/application";
import type { Database, WorkspaceInvitationsTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";
import type { Selectable } from "kysely";

type InvitationRow = Selectable<WorkspaceInvitationsTable>;

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
        .set({ superseded_at: new Date(input.now) })
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
        .set({ revoked_at: new Date(input.now) })
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
        })
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async declineIfLive(input) {
      const result = await trx.updateTable("workspace_invitations")
        .set({ declined_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("invitation_id", "=", input.invitationId)
        .where(LIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
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
