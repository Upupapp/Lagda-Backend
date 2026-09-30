// Ports for contact connections (091): one account asking another to become
// mutual contacts, and the exact-email lookup that finds them.
//
// Both repositories are ACCOUNT-owned (see the migration's header): every
// method takes the SESSION's user id and names it in its WHERE, so no caller
// can read or change a request it is not a party to.

import type { UserId, WorkspaceId, ContactId } from "@lagda/contracts";

export const CONTACT_CONNECTION_STATUSES = ["pending", "accepted", "declined", "cancelled"] as const;
export type ContactConnectionStatus = (typeof CONTACT_CONNECTION_STATUSES)[number];

export interface ContactConnectionRecord {
  readonly connectionId: string;
  readonly requesterUserId: UserId;
  readonly requesterWorkspaceId: WorkspaceId;
  readonly requesterWorkspaceName: string;
  readonly recipientUserId: UserId;
  readonly recipientWorkspaceId: WorkspaceId | null;
  readonly status: ContactConnectionStatus;
  readonly requesterContactId: ContactId | null;
  readonly recipientContactId: ContactId | null;
  /** Epoch milliseconds, like every record in this layer. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acceptedAt: number | null;
  readonly declinedAt: number | null;
  readonly cancelledAt: number | null;
}

export interface NewContactConnection {
  readonly connectionId: string;
  readonly requesterUserId: UserId;
  readonly requesterWorkspaceId: WorkspaceId;
  readonly requesterWorkspaceName: string;
  readonly recipientUserId: UserId;
  /** "pending", or "declined" for a request made inside a quiet window. */
  readonly status: "pending" | "declined";
  readonly declinedAt: number | null;
  readonly createdAt: number;
}

export interface ContactConnectionRepository {
  /** @throws ResourceConflictError when a pending request already joins the pair. */
  insert(connection: NewContactConnection): Promise<void>;
  /** One request, only when `userId` is its requester or its recipient. */
  findForParticipant(connectionId: string, userId: UserId): Promise<ContactConnectionRecord | null>;
  /** Every request between two accounts, in either direction, newest first. */
  listBetween(userId: UserId, otherUserId: UserId): Promise<readonly ContactConnectionRecord[]>;
  /** Pending requests addressed to this account, newest first. */
  listReceived(userId: UserId): Promise<readonly ContactConnectionRecord[]>;
  /** Pending and declined requests this account sent, newest first. */
  listSent(userId: UserId): Promise<readonly ContactConnectionRecord[]>;
  /** pending → accepted, only by its recipient. False when it was not pending. */
  markAccepted(input: {
    readonly connectionId: string; readonly recipientUserId: UserId;
    readonly recipientWorkspaceId: WorkspaceId; readonly at: number;
  }): Promise<boolean>;
  /** Records the contact each side now holds. Only on an accepted request. */
  setContacts(input: {
    readonly connectionId: string;
    readonly requesterContactId: ContactId | null;
    readonly recipientContactId: ContactId | null;
    readonly at: number;
  }): Promise<void>;
  /** pending → declined, only by its recipient. */
  markDeclined(input: { readonly connectionId: string; readonly recipientUserId: UserId; readonly at: number }): Promise<boolean>;
  /** pending or declined → cancelled, only by its requester. */
  markCancelled(input: { readonly connectionId: string; readonly requesterUserId: UserId; readonly at: number }): Promise<boolean>;
  /**
   * The account each of these contacts stands for, through an ACCEPTED
   * request that recorded it, by contact id — with the workspace that account
   * took part from (its own side of the request). Contacts with none are absent.
   */
  accountsForContacts(workspaceId: WorkspaceId, contactIds: readonly string[]): Promise<ReadonlyMap<string, {
    readonly userId: UserId; readonly workspaceId: WorkspaceId | null;
  }>>;
}

/** What LAGDA shows of an account to someone looking for it. */
export interface DirectoryPerson {
  readonly userId: UserId;
  /** The account's own address — a contact field on acceptance, never a lookup result. */
  readonly email: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly organization: string | null;
}

export interface PeopleDirectory {
  /** The account with this VERIFIED, normalized address, or null. */
  findVerifiedByEmail(normalizedEmail: string): Promise<DirectoryPerson | null>;
  findById(userId: UserId): Promise<DirectoryPerson | null>;
  findManyById(userIds: readonly UserId[]): Promise<ReadonlyMap<string, DirectoryPerson>>;
  /** No setting row means discoverable. */
  isDiscoverable(userId: UserId): Promise<boolean>;
  setDiscoverable(userId: UserId, discoverable: boolean, at: number): Promise<void>;
}

export interface ContactConnectionIdGenerator {
  nextConnectionId(): string;
}
