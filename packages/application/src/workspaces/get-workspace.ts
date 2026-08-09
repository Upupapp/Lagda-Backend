// GetWorkspace and UpdateWorkspace.
//
// Both begin the same way and that is the point: resolve membership, then act.
// Neither returns anything because a workspace ID exists — existence is not
// authorization, and an endpoint that answers differently for "real workspace,
// not yours" than for "no such workspace" is an enumeration oracle (§48–§50).

import type { UserId, WorkspaceId, WorkspaceRole } from "@lagda/contracts";
import { validateWorkspaceName } from "@lagda/core";
import type { TransactionManager } from "../common/ports/index.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import {
  requireWorkspaceAccess, requireWorkspaceManager,
  type WorkspaceAccessDependencies,
} from "./workspace-access.js";

/**
 * A workspace as its own member sees it.
 *
 * ── What is NOT here, and why ──────────────────────────────────────────────
 *
 * No `ownerUserId` — ownership is a membership, and returning "who owns this"
 * to every member is a member-directory disclosure that belongs to BACKEND-26.
 * No `memberCount`: the product's overview page shows one, but that page is the
 * workspace-administration surface, and an aggregate nobody has asked this
 * endpoint for is a query on every read (§107).
 * No slug, plan, billing email, storage prefix, RLS setting or DB role (§27).
 *
 * `role` is the caller's own, exactly as in the list.
 */
export interface WorkspaceDetail {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly createdAt: number;
}

export interface GetWorkspaceDependencies extends WorkspaceAccessDependencies {
  readonly transactions: TransactionManager;
}

export async function getWorkspace(
  userId: UserId,
  workspaceId: WorkspaceId,
  deps: GetWorkspaceDependencies,
): Promise<WorkspaceDetail> {
  // Authorization first. Throws the hiding 404 for a non-member.
  const access = await requireWorkspaceAccess(userId, workspaceId, deps);

  const workspace = await deps.transactions.runForWorkspace(
    access.workspaceId,
    uow => uow.workspaces.find(),
  );

  // Unreachable in practice — a membership has a foreign key to the workspace,
  // so a membership without its workspace cannot exist. Handled rather than
  // asserted because "cannot happen" is a claim about a constraint that a future
  // migration could relax, and the safe answer is the same 404 either way.
  if (workspace === null) throw new ResourceNotFoundError("Workspace");

  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    role: access.role,
    createdAt: workspace.createdAt,
  };
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * The mutable metadata. **One field.**
 *
 * The product's settings form has seven, and six are deliberately not here —
 * each belongs to a command that owns the concept rather than to the form that
 * happens to render it:
 *
 *   slug                   no route resolves one; uniqueness scope undecided
 *   billingEmail           BACKEND-50
 *   defaultMemberRoleId    BACKEND-26 — it is an invitation default
 *   allowMemberInvites     BACKEND-26
 *   requireMfaForAdmins    BACKEND-27 — a role-conditioned security policy
 *   sessionTimeoutMinutes  a per-tenant override of BACKEND-13's session policy
 *
 * Implementing them here would mean this command deciding, silently, what a
 * workspace-level MFA requirement means for a user who belongs to two
 * workspaces with different answers. WORKSPACE_PRODUCT_INVENTORY.md records
 * each with its owner.
 */
export interface UpdateWorkspaceInput {
  readonly name: string;
}

export type UpdateWorkspaceResult =
  | { readonly outcome: "updated"; readonly workspace: WorkspaceDetail }
  | { readonly outcome: "invalid"; readonly reason: "empty" | "too-long" | "control-characters" };

export async function updateWorkspace(
  userId: UserId,
  workspaceId: WorkspaceId,
  input: UpdateWorkspaceInput,
  deps: GetWorkspaceDependencies,
): Promise<UpdateWorkspaceResult> {
  // Owner-only, resolved from the membership row. Never from a client `role`
  // field — no request schema in this command has one (§53, §240).
  const access = await requireWorkspaceManager(userId, workspaceId, deps);

  const validated = validateWorkspaceName(input.name);
  if (!validated.ok) return { outcome: "invalid", reason: validated.reason };

  const updated = await deps.transactions.runForWorkspace(
    access.workspaceId,
    async uow => {
      const applied = await uow.workspaces.updateName(validated.value);
      if (!applied) return null;
      return uow.workspaces.find();
    },
  );

  if (updated === null) throw new ResourceNotFoundError("Workspace");

  return {
    outcome: "updated",
    workspace: {
      workspaceId: updated.workspaceId,
      name: updated.name,
      role: access.role,
      createdAt: updated.createdAt,
    },
  };
}

/**
 * Raised nowhere, and that is a claim worth making explicit.
 *
 * A rename cannot conflict: workspace names are NOT globally unique and must not
 * be. Many customers legitimately operate a workspace called "Legal" or
 * "Personal Workspace", and a global uniqueness constraint would tell every
 * customer which names their competitors had taken (§8, §211).
 */
export const WORKSPACE_NAMES_ARE_NOT_UNIQUE = true;
