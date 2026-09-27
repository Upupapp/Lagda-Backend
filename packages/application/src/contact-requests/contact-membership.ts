// Which contacts are workspace members (086), computed at READ time.
//
// ── Why this lives outside the contact module ─────────────────────────────
//
// BACKEND-28 keeps the contact use cases unable to reach an account: a contact
// is address-book data, and nothing about it is verified. The product now
// wants the address book to SAY when an entry is a colleague, so the answer is
// computed here — a read-only join of the contact's address against the
// CURRENT member directory — and handed to the contact projection. Nothing is
// stored: no column links a contact to a user, and a member who leaves stops
// matching on the next read.
//
// What leaves is a member's user id and display name, and only for a contact
// whose address the reader already holds. The directory's addresses are used
// for the comparison and never returned.

import type { UserId, WorkspaceRole } from "@lagda/contracts";
import {
  hasCapability, privilegeCapabilities, type WorkspaceCapability,
} from "@lagda/core";
import type { WorkspaceUnitOfWork } from "../common/ports/index.js";
import { normalizeEmail } from "../auth/email-identity.js";
import { privilegesOf } from "../workspaces/workspace-access.js";

/** What a contact carries about the member it matches. */
export interface ContactWorkspaceMember {
  readonly userId: UserId;
  readonly displayName: string;
}

/** A matched member, with what the request use cases need beyond the view. */
export interface ResolvedWorkspaceMember extends ContactWorkspaceMember {
  /** The member's own account address — a delivery destination, never output. */
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly canRequestDocuments: boolean;
  readonly canAssignSigners: boolean;
}

/** The normalized key for an address, or null when it cannot be one. */
function keyOf(email: string): string | null {
  const normalized = normalizeEmail(email);
  return normalized.outcome === "ok" ? normalized.normalized : null;
}

/** The current member directory, keyed by normalized account address. */
export async function memberDirectoryByEmail(
  uow: WorkspaceUnitOfWork,
): Promise<ReadonlyMap<string, ResolvedWorkspaceMember>> {
  const directory = await uow.memberships.listWithAccounts();
  const byEmail = new Map<string, ResolvedWorkspaceMember>();
  for (const member of directory) {
    const key = keyOf(member.email);
    if (key === null) continue;
    byEmail.set(key, {
      userId: member.userId,
      displayName: member.displayName,
      email: member.email,
      role: member.role,
      canRequestDocuments: member.canRequestDocuments === true,
      canAssignSigners: member.canAssignSigners === true,
    });
  }
  return byEmail;
}

/** The member a contact address belongs to in this workspace, or null. */
export function memberForAddress(
  directory: ReadonlyMap<string, ResolvedWorkspaceMember>,
  contactEmail: string,
): ResolvedWorkspaceMember | null {
  const key = keyOf(contactEmail);
  return key === null ? null : directory.get(key) ?? null;
}

/** `workspaceMember` for each contact, by contact id. */
export async function resolveContactMembers(
  uow: WorkspaceUnitOfWork,
  contacts: readonly { readonly contactId: string; readonly email: string }[],
): Promise<ReadonlyMap<string, ContactWorkspaceMember | null>> {
  const out = new Map<string, ContactWorkspaceMember | null>();
  if (contacts.length === 0) return out;
  const directory = await memberDirectoryByEmail(uow);
  for (const contact of contacts) {
    const member = memberForAddress(directory, contact.email);
    out.set(contact.contactId,
      member === null ? null : { userId: member.userId, displayName: member.displayName });
  }
  return out;
}

/** Whether a member holds a capability through their role or their grants. */
export function memberHolds(
  member: Pick<ResolvedWorkspaceMember, "role" | "canRequestDocuments" | "canAssignSigners">,
  capability: WorkspaceCapability,
): boolean {
  return hasCapability(member.role, capability)
    || privilegeCapabilities(privilegesOf(member)).includes(capability);
}
