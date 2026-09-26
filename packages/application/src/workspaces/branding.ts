// 082. Reading and changing a workspace's branding.
//
// Any member may READ it — every member's screens show it. Changing it is
// `workspace.update` (owners and administrators), the same authority as a
// rename, because the display name IS the workspace name. Each change is
// recorded in the activity log in the same transaction.

import type { WorkspaceId } from "@lagda/contracts";
import { hasCapability, validateWorkspaceName } from "@lagda/core";
import { assertCapability, privilegesOf, type WorkspaceAccessContext } from "./workspace-access.js";
import { recordActivity } from "./activity.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { Clock, TransactionManager, WorkspaceUnitOfWork } from "../common/ports/index.js";
import type { WorkspaceCapability } from "@lagda/core";
import {
  BRANDING_SENDER_NAME_MAX_LENGTH, BRANDING_TAGLINE_MAX_LENGTH,
  type WorkspaceBrandingSettings, type WorkspaceLogoImage,
} from "../common/ports/workspace-branding.js";

export interface BrandingDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
}

export interface WorkspaceBrandingView {
  readonly displayName: string;
  readonly senderDisplayName: string | null;
  readonly footerTagline: string | null;
  readonly primaryColor: string | null;
  /** `version` changes whenever the logo does, so a client can cache by it. */
  readonly logo: { readonly version: string; readonly width: number; readonly height: number } | null;
  readonly updatedAt: number | null;
  /** Whether THIS caller may change it. */
  readonly canEdit: boolean;
}

async function authorize(
  uow: WorkspaceUnitOfWork, actor: AuthenticatedActor, capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId, userId: membership.userId,
    membershipId: membership.memberId, role: membership.role, privileges: privilegesOf(membership),
  };
  assertCapability(access, capability);
  return access;
}

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const COLOR = /^#[0-9A-Fa-f]{6}$/u;

function optionalText(raw: string | null | undefined, field: string, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;
  if ([...value].length > max || CONTROL_CHARACTERS.test(value)) {
    throw new ApplicationValidationError("Check the branding details and try again.",
      [`${field}: at most ${String(max)} characters, no control characters`]);
  }
  return value;
}

function color(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  if (!COLOR.test(raw.trim())) {
    throw new ApplicationValidationError("Choose a colour as #RRGGBB.", ["primaryColor: #RRGGBB"]);
  }
  return raw.trim().toUpperCase();
}

async function project(uow: WorkspaceUnitOfWork, access: WorkspaceAccessContext): Promise<WorkspaceBrandingView> {
  const [workspace, branding] = await Promise.all([uow.workspaces.find(), uow.branding.find()]);
  if (workspace === null) throw new ResourceNotFoundError("Workspace");
  return {
    displayName: workspace.name,
    senderDisplayName: branding?.senderDisplayName ?? null,
    footerTagline: branding?.footerTagline ?? null,
    primaryColor: branding?.primaryColor ?? null,
    logo: branding?.logo === null || branding?.logo === undefined ? null
      : { version: branding.logo.digest, width: branding.logo.width, height: branding.logo.height },
    updatedAt: branding?.updatedAt ?? null,
    canEdit: hasCapability(access.role, "workspace.update"),
  };
}

export async function getWorkspaceBranding(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: Pick<BrandingDependencies, "transactions">,
): Promise<WorkspaceBrandingView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow =>
    project(uow, await authorize(uow, actor, "workspace.view")));
}

export interface UpdateBrandingInput {
  readonly displayName?: string;
  readonly senderDisplayName?: string | null;
  readonly footerTagline?: string | null;
  readonly primaryColor?: string | null;
}

/** Absent keys are left alone; `null` or "" clears back to the default. */
export async function updateWorkspaceBranding(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, input: UpdateBrandingInput, deps: BrandingDependencies,
): Promise<WorkspaceBrandingView> {
  const name = input.displayName === undefined ? undefined : validateWorkspaceName(input.displayName);
  if (name !== undefined && !name.ok) {
    throw new ApplicationValidationError("Check the workspace display name.", [`displayName: ${name.reason}`]);
  }
  const requested = {
    senderDisplayName: input.senderDisplayName === undefined ? undefined
      : optionalText(input.senderDisplayName, "senderDisplayName", BRANDING_SENDER_NAME_MAX_LENGTH),
    footerTagline: input.footerTagline === undefined ? undefined
      : optionalText(input.footerTagline, "footerTagline", BRANDING_TAGLINE_MAX_LENGTH),
    primaryColor: input.primaryColor === undefined ? undefined : color(input.primaryColor),
  };

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "workspace.update");
    const now = deps.clock.now();
    const [workspace, current] = await Promise.all([uow.workspaces.find(), uow.branding.find()]);
    if (workspace === null) throw new ResourceNotFoundError("Workspace");

    if (name !== undefined && name.ok && name.value !== workspace.name) {
      await uow.workspaces.updateName(name.value);
      await recordActivity(uow, {
        action: "workspace.renamed", actorUserId: actor.userId, occurredAt: now,
        details: { from: workspace.name, to: name.value },
      });
    }

    const next: WorkspaceBrandingSettings = {
      senderDisplayName: requested.senderDisplayName === undefined ? current?.senderDisplayName ?? null : requested.senderDisplayName,
      footerTagline: requested.footerTagline === undefined ? current?.footerTagline ?? null : requested.footerTagline,
      primaryColor: requested.primaryColor === undefined ? current?.primaryColor ?? null : requested.primaryColor,
    };
    const changed = (["senderDisplayName", "footerTagline", "primaryColor"] as const)
      .filter(key => next[key] !== (current?.[key] ?? null));
    if (changed.length > 0) {
      await uow.branding.saveSettings(next, now);
      await recordActivity(uow, {
        action: "workspace.branding_changed", actorUserId: actor.userId, occurredAt: now,
        details: { changed: changed.map(describeSetting).join(", ") },
      });
    }
    return project(uow, access);
  });
}

function describeSetting(key: "senderDisplayName" | "footerTagline" | "primaryColor" | "logo"): string {
  switch (key) {
    case "senderDisplayName": return "sender name";
    case "footerTagline": return "footer tagline";
    case "primaryColor": return "brand colour";
    case "logo": return "logo";
  }
}

export async function setWorkspaceLogo(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, logo: WorkspaceLogoImage, deps: BrandingDependencies,
): Promise<WorkspaceBrandingView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "workspace.update");
    const now = deps.clock.now();
    await uow.branding.saveLogo(logo, now);
    await recordActivity(uow, {
      action: "workspace.branding_changed", actorUserId: actor.userId, occurredAt: now,
      details: { changed: describeSetting("logo") },
    });
    return project(uow, access);
  });
}

export async function removeWorkspaceLogo(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: BrandingDependencies,
): Promise<WorkspaceBrandingView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "workspace.update");
    const current = await uow.branding.find();
    if (current?.logo !== null && current?.logo !== undefined) {
      const now = deps.clock.now();
      await uow.branding.clearLogo(now);
      await recordActivity(uow, {
        action: "workspace.branding_changed", actorUserId: actor.userId, occurredAt: now,
        details: { changed: "logo removed" },
      });
    }
    return project(uow, access);
  });
}

/** Back to the LAGDA defaults: sender, tagline, colour and logo. The name stays. */
export async function resetWorkspaceBranding(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: BrandingDependencies,
): Promise<WorkspaceBrandingView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    const access = await authorize(uow, actor, "workspace.update");
    const current = await uow.branding.find();
    if (current !== null) {
      const now = deps.clock.now();
      await uow.branding.saveSettings({ senderDisplayName: null, footerTagline: null, primaryColor: null }, now);
      if (current.logo !== null) await uow.branding.clearLogo(now);
      await recordActivity(uow, {
        action: "workspace.branding_changed", actorUserId: actor.userId, occurredAt: now,
        details: { changed: "reset to the defaults" },
      });
    }
    return project(uow, access);
  });
}

export async function getWorkspaceLogo(
  actor: AuthenticatedActor, workspaceId: WorkspaceId, deps: Pick<BrandingDependencies, "transactions">,
): Promise<(WorkspaceLogoImage & { readonly mediaType: "image/png" }) | null> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "workspace.view");
    return uow.branding.findLogo();
  });
}

