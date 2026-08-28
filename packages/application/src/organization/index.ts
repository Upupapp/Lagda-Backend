// Organization units: create, place, rename, archive, and staff them.
//
// ── The one rule that shapes every use case here ──────────────────────────
//
// A unit is a container, not a permission. Belonging to a department grants
// nothing, and nothing in this module consults a unit to answer an
// authorization question. That separation is deliberate: the moment unit
// membership implies access, every reorganisation becomes a security change,
// and an org chart edited by an administrator becomes a way to grant themselves
// documents.
//
// Units are for ROUTING and REPORTING — which department a workflow stage goes
// to, which office a document is filed under, how a report groups. Authorization
// stays with roles and capabilities, where it can be reviewed in one place.

import {
  checkUnitPlacement, isOrganizationUnitKind, UNIT_NAME_MAX_LENGTH,
  type OrganizationUnitKind, type UnitNode,
} from "@lagda/core";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type { Clock } from "../common/ports/index.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  requireCapability, type WorkspaceAccessDependencies,
} from "../workspaces/workspace-access.js";

export type OrganizationUnitId = string & {
  readonly __brand: "OrganizationUnitId";
};

export interface OrganizationUnitIdGenerator {
  nextOrganizationUnitId(): OrganizationUnitId;
}

export interface OrganizationUnitRecord {
  readonly unitId: OrganizationUnitId;
  readonly workspaceId: WorkspaceId;
  readonly parentUnitId: OrganizationUnitId | null;
  readonly kind: OrganizationUnitKind;
  readonly name: string;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

/**
 * Unit persistence, bound to ONE workspace and ONE transaction.
 *
 * `list` returns archived units too. A caller deciding where to place a new
 * unit must see the whole tree — placing a live unit under an archived parent
 * is a decision to make, not a row to hide.
 */
export interface ScopedOrganizationUnitRepository {
  list(): Promise<readonly OrganizationUnitRecord[]>;
  findById(unitId: OrganizationUnitId): Promise<OrganizationUnitRecord | null>;
  insert(unit: OrganizationUnitRecord): Promise<void>;
  /** Conditional on the unit being live. Returns whether it applied. */
  updateIfLive(input: {
    readonly unitId: OrganizationUnitId;
    readonly name: string;
    readonly parentUnitId: OrganizationUnitId | null;
  }): Promise<boolean>;
  archiveIfLive(input: {
    readonly unitId: OrganizationUnitId;
    readonly now: number;
  }): Promise<boolean>;

  listMembers(unitId: OrganizationUnitId): Promise<readonly UserId[]>;
  /** Idempotent: adding somebody twice is a no-op, not an error. */
  addMember(input: {
    readonly unitId: OrganizationUnitId;
    readonly userId: UserId;
    readonly now: number;
  }): Promise<void>;
  removeMember(input: {
    readonly unitId: OrganizationUnitId;
    readonly userId: UserId;
  }): Promise<boolean>;
  /** Every unit this person belongs to. For "my department" queries. */
  unitsForUser(userId: UserId): Promise<readonly OrganizationUnitId[]>;
}

export class UnitPlacementError extends ApplicationValidationError {
  constructor(reason: string) {
    super(`The unit cannot be placed there: ${reason}.`);
    this.name = "UnitPlacementError";
  }
}

export interface OrganizationDependencies extends WorkspaceAccessDependencies {
  readonly clock: Clock;
  readonly unitIds: OrganizationUnitIdGenerator;
}

function assertName(raw: string): string {
  const name = raw.trim();
  if (name === "") {
    throw new ApplicationValidationError("A unit needs a name.");
  }
  if ([...name].length > UNIT_NAME_MAX_LENGTH) {
    throw new ApplicationValidationError(
      `A unit name may not exceed ${String(UNIT_NAME_MAX_LENGTH)} characters.`);
  }
  return name;
}

const toNode = (unit: OrganizationUnitRecord): UnitNode => ({
  unitId: unit.unitId,
  workspaceId: unit.workspaceId,
  parentUnitId: unit.parentUnitId,
});

export interface CreateUnitInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly kind: string;
  readonly parentUnitId?: string;
}

export async function createOrganizationUnit(
  input: CreateUnitInput,
  deps: OrganizationDependencies,
): Promise<OrganizationUnitRecord> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.create", deps);

  const name = assertName(input.name);
  if (!isOrganizationUnitKind(input.kind)) {
    throw new ApplicationValidationError(
      "That is not a kind of organization unit.");
  }
  const kind: OrganizationUnitKind = input.kind;
  const parentUnitId = (input.parentUnitId ?? null) as OrganizationUnitId | null;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    // The whole tree, read INSIDE the transaction. Placement is a question
    // about the tree at the moment of the write, not as it was when a form was
    // rendered.
    const existing = await uow.organizationUnits.list();
    const rejection = checkUnitPlacement(
      null, parentUnitId, input.workspaceId, existing.map(toNode));
    if (rejection !== null) throw new UnitPlacementError(rejection);

    const unit: OrganizationUnitRecord = {
      unitId: deps.unitIds.nextOrganizationUnitId(),
      workspaceId: input.workspaceId,
      parentUnitId,
      kind,
      name,
      createdAt: deps.clock.now(),
      archivedAt: null,
    };
    await uow.organizationUnits.insert(unit);
    return unit;
  });
}

export interface UpdateUnitInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
  readonly name: string;
  readonly parentUnitId?: string | null;
}

/**
 * Renames a unit and optionally moves it.
 *
 * One operation because it is one form. Splitting them would let a client move
 * a unit and then fail to rename it, leaving the tree in a shape nobody chose.
 */
export async function updateOrganizationUnit(
  input: UpdateUnitInput,
  deps: OrganizationDependencies,
): Promise<OrganizationUnitRecord> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.update", deps);

  const name = assertName(input.name);
  const unitId = input.unitId as OrganizationUnitId;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const existing = await uow.organizationUnits.list();
    const current = existing.find(unit => unit.unitId === unitId);
    // Absent and archived are ONE answer. A tenant-scoped repository has
    // already collapsed "another workspace's unit" into absent.
    if (current === undefined || current.archivedAt !== null) {
      throw new ResourceNotFoundError("OrganizationUnit");
    }

    const parentUnitId = input.parentUnitId === undefined
      ? current.parentUnitId
      : (input.parentUnitId as OrganizationUnitId | null);

    const rejection = checkUnitPlacement(
      unitId, parentUnitId, input.workspaceId, existing.map(toNode));
    if (rejection !== null) throw new UnitPlacementError(rejection);

    const applied = await uow.organizationUnits.updateIfLive({
      unitId, name, parentUnitId,
    });
    if (!applied) throw new ResourceNotFoundError("OrganizationUnit");

    return { ...current, name, parentUnitId };
  });
}

export interface ArchiveUnitInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
}

/**
 * Archives a unit that has no live children.
 *
 * Children are refused rather than cascaded. Archiving a department must not
 * silently retire every division inside it — somebody has to decide where those
 * go, and a cascade makes that decision invisible.
 */
export async function archiveOrganizationUnit(
  input: ArchiveUnitInput,
  deps: OrganizationDependencies,
): Promise<void> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.archive", deps);

  const unitId = input.unitId as OrganizationUnitId;

  await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const existing = await uow.organizationUnits.list();
    const liveChildren = existing.filter(
      unit => unit.parentUnitId === unitId && unit.archivedAt === null);
    if (liveChildren.length > 0) {
      throw new ApplicationValidationError(
        "Move or archive the units inside this one first.");
    }

    const applied = await uow.organizationUnits.archiveIfLive({
      unitId, now: deps.clock.now(),
    });
    if (!applied) throw new ResourceNotFoundError("OrganizationUnit");
  });
}

export interface UnitMemberInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
  readonly userId: string;
}

/**
 * Adds somebody to a unit.
 *
 * The DATABASE enforces that they are already a workspace member, through a
 * compound FK to `workspace_memberships`. That is the guarantee rather than a
 * pre-read: a check followed by an insert has a window, and the window is
 * exactly where a removed member gets filed into a department.
 */
export async function addUnitMember(
  input: UnitMemberInput,
  deps: OrganizationDependencies,
): Promise<void> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.member.manage", deps);

  await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const unit = await uow.organizationUnits.findById(
      input.unitId as OrganizationUnitId);
    if (unit === null || unit.archivedAt !== null) {
      throw new ResourceNotFoundError("OrganizationUnit");
    }
    await uow.organizationUnits.addMember({
      unitId: unit.unitId,
      userId: input.userId as UserId,
      now: deps.clock.now(),
    });
  });
}

export async function removeUnitMember(
  input: UnitMemberInput,
  deps: OrganizationDependencies,
): Promise<void> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.member.manage", deps);

  await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    // Not an error when they are already out. That is the state the caller
    // asked for, and reporting it would make a retry look like a failure.
    await uow.organizationUnits.removeMember({
      unitId: input.unitId as OrganizationUnitId,
      userId: input.userId as UserId,
    });
  });
}

export interface ListUnitsInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
}

export async function listOrganizationUnits(
  input: ListUnitsInput,
  deps: OrganizationDependencies,
): Promise<readonly OrganizationUnitRecord[]> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.view", deps);

  return deps.transactions.runForWorkspace(
    input.workspaceId, uow => uow.organizationUnits.list());
}
