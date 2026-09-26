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

import { recordActivity, memberNameOf } from "../workspaces/activity.js";
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
 * One person's membership in one unit, WITH the title they hold there (061).
 *
 * `title: null` is the ordinary case — most members hold no distinguished
 * role, they simply belong. A title names something like "Department Head":
 * a fact about who currently occupies that position, never an authorization
 * grant (this module's own header rule).
 */
export interface UnitMembership {
  readonly userId: UserId;
  readonly title: string | null;
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

  listMembers(unitId: OrganizationUnitId): Promise<readonly UnitMembership[]>;
  /** Idempotent: adding somebody twice is a no-op, not an error — including
   *  when a `title` is given again; see `setMemberTitle` for CHANGING one. */
  addMember(input: {
    readonly unitId: OrganizationUnitId;
    readonly userId: UserId;
    readonly now: number;
    readonly title?: string | null;
  }): Promise<void>;
  removeMember(input: {
    readonly unitId: OrganizationUnitId;
    readonly userId: UserId;
  }): Promise<boolean>;
  /**
   * Sets (or, with `null`, clears) the title an EXISTING member holds.
   *
   * `false` when they are not a member — a title cannot be granted to
   * someone who does not belong to the unit at all.
   */
  setMemberTitle(input: {
    readonly unitId: OrganizationUnitId;
    readonly userId: UserId;
    readonly title: string | null;
  }): Promise<boolean>;
  /**
   * Whoever currently holds this title in this unit, or null if nobody does.
   *
   * Never more than one — the partial unique index (061) makes two
   * simultaneous holders of the same title unrepresentable, which is what
   * lets a workflow template slot resolve a title to exactly one person.
   */
  findByTitle(unitId: OrganizationUnitId, title: string): Promise<UserId | null>;
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
    await recordActivity(uow, {
      action: "team.created", actorUserId: input.actor.userId, occurredAt: unit.createdAt,
      details: { teamName: name, kind },
    });
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

    // A move alone is not a rename; only a changed name is recorded.
    if (current.name !== name) {
      await recordActivity(uow, {
        action: "team.renamed", actorUserId: input.actor.userId, occurredAt: deps.clock.now(),
        details: { teamName: name, from: current.name },
      });
    }
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
    await recordActivity(uow, {
      action: "team.archived", actorUserId: input.actor.userId, occurredAt: deps.clock.now(),
      details: { teamName: existing.find(unit => unit.unitId === unitId)?.name ?? null },
    });
  });
}

export interface UnitMemberInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
  readonly userId: string;
  /** 061. Optional at add-time — most members hold no title. */
  readonly title?: string | null;
}

function assertTitle(raw: string): string {
  const title = raw.trim();
  if (title === "") {
    throw new ApplicationValidationError("A title needs a name.");
  }
  // Same bound as a unit's own name (UNIT_NAME_MAX_LENGTH) — both are
  // short, human-typed labels stored in the same-width column.
  if ([...title].length > UNIT_NAME_MAX_LENGTH) {
    throw new ApplicationValidationError(
      `A title may not exceed ${String(UNIT_NAME_MAX_LENGTH)} characters.`);
  }
  return title;
}

/**
 * Adds somebody to a unit.
 *
 * The DATABASE enforces that they are already a workspace member, through a
 * compound FK to `workspace_memberships`. That is the guarantee rather than a
 * pre-read: a check followed by an insert has a window, and the window is
 * exactly where a removed member gets filed into a department.
 *
 * A `title` given here goes through the SAME uniqueness the database
 * enforces (061's partial index) — a second person added with a title
 * already held in this unit fails the insert, surfaced as a conflict rather
 * than silently displacing the current holder.
 */
export async function addUnitMember(
  input: UnitMemberInput,
  deps: OrganizationDependencies,
): Promise<void> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.member.manage", deps);

  const title = input.title === undefined || input.title === null
    ? input.title : assertTitle(input.title);

  await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const unit = await uow.organizationUnits.findById(
      input.unitId as OrganizationUnitId);
    if (unit === null || unit.archivedAt !== null) {
      throw new ResourceNotFoundError("OrganizationUnit");
    }
    const alreadyIn = (await uow.organizationUnits.listMembers(unit.unitId))
      .some(member => member.userId === input.userId);
    await uow.organizationUnits.addMember({
      unitId: unit.unitId,
      userId: input.userId as UserId,
      now: deps.clock.now(),
      // Spread, so an ABSENT `title` stays absent under
      // `exactOptionalPropertyTypes` rather than becoming a present key
      // holding `undefined` — a different thing the port does not accept.
      ...(title === undefined ? {} : { title }),
    });
    // Adding somebody twice is a no-op, so it is not recorded twice either.
    if (!alreadyIn) {
      await recordActivity(uow, {
        action: "team.member_added", actorUserId: input.actor.userId, occurredAt: deps.clock.now(),
        details: { teamName: unit.name, targetName: await memberNameOf(uow, input.userId as UserId) },
      });
    }
  });
}

export interface SetUnitMemberTitleInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
  readonly userId: string;
  /** `null` clears the title — the member stays, they simply no longer hold
   *  a distinguished role in this unit. */
  readonly title: string | null;
}

/**
 * Changes the title an ALREADY-a-member holds, without removing and
 * re-adding them — which would briefly (and observably, to a concurrent
 * `resolveWorkflowRoleAssignments` read) leave the title unheld.
 */
export async function setUnitMemberTitle(
  input: SetUnitMemberTitleInput,
  deps: OrganizationDependencies,
): Promise<void> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.member.manage", deps);

  const title = input.title === null ? null : assertTitle(input.title);

  await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const applied = await uow.organizationUnits.setMemberTitle({
      unitId: input.unitId as OrganizationUnitId,
      userId: input.userId as UserId,
      title,
    });
    if (!applied) throw new ResourceNotFoundError("OrganizationUnitMember");
    const unit = await uow.organizationUnits.findById(input.unitId as OrganizationUnitId);
    await recordActivity(uow, {
      action: "team.member_updated", actorUserId: input.actor.userId, occurredAt: deps.clock.now(),
      details: {
        teamName: unit?.name ?? null, title,
        targetName: await memberNameOf(uow, input.userId as UserId),
      },
    });
  });
}

export interface ListUnitMembersInput {
  readonly actor: { readonly userId: UserId };
  readonly workspaceId: WorkspaceId;
  readonly unitId: string;
}

/** One unit's roster, each member's title alongside their directory entry
 *  (display name and email) — the same join `resolveWorkflowRoleAssignments`
 *  performs for a single resolved person, done here for the whole unit so an
 *  admin can see who holds what before wiring a template slot to it. */
export interface UnitMemberDirectoryEntry {
  readonly userId: UserId;
  readonly title: string | null;
  readonly displayName: string;
  readonly email: string;
}

export async function listUnitMembers(
  input: ListUnitMembersInput,
  deps: OrganizationDependencies,
): Promise<readonly UnitMemberDirectoryEntry[]> {
  await requireCapability(
    input.actor.userId, input.workspaceId, "unit.view", deps);

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const unitId = input.unitId as OrganizationUnitId;
    const unit = await uow.organizationUnits.findById(unitId);
    if (unit === null) throw new ResourceNotFoundError("OrganizationUnit");

    const [members, directory] = await Promise.all([
      uow.organizationUnits.listMembers(unitId),
      uow.memberships.listWithAccounts(),
    ]);
    const directoryByUser = new Map(directory.map(entry => [entry.userId, entry]));

    return members.map(member => {
      const entry = directoryByUser.get(member.userId);
      return {
        userId: member.userId,
        title: member.title,
        // A member whose workspace membership was removed between the two
        // reads above (a genuine but narrow race) falls back honestly
        // rather than throwing over a directory that is momentarily stale.
        displayName: entry?.displayName ?? "",
        email: entry?.email ?? "",
      };
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
    const removed = await uow.organizationUnits.removeMember({
      unitId: input.unitId as OrganizationUnitId,
      userId: input.userId as UserId,
    });
    if (removed) {
      const unit = await uow.organizationUnits.findById(input.unitId as OrganizationUnitId);
      await recordActivity(uow, {
        action: "team.member_removed", actorUserId: input.actor.userId, occurredAt: deps.clock.now(),
        details: { teamName: unit?.name ?? null, targetName: await memberNameOf(uow, input.userId as UserId) },
      });
    }
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
