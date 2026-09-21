// The port the account-binding use cases speak.
//
// Mirrors @lagda/db's repository exactly, and deliberately offers no lookup by
// user. Migration 051 sets out why: a query by user is the query an inbox
// would need, and this table must not become the thing an inbox is built on.
// A rule like that is kept by not writing the method, not by remembering.

export interface SigningLinkIntentRecord {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly recipientNormalizedEmail: string;
  /** The ceremony session that asked. */
  readonly recipientSessionId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface SigningAccountLinkRecord {
  readonly userId: string;
  readonly matchedNormalizedEmail: string;
  readonly linkedAt: Date;
}

export interface SigningAccountLinkRepository {
  createIntent: (input: {
    readonly intentDigest: string;
    readonly workspaceId: string;
    readonly signingRequestId: string;
    readonly recipientId: string;
    readonly recipientNormalizedEmail: string;
    readonly recipientSessionId: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }) => Promise<void>;
  claimIntent: (
    intentDigest: string, now: Date,
  ) => Promise<SigningLinkIntentRecord | null>;
  createLink: (input: {
    readonly signingAccountLinkId: string;
    readonly userId: string;
    readonly workspaceId: string;
    readonly signingRequestId: string;
    readonly recipientId: string;
    readonly matchedNormalizedEmail: string;
    readonly linkedAt: Date;
  }) => Promise<void>;
  findLinkForRecipient: (
    signingRequestId: string, recipientId: string,
  ) => Promise<SigningAccountLinkRecord | null>;
}
