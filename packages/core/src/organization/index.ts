// Organization units: the shape of an institution inside one workspace.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The workspace model is FLAT. A workspace has members and nothing between them
// — no department, no office, no team. Every capability the platform is meant to
// grow needs that middle layer: a workflow stage assigned to a department, a
// document filed under an office, a report grouped by division, and four of the
// roles the product names (Department Administrator, Department Head) refer to
// a thing that does not exist.
//
// ── Why one table and not seven ────────────────────────────────────────────
//
// Department, office, division, branch, team, committee and project group are
// the SAME structural thing with different labels: a named container, inside a
// workspace, that can hold people and can nest. Modelling them as seven tables
// would multiply every query, every permission check and every join by seven to
// express a difference that is entirely nominal.
//
// The kind is a label carried on the row. It is closed rather than free text so
// a client cannot invent a hierarchy vocabulary the product has to honour
// later, and so reports can group by it without normalising strings.
//
// ── Why the hierarchy is deliberately shallow-checked, not shallow ─────────
//
// A government LGU nests deeply — city, department, division, section. A small
// company has one level. The model refuses to assume either (a hardcoded depth
// would encode one customer), so depth is bounded only to stop pathological
// nesting, and the real constraint enforced here is that a unit may not contain
// itself, directly or transitively.

import {
  checkPlacement, descendantIds,
  type HierarchyNode, type PlacementRejection,
} from "../hierarchy/index.js";

/**
 * What an organization unit is called.
 *
 * Closed, and ordered roughly from the most common to the least. A kind carries
 * no behaviour: nothing in this file branches on it, and nothing downstream
 * should. It exists so a UI can label a tree and a report can group one.
 */
export const ORGANIZATION_UNIT_KINDS = [
  "department",
  "office",
  "division",
  "branch",
  "team",
  "committee",
  "project_group",
] as const;

export type OrganizationUnitKind = (typeof ORGANIZATION_UNIT_KINDS)[number];

export function isOrganizationUnitKind(
  value: string,
): value is OrganizationUnitKind {
  return (ORGANIZATION_UNIT_KINDS as readonly string[]).includes(value);
}

/**
 * The deepest a unit may sit below a root.
 *
 * Not a product rule about how institutions are shaped — a bound on
 * pathological input. Four levels covers "City → Department → Division →
 * Section", which is the deepest real hierarchy the product has been shown, and
 * a tree deeper than this is far more likely to be a mistake or an attack than
 * an org chart.
 */
export const MAX_UNIT_DEPTH = 6;

export const UNIT_NAME_MAX_LENGTH = 120;

/**
 * Why a placement was refused.
 *
 * An alias rather than its own union: the rules are the shared hierarchy rules,
 * and a second vocabulary for the same four answers would drift from them.
 */
export type UnitPlacementRejection = PlacementRejection;

/** One unit as the domain reasons about it. No timestamps, no persistence. */
export interface UnitNode {
  readonly unitId: string;
  readonly workspaceId: string;
  readonly parentUnitId: string | null;
}

const toHierarchy = (unit: UnitNode): HierarchyNode => ({
  nodeId: unit.unitId,
  workspaceId: unit.workspaceId,
  parentId: unit.parentUnitId,
});

/**
 * Whether `unitId` may be placed under `parentUnitId`.
 *
 * Delegates to the shared checker. Organization units and document folders nest
 * identically, and a second copy of a cycle walk is a second place for it to be
 * subtly wrong.
 */
export function checkUnitPlacement(
  unitId: string | null,
  parentUnitId: string | null,
  workspaceId: string,
  units: readonly UnitNode[],
): UnitPlacementRejection | null {
  return checkPlacement(
    unitId, parentUnitId, workspaceId, units.map(toHierarchy), MAX_UNIT_DEPTH);
}

/** Every unit at or below `rootId`, the root included. */
export function descendantsOf(
  rootId: string,
  units: readonly UnitNode[],
): readonly string[] {
  return descendantIds(rootId, units.map(toHierarchy));
}
