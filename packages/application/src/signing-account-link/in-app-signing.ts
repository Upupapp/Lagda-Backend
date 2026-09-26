// "Documents I must sign" and "Signed by me", and continuing to sign from the
// app (migrations 055, 056).
//
// ── What changes, and what does not ───────────────────────────────────────
//
// signing-account-link.ts states the rule this module bends: the account
// AUGMENTS the emailed credential and never replaces it. Continuing from the
// app is, by definition, starting from the account. So the substance of the
// rule is kept rather than its letter:
//
//   The ceremony is still entered through the recipient's OWN grant. The
//   code minted here carries the grant's digest, and consuming it bootstraps
//   exactly as the emailed link does -- so a revoked or expired grant, a
//   cancelled or completed request, or a recipient not yet active all refuse
//   here too, by the same check.
//
//   What stands in for possession of the link is what the link proved:
//   control of the address it was sent to. The account's address must be
//   VERIFIED and must equal the invitation's, checked now rather than
//   trusted from when the entry was written.
//
//   And the password is re-entered, the same step-up the account link
//   already requires, because from this moment one confirmation applies this
//   account's saved signature to a binding document.
//
// The session this opens records `account-password`, so the evidence and the
// certificate say what actually happened.

import { randomBytes } from "node:crypto";
import type { Clock } from "../common/ports/index.js";
import type { SigningAccountLinkRepository } from "../common/ports/signing-account-link.js";
import type {
  UserSigningInboxRecord, UserSignedDocumentRecord, SigningResumeIntentRepository,
  SigningResumeIntentRecord,
} from "../common/ports/user-signing-records.js";
import {
  bootstrapFromCredentialDigest, SigningLinkInvalidOrExpiredError,
  type SigningAccessDependencies, type BootstrappedSigningAccess,
} from "../signing-access/signing-access.js";
import {
  SigningLinkAddressedElsewhereError, type HandoffCodeDigester,
} from "./signing-account-link.js";

/** The same two minutes the account link uses, for the same reason. */
const RESUME_TTL_MS = 120_000;

/** Nothing to continue: no open entry for this account, or it has ended. */
export class InAppSigningUnavailableError extends Error {
  constructor() {
    super("This document is no longer waiting for your signature. It may have "
      + "been signed, declined, cancelled or expired.");
    this.name = "InAppSigningUnavailableError";
  }
}

/**
 * The password was wrong.
 *
 * Allowed to say so, unlike the account link's collapsed refusal: the caller
 * is already signed in and is naming a document from their OWN list, so this
 * is not an oracle for anybody else's account.
 */
export class InAppSigningPasswordError extends Error {
  constructor() {
    super("That password is not correct.");
    this.name = "InAppSigningPasswordError";
  }
}

/** The account's address is not verified, so it cannot stand in for the link. */
export class InAppSigningUnverifiedError extends Error {
  constructor() {
    super("Verify your email address before signing from your account.");
    this.name = "InAppSigningUnverifiedError";
  }
}

export interface BeginInAppSigningDependencies {
  readonly clock: Clock;
  readonly codes: HandoffCodeDigester;
  readonly findOpenEntry: (
    userId: string, signingRequestId: string, recipientId: string, now: number,
  ) => Promise<UserSigningInboxRecord | null>;
  readonly verifyPassword: (userId: string, password: string) => Promise<boolean>;
  readonly findIdentity: (userId: string) => Promise<{
    readonly normalizedEmail: string;
    readonly emailVerified: boolean;
  } | null>;
  readonly links: Pick<SigningAccountLinkRepository, "findLinkForRecipient" | "createLink">;
  readonly handOverSavedSignatures: (input: {
    readonly userId: string;
    readonly signingRequestId: string;
    readonly recipientId: string;
    readonly recipientSessionId: string;
    readonly at: Date;
  }) => Promise<number>;
  readonly resumeIntents: SigningResumeIntentRepository;
  readonly newSessionId: () => string;
  readonly newLinkId: () => string;
}

export interface BegunInAppSigning {
  /** Returned once, never stored. Handed to the signing page, which spends it. */
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * The second verification, then a single-use code for the signing page.
 *
 * Order matters: the entry first (so a stranger's ids cost nothing to
 * refuse), then the password, then the address -- and only then anything
 * that writes.
 */
export async function beginInAppSigning(
  userId: string,
  input: { readonly signingRequestId: string; readonly recipientId: string; readonly password: string },
  deps: BeginInAppSigningDependencies,
): Promise<BegunInAppSigning> {
  const now = deps.clock.now();

  const entry = await deps.findOpenEntry(userId, input.signingRequestId, input.recipientId, now);
  if (entry === null) throw new InAppSigningUnavailableError();
  // A viewer is listed under "Others" but is never bound to an account: their
  // read-only access is the emailed link alone (058).
  if (entry.recipientType === "viewer") throw new InAppSigningUnavailableError();
  // A copy recipient's entry has no credential to open a ceremony with.
  const grantCredentialDigest = entry.grantCredentialDigest;
  if (grantCredentialDigest === null) throw new InAppSigningUnavailableError();

  if (!await deps.verifyPassword(userId, input.password)) throw new InAppSigningPasswordError();

  const identity = await deps.findIdentity(userId);
  if (identity === null) throw new InAppSigningUnavailableError();
  if (!identity.emailVerified) throw new InAppSigningUnverifiedError();
  // Checked NOW. The entry was written when the address matched; an account
  // that has since changed its address no longer holds what the link proved.
  if (identity.normalizedEmail !== entry.recipientNormalizedEmail) {
    throw new SigningLinkAddressedElsewhereError();
  }

  // Bound to the account, exactly as signing in from the ceremony binds it,
  // so the ceremony shows "Signed in as ..." and the submission writes the
  // "signed by me" record. A recipient already bound to a DIFFERENT account
  // is a contradiction, not something to overwrite.
  const existing = await deps.links.findLinkForRecipient(entry.signingRequestId, entry.recipientId);
  if (existing !== null && existing.userId !== userId) throw new InAppSigningUnavailableError();
  if (existing === null) {
    await deps.links.createLink({
      signingAccountLinkId: deps.newLinkId(),
      userId,
      workspaceId: entry.workspaceId,
      signingRequestId: entry.signingRequestId,
      recipientId: entry.recipientId,
      matchedNormalizedEmail: entry.recipientNormalizedEmail,
      linkedAt: new Date(now),
    });
  }

  // The session id is allocated HERE, so the saved marks are handed to the
  // one session this code will open and to no other.
  const signingSessionId = deps.newSessionId();
  await deps.handOverSavedSignatures({
    userId,
    signingRequestId: entry.signingRequestId,
    recipientId: entry.recipientId,
    recipientSessionId: signingSessionId,
    at: new Date(now),
  });

  const code = randomBytes(16).toString("base64url");
  const expiresAt = now + RESUME_TTL_MS;
  await deps.resumeIntents.create({
    intentDigest: deps.codes.digestHandoffCode(code),
    userId,
    signingRequestId: entry.signingRequestId,
    recipientId: entry.recipientId,
    grantCredentialDigest,
    signingSessionId,
    createdAt: now,
    expiresAt,
  });

  return { code, expiresAt };
}

/** What a list row may show. No digest, no address, no workspace filter. */
export interface SigningInboxItemView {
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly documentTitle: string;
  /** Null only for a pre-077 entry; read as a signer's. */
  readonly recipientType: string | null;
  readonly senderName: string | null;
  readonly senderEmail: string | null;
  readonly workspaceName: string | null;
  readonly invitedAt: number;
  readonly expiresAt: number;
}

export function presentInboxItem(entry: UserSigningInboxRecord): SigningInboxItemView {
  return {
    signingRequestId: entry.signingRequestId,
    recipientId: entry.recipientId,
    documentTitle: entry.documentTitle,
    recipientType: entry.recipientType,
    senderName: entry.senderName,
    senderEmail: entry.senderEmail,
    workspaceName: entry.workspaceName,
    invitedAt: entry.invitedAt,
    expiresAt: entry.expiresAt,
  };
}

export interface SignedDocumentView {
  readonly signingRequestId: string;
  readonly documentTitle: string;
  readonly senderName: string | null;
  readonly senderEmail: string | null;
  readonly workspaceName: string | null;
  readonly signedAt: number;
}

export function presentSignedDocument(record: UserSignedDocumentRecord): SignedDocumentView {
  return {
    signingRequestId: record.signingRequestId,
    documentTitle: record.documentTitle,
    senderName: record.senderName,
    senderEmail: record.senderEmail,
    workspaceName: record.workspaceName,
    signedAt: record.signedAt,
  };
}

export interface ContinueInAppSigningDependencies extends SigningAccessDependencies {
  readonly codes: HandoffCodeDigester;
  /**
   * Burns the code in a transaction of its own, committed before the
   * bootstrap runs, so a bootstrap that refuses still costs the code.
   */
  readonly consumeResumeIntent: (
    intentDigest: string, now: number,
  ) => Promise<SigningResumeIntentRecord | null>;
}

/** The code's real encoded length: 16 random bytes, base64url. */
const RESUME_CODE_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Spends a code from `beginInAppSigning` and opens the ceremony.
 *
 * Every refusal is the emailed link's refusal: this is the recipient realm,
 * where the caller has no account identity, and it must learn no more from a
 * bad code than from a bad link.
 */
export async function continueInAppSigning(
  code: string,
  deps: ContinueInAppSigningDependencies,
): Promise<BootstrappedSigningAccess> {
  if (!RESUME_CODE_SHAPE.test(code)) throw new SigningLinkInvalidOrExpiredError();
  const intent = await deps.consumeResumeIntent(deps.codes.digestHandoffCode(code), deps.clock.now());
  if (intent === null) throw new SigningLinkInvalidOrExpiredError();
  return bootstrapFromCredentialDigest(intent.grantCredentialDigest, {
    authenticationMethod: "account-password",
    signingSessionId: intent.signingSessionId,
  }, deps);
}
