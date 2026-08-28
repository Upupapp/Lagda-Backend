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

export type UnitPlacementRejection =
  /** A unit cannot be its own parent. */
  | "self-parent"
  /** The proposed parent is somewhere below this unit already. */
  | "cycle"
  /** The chain would exceed `MAX_UNIT_DEPTH`. */
  | "too-deep"
  /** The proposed parent belongs to a different workspace. */
  | "cross-workspace";

/** One unit as the domain reasons about it. No timestamps, no persistence. */
export interface UnitNode {
  readonly unitId: string;
  readonly workspaceId: string;
  readonly parentUnitId: string | null;
}

/**
 * Whether `unitId` may be placed under `parentUnitId`.
 *
 * Takes the whole set of units in the workspace rather than a repository,
 * because this is a pure structural question and the answer must be the same
 * whether it is asked of the database, a test fixture or a form preview.
 *
 * ── Why the cycle check walks UP and not DOWN ──────────────────────────────
 *
 * Walking down from the unit to see whether the parent is a descendant visits
 * the whole subtree. Walking up from the proposed parent to a root visits at
 * most `MAX_UNIT_DEPTH` nodes and answers the same question: if this unit
 * appears anywhere in the parent's ancestry, the move would close a loop.
 *
 * The walk is also bounded independently of the depth check, so a cycle that
 * somehow already exists in the data cannot spin here.
 */
export function checkUnitPlacement(
  unitId: string | null,
  parentUnitId: string | null,
  workspaceId: string,
  units: readonly UnitNode[],
): UnitPlacementRejection | null {
  if (parentUnitId === null) return null;
  if (unitId !== null && parentUnitId === unitId) return "self-parent";

  const byId = new Map(units.map(unit => [unit.unitId, unit]));
  const parent = byId.get(parentUnitId);
  if (parent === undefined || parent.workspaceId !== workspaceId) {
    // Absent and foreign are ONE answer. A caller who could tell them apart
    // would learn that a unit id exists in some other workspace.
    return "cross-workspace";
  }

  let depth = 1;
  let cursor: UnitNode | undefined = parent;
  const seen = new Set<string>();

  while (cursor !== undefined) {
    if (unitId !== null && cursor.unitId === unitId) return "cycle";
    // Guards against a pre-existing loop in the data rather than one this move
    // would create. Either way the walk must terminate.
    if (seen.has(cursor.unitId)) return "cycle";
    seen.add(cursor.unitId);

    if (cursor.parentUnitId === null) break;
    depth += 1;
    if (depth > MAX_UNIT_DEPTH) return "too-deep";
    cursor = byId.get(cursor.parentUnitId);
  }

  return null;
}

/**
 * Every unit at or below `rootId`, nearest first.
 *
 * Used to decide what an archive affects and what a department-scoped query
 * covers. Returns the root itself: "documents in this department" means the
 * department AND its divisions, which is what a person filing under it expects.
 */
export function descendantsOf(
  rootId: string,
  units: readonly UnitNode[],
): readonly string[] {
  const children = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.parentUnitId === null) continue;
    const siblings = children.get(unit.parentUnitId) ?? [];
    siblings.push(unit.unitId);
    children.set(unit.parentUnitId, siblings);
  }

  const out: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    queue.push(...(children.get(current) ?? []));
  }

  return out;
}
