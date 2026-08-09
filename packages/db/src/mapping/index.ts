// Row ↔ domain mapping.
//
// Explicit, field by field. No reflection, no property-name matching, no
// spreading a domain object into an insert. For a system holding legal
// documents, an automatic mapper is a way to persist a field nobody reviewed.
//
// Reading is where the care goes: a row is RUNTIME DATA, not a guarantee. A
// status written by an older release, or a value edited by hand during an
// incident, must fail loudly rather than be cast into a type it does not match.

import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@lagda/core";
import type { WorkspaceRecord, WorkspaceMembershipRecord } from "@lagda/application";
import type { Selectable, Insertable } from "kysely";
import type { WorkspacesTable, WorkspaceMembershipsTable } from "../schema/index.js";

// Kysely distinguishes what a column YIELDS from what it ACCEPTS: a
// `timestamptz` reads as a Date and is written as a Date, but the table
// interface describes both directions at once. `Selectable` and `Insertable`
// resolve it to the concrete shape for each direction, so a read mapper cannot
// accidentally be used as a write mapper.
type WorkspaceRow = Selectable<WorkspacesTable>;
type WorkspaceInsert = Insertable<WorkspacesTable>;
type MembershipRow = Selectable<WorkspaceMembershipsTable>;
type MembershipInsert = Insertable<WorkspaceMembershipsTable>;

/** A persisted value that cannot be interpreted. Never a client's fault. */
export class PersistenceMappingError extends Error {
  constructor(table: string, column: string, detail: string) {
    // Names the column, never the value — a malformed value can be PII.
    super(`Cannot map ${table}.${column}: ${detail}`);
    this.name = "PersistenceMappingError";
  }
}

/**
 * Validated rather than cast.
 *
 * `row.role as WorkspaceRole` would accept anything the column happens to hold.
 * The CHECK constraint makes that unlikely; this makes it impossible to pass
 * silently if the constraint is ever dropped or predates a new value.
 */
function toRole(value: string): WorkspaceRole {
  const role = WORKSPACE_ROLES.find(candidate => candidate === value);
  if (role === undefined) {
    throw new PersistenceMappingError(
      "workspace_memberships", "role", `"${value}" is not a canonical role.`,
    );
  }
  return role;
}

/**
 * `timestamptz` → the domain's numeric instant.
 *
 * A `Date` never leaves this layer: it is mutable, so handing one to a caller
 * lets them change a record's timestamps by accident.
 */
function toInstant(table: string, column: string, value: Date): number {
  const ms = value.getTime();
  if (Number.isNaN(ms)) {
    throw new PersistenceMappingError(table, column, "not a valid timestamp.");
  }
  return ms;
}

export function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name,
    ownerUserId: row.owner_user_id as UserId,
    createdAt: toInstant("workspaces", "created_at", row.created_at),
  };
}

export function fromWorkspaceRecord(record: WorkspaceRecord): WorkspaceInsert {
  // Every column named. A spread would carry along any property the record
  // gained later, including computed ones that have no column.
  return {
    workspace_id: record.workspaceId,
    name: record.name,
    owner_user_id: record.ownerUserId,
    created_at: new Date(record.createdAt),
  };
}

export function toMembershipRecord(row: MembershipRow): WorkspaceMembershipRecord {
  return {
    memberId: row.member_id as WorkspaceMemberId,
    workspaceId: row.workspace_id as WorkspaceId,
    userId: row.user_id as UserId,
    role: toRole(row.role),
    createdAt: toInstant("workspace_memberships", "created_at", row.created_at),
  };
}

export function fromMembershipRecord(
  record: WorkspaceMembershipRecord,
): MembershipInsert {
  return {
    member_id: record.memberId,
    workspace_id: record.workspaceId,
    user_id: record.userId,
    role: record.role,
    created_at: new Date(record.createdAt),
  };
}
