// 083. Verify Document access: an emailed six-digit code, redeemed for a
// short-lived access grant.
//
// The store is NOT part of any unit of work. A caller holding only a
// verification ID has no tenant, so every method resolves the completed
// document through 075's public-verification realm first, then enters THAT
// document's workspace before touching a challenge or a grant. Every method
// re-derives "is this a completed record with this participant" from scratch.

import type { VerificationId, WorkspaceId } from "@lagda/contracts";
import type { NotificationRepository } from "./notifications.js";

/** The participant a verification ID and an address resolved to. */
export interface VerificationParticipantTarget {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: string;
  readonly requestRecipientId: string;
  readonly recipientName: string;
  /** The participant row's own delivery address — never the typed one. */
  readonly destination: string;
  readonly recipientType: string;
  readonly documentTitle: string;
}

export interface NewVerificationAccessChallenge {
  readonly verificationId: VerificationId;
  readonly normalizedEmail: string;
  readonly challengeId: string;
  readonly codeDigest: string;
  readonly sealedCode: string;
  readonly sealedKeyVersion: string;
  readonly now: number;
  readonly expiresAt: number;
}

export interface NewVerificationAccessGrant {
  readonly grantId: string;
  readonly tokenDigest: string;
  readonly expiresAt: number;
}

export type ChallengeRedemption =
  | { readonly outcome: "granted"; readonly target: VerificationParticipantTarget }
  | { readonly outcome: "denied" };

/** What the details summary is computed from. Raw; masking happens above. */
export interface VerificationDetailsProjection {
  readonly documentTitle: string;
  readonly completedAt: number;
  readonly sealedDigest: string;
  readonly participants: readonly {
    readonly requestRecipientId: string;
    readonly name: string;
    readonly email: string;
    readonly recipientType: string;
    readonly routingOrder: number;
    readonly orderIndex: number;
  }[];
  readonly events: readonly {
    readonly eventType: string;
    readonly recipientId: string | null;
    readonly occurredAt: number;
  }[];
}

export interface VerificationGrantDocumentRef {
  readonly storageReference: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface VerificationAccessStore {
  /**
   * Supersedes the live challenge for this address and document, stores the
   * new one and raises its notification — all in ONE transaction. Returns
   * false, writing nothing, when there is no such participant.
   */
  issueChallenge(
    input: NewVerificationAccessChallenge,
    notify: (
      target: VerificationParticipantTarget,
      notifications: NotificationRepository,
      transaction: unknown,
    ) => Promise<void>,
  ): Promise<boolean>;

  /**
   * Redeems the live challenge. A mismatch spends an attempt (and kills the
   * challenge at `maxAttempts`); a match consumes it and stores the grant.
   */
  redeemChallenge(input: {
    readonly verificationId: VerificationId;
    readonly normalizedEmail: string;
    readonly now: number;
    readonly maxAttempts: number;
    readonly matches: (challengeId: string, storedDigest: string) => boolean;
    readonly grant: NewVerificationAccessGrant;
  }): Promise<ChallengeRedemption>;

  /** A signed-in participant's grant. Null when there is no such participant. */
  issueMemberGrant(input: {
    readonly verificationId: VerificationId;
    readonly normalizedEmail: string;
    readonly userId: string;
    readonly now: number;
    readonly grant: NewVerificationAccessGrant;
  }): Promise<VerificationParticipantTarget | null>;

  /** Null for an unknown, expired or other-document grant. */
  findDetails(input: {
    readonly verificationId: VerificationId;
    readonly tokenDigest: string;
    readonly now: number;
  }): Promise<(VerificationDetailsProjection & {
    readonly target: VerificationParticipantTarget;
    readonly expiresAt: number;
  }) | null>;

  /** Null for an unknown, expired or other-document grant. */
  findDocumentRef(input: {
    readonly verificationId: VerificationId;
    readonly tokenDigest: string;
    readonly now: number;
  }): Promise<VerificationGrantDocumentRef | null>;
}

/** The credentials. Implemented in the API's security module. */
export interface VerificationAccessCrypto {
  /** Six uniformly random decimal digits. */
  newCode(): string;
  /** Domain-separated, salted by the challenge id. Hex SHA-256. */
  digestCode(challengeId: string, code: string): string;
  /** Constant-time comparison of two hex digests. */
  digestsEqual(left: string, right: string): boolean;
  /** Seals the code for the notification worker. */
  sealCode(code: string): { readonly sealed: string; readonly keyVersion: string };
  /** A random 256-bit token and its digest. */
  issueGrantToken(): { readonly raw: string; readonly digest: string };
  /** Null when the value cannot be a token (refused by shape). */
  digestGrantToken(raw: string): string | null;
  nextChallengeId(): string;
  nextGrantId(): string;
}
