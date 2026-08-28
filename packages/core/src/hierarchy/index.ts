// Placement rules for anything that nests inside a workspace.
//
// ── Why this is generic ────────────────────────────────────────────────────
//
// Organization units and document folders are structurally identical: a named
// node, inside one workspace, with an optional parent of the same kind. The
// rules that keep either tree sane — no self-parent, no cycles, bounded depth,
// no cross-tenant parent — are the same rules, and a second copy of a cycle
// walk is a second place for it to be subtly wrong.
//
// What is NOT shared is what a node MEANS. A unit is a container for routing
// and reporting; a folder is a place a document sits. Their use cases, their
// capabilities and their lifecycles stay separate. Only the arithmetic of
// nesting lives here.

/** A node in a workspace-scoped tree. Identity, tenancy, and a parent. */
export interface HierarchyNode {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
}

export type PlacementRejection =
  /** A node cannot be its own parent. */
  | "self-parent"
  /** The proposed parent is somewhere below this node already. */
  | "cycle"
  /** The chain would exceed the caller's depth bound. */
  | "too-deep"
  /** The proposed parent is absent, or belongs to another workspace. */
  | "cross-workspace";

/**
 * Whether `nodeId` may be placed under `parentId`.
 *
 * Takes the whole set rather than a repository, because this is a pure
 * structural question whose answer must be identical whether it is asked of the
 * database, a test fixture or a form preview.
 *
 * ── Why the cycle check walks UP ───────────────────────────────────────────
 *
 * Walking down from the node to see whether the parent is a descendant visits
 * the whole subtree. Walking up from the proposed parent visits at most
 * `maxDepth` nodes and answers the same question: if this node appears anywhere
 * in the parent's ancestry, the move closes a loop.
 *
 * The walk is bounded independently of the depth check, so a cycle that somehow
 * already exists in the data cannot spin here — a walk that hangs on corrupt
 * rows takes the process down rather than failing one request.
 *
 * ── Why absent and foreign are ONE answer ──────────────────────────────────
 *
 * A caller who could tell them apart would learn that an id exists in some
 * other workspace.
 */
export function checkPlacement(
  nodeId: string | null,
  parentId: string | null,
  workspaceId: string,
  nodes: readonly HierarchyNode[],
  maxDepth: number,
): PlacementRejection | null {
  if (parentId === null) return null;
  if (nodeId !== null && parentId === nodeId) return "self-parent";

  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const parent = byId.get(parentId);
  if (parent === undefined || parent.workspaceId !== workspaceId) {
    return "cross-workspace";
  }

  let depth = 1;
  let cursor: HierarchyNode | undefined = parent;
  const seen = new Set<string>();

  while (cursor !== undefined) {
    if (nodeId !== null && cursor.nodeId === nodeId) return "cycle";
    if (seen.has(cursor.nodeId)) return "cycle";
    seen.add(cursor.nodeId);

    if (cursor.parentId === null) break;
    depth += 1;
    if (depth > maxDepth) return "too-deep";
    cursor = byId.get(cursor.parentId);
  }

  return null;
}

/**
 * Every node at or below `rootId`, nearest first.
 *
 * Includes the root itself: "documents in this folder" and "units in this
 * department" both mean the node AND what is under it, which is what somebody
 * filing into either expects.
 */
export function descendantIds(
  rootId: string,
  nodes: readonly HierarchyNode[],
): readonly string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.nodeId);
    children.set(node.parentId, siblings);
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
