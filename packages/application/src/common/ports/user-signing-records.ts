// An account's own signing records: what it has signed (migration 055) and
// what is waiting for it to sign (migration 056).
//
// Read ONLY by the owning account, by its own user id. Neither table is a
// workspace read model, and no method here takes a workspace id as a filter.
// The migrations state the rule and the authorization story in full.

/** 069 adds `approved`/`skipped` — an approver's two outcomes, closing the
 *  inbox entry exactly as `signed`/`declined` do for a signer. */
export type InboxClosedReason =
  "signed" | "approved" | "skipped" | "declined" | "cancelled";

export interface SenderSnapshot {
  readonly senderName: string | null;
  readonly senderEmail: string | null;
  readonly workspaceName: string | null;
}

export interface UserSignedDocumentRecord extends SenderSnapshot {
  readonly userId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  /** For reference only. Never a filter. */
  readonly workspaceId: string;
  readonly documentTitle: string;
  readonly signedAt: number;
  readonly recordedAt: number;
}

export interface UserSigningInboxRecord extends SenderSnapshot {
  /** Null until a verified account with this address claims it (057). */
  readonly userId: string | null;
  readonly signingRequestId: string;
  readonly recipientId: string;
  /** For reference only. Never a filter. */
  readonly workspaceId: string;
  readonly recipientNormalizedEmail: string;
  /** Never projected to a client. See migration 056. */
  readonly grantCredentialDigest: string;
  readonly documentTitle: string;
  readonly invitedAt: number;
  readonly expiresAt: number;
  readonly closedAt: number | null;
  readonly closedReason: InboxClosedReason | null;
}

export interface UserSigningRecordsRepository {
  // ── Invitation side (workspace realm, inside the provisioner) ────────────

  /** An account whose VERIFIED address is this one, or null. */
  findVerifiedAccountByEmail(normalizedEmail: string): Promise<{ readonly userId: string } | null>;
  /** The request creator's name and address, for "who sent this". */
  findUserContact(userId: string): Promise<{ readonly name: string; readonly email: string } | null>;
  /**
   * Opens, or refreshes, the entry for one invited recipient.
   *
   * A later grant for the same recipient (a re-issued link) replaces the
   * digest and the expiry of an OPEN entry. A closed one stays closed: a
   * recipient who already signed is not asked again by a stray re-issue.
   */
  openInboxEntry(entry: Omit<UserSigningInboxRecord, "closedAt" | "closedReason">): Promise<void>;
  /**
   * Gives this account every OPEN, unclaimed entry sent to its address.
   * The caller has already proved the address is verified and its own.
   */
  claimInboxForAddress(userId: string, normalizedEmail: string): Promise<number>;
  /** A sender cancelled: every open entry for the request closes. */
  closeInboxForRequest(signingRequestId: string, reason: InboxClosedReason, at: number): Promise<void>;

  // ── Ceremony side (recipient realm, inside the submission) ───────────────

  findInboxEntryForRecipient(
    signingRequestId: string, recipientId: string,
  ): Promise<UserSigningInboxRecord | null>;
  closeInboxForRecipient(
    signingRequestId: string, recipientId: string, reason: InboxClosedReason, at: number,
  ): Promise<void>;
  /** Written once. A second write for the same recipient is a no-op. */
  recordSigned(record: UserSignedDocumentRecord): Promise<void>;

  // ── Owner reads (by the authenticated user id and nothing else) ──────────

  listSignedForUser(userId: string, limit: number): Promise<readonly UserSignedDocumentRecord[]>;
  listOpenInboxForUser(userId: string, now: number, limit: number): Promise<readonly UserSigningInboxRecord[]>;
  findOpenInboxEntry(
    userId: string, signingRequestId: string, recipientId: string, now: number,
  ): Promise<UserSigningInboxRecord | null>;
}

export interface SigningResumeIntentRecord {
  readonly intentDigest: string;
  readonly userId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly grantCredentialDigest: string;
  readonly signingSessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SigningResumeIntentRepository {
  create(intent: SigningResumeIntentRecord): Promise<void>;
  /**
   * Burns the code and returns what it carried, or null if it is unknown,
   * expired or already used. A conditional update, so two racing requests
   * produce exactly one winner.
   */
  consume(intentDigest: string, now: number): Promise<SigningResumeIntentRecord | null>;
}
