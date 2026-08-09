// The workspace tenant contract.
//
// ── Why the role vocabulary lives HERE and not in @lagda/core ───────────────
//
// A membership role appears in a response body: the workspace switcher renders
// it, and `GET /workspaces` returns it. That makes it a SHARED API CONTRACT, and
// INV-007 says shared contracts originate from this package. `@lagda/core`
// re-exports it so there is still exactly ONE declaration — a second list would
// be two vocabularies that agree until someone adds a role to one of them.
//
// ── What is NOT here ────────────────────────────────────────────────────────
//
// No permission matrix, no capability set, no `canX` flags. BACKEND-27 owns
// role semantics; publishing a speculative capability shape now would be a
// contract the frontend starts consuming before anyone has decided what it
// means (§194, §203).

import { Type } from "@sinclair/typebox";

/**
 * Canonical membership roles, taken from the frontend's `PlatformRole`.
 *
 * NOT invented here and NOT reduced to `owner` alone. The product already ships
 * a nine-value `PlatformRole` union and a role-to-permission table; six of those
 * values were adopted by BACKEND-05 and are already a database CHECK constraint
 * and a mapping guard. Narrowing the list in BACKEND-25 would be a migration
 * that removes vocabulary the product uses, to satisfy a "keep it minimal" rule
 * whose purpose is to stop roles being INVENTED — which is the opposite problem.
 *
 * BACKEND-25 only ever WRITES `owner`: it is the sole role any endpoint here can
 * produce, because the only membership this command creates is the creator's.
 * The remaining values exist so BACKEND-26 can request one and BACKEND-27 can
 * give it meaning, without a migration that rewrites the constraint.
 */
export const WORKSPACE_ROLES = [
  "owner", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * The wire schema for a role.
 *
 * A closed union, so a response carrying an unrecognised role fails the
 * serializer rather than reaching a client that has no branch for it.
 */
export const WorkspaceRoleSchema = Type.Union(
  WORKSPACE_ROLES.map(role => Type.Literal(role)),
  { title: "WorkspaceRole", description: "The caller's role in this workspace." },
);

/**
 * The maximum a workspace name may be, in Unicode code points.
 *
 * Matches the `varchar(200)` column. Stated in code points rather than bytes
 * because that is what a person composing a name experiences — a 200-character
 * limit that rejects a 90-character name because it is written in Baybayin is a
 * limit expressed in the wrong unit.
 */
export const WORKSPACE_NAME_MAX_LENGTH = 200;

/** The minimum, after trimming. One character is a legitimate name. */
export const WORKSPACE_NAME_MIN_LENGTH = 1;
