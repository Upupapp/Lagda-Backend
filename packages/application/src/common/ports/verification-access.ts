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

/**
 * 087. What an access code or grant rests on. A code is only ever for an
 * entry on the access list (a participant, an accepted share, an approved
 * request); a SIGNED-IN grant may also rest on workspace membership — the
 * document's owner, or a holder of `document.share.manage`.
 */
export type VerificationAccessBasis =
  | "participant" | "share" | "access-request" | "document-owner" | "workspace-administrator";

/** The entry on the access list a verification ID and an address resolved to. */
export interface VerificationParticipantTarget {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: string;
  readonly basis: VerificationAccessBasis;
  /** Set exactly for a `participant`. */
  readonly requestRecipientId: string | null;
  /** Set exactly for a `share`. */
  readonly shareId: string | null;
  /** Set exactly for an `access-request`. */
  readonly accessRequestId: string | null;
  /** The account behind a share, request or membership; null for a participant. */
  readonly userId: string | null;
  readonly recipientName: string;
  /**
   * The access-list row's own delivery address — the participant row's, the
   * share's or the request's — never the typed one.
   */
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
   * false, writing nothing, when the address is not on the access list
   * (participants, accepted shares, approved requests — 087).
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

  /**
   * A signed-in account's grant: a participant, an accepted share or an
   * approved request (email-matched cases need a VERIFIED address, passed as
   * `normalizedEmail`, else null), or the document's owner or a workspace
   * owner/administrator by membership. Null when none applies.
   */
  issueMemberGrant(input: {
    readonly verificationId: VerificationId;
    readonly normalizedEmail: string | null;
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

// ── 085. Code-request throttling ────────────────────────────────────────────
//
// Keyed by the SELF-DECLARED (verification ID, normalized email) pair and by
// the verification ID alone — never by whether either names a participant.
// Every pair is treated identically, so a refusal says nothing about who is
// on a document. The adapter stores only digests of both keys.

/** The throttle thresholds, from the policy registry. */
export interface VerificationThrottleRules {
  /** Minimum gap between two accepted code requests for one pair. */
  readonly cooldownMs: number;
  /** Accepted code requests per pair per rolling window. */
  readonly pairDailyLimit: number;
  readonly pairDailyWindowMs: number;
  /** Accepted code requests per verification ID (all emails) per rolling window. */
  readonly verificationHourlyLimit: number;
  readonly verificationHourlyWindowMs: number;
  /** Wrong guesses that exhaust one (real or virtual) challenge. */
  readonly maxAttempts: number;
  /** Consecutive exhausted challenges that lock the pair out. */
  readonly lockoutAfterExhausted: number;
  readonly lockoutMs: number;
}

export type VerificationThrottleReason =
  | "lockout" | "cooldown" | "pair-daily" | "verification-hourly";

export type VerificationCodeReservation =
  | { readonly outcome: "allowed" }
  | {
    readonly outcome: "limited";
    readonly reason: VerificationThrottleReason;
    /** When the refusal lifts, in epoch ms. */
    readonly retryAt: number;
  };

/** Domain-separated SHA-256 hex digests of the typed pair and the reference. */
export interface VerificationThrottleKeys {
  readonly pairKey: string;
  readonly verificationKey: string;
}

export interface VerificationAccessThrottle {
  /**
   * Checks lockout, cooldown, the per-pair rolling cap and the per-verification
   * rolling cap, in that order, and — only when all pass — records the request
   * and starts a fresh challenge window for the pair. ONE transaction.
   */
  reserveCodeRequest(input: {
    readonly keys: VerificationThrottleKeys;
    readonly now: number;
    readonly rules: VerificationThrottleRules;
  }): Promise<VerificationCodeReservation>;

  /**
   * A well-formed code was presented for the pair. A failure spends one
   * attempt of the current challenge window; the attempt that exhausts it
   * extends the exhausted streak, and the streak's threshold locks the pair.
   * A success clears the window and the streak.
   */
  recordRedemption(input: {
    readonly keys: VerificationThrottleKeys;
    readonly now: number;
    readonly success: boolean;
    readonly rules: VerificationThrottleRules;
  }): Promise<void>;
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
  /** 085. The throttle's keys for a typed (verification ID, email) pair. */
  throttleKeys(verificationId: string, normalizedEmail: string): VerificationThrottleKeys;
  nextChallengeId(): string;
  nextGrantId(): string;
}
