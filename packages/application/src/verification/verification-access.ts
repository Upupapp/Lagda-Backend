// Verify Document access by emailed code (083). Replaces OD-135's
// email-only unlock.
//
//   1. requestVerificationAccessCode   {email} -> always "sent"
//   2. redeemVerificationAccessCode    {email, code} -> access grant | denied
//   3. resolveVerificationAccessDocument / getVerificationAccessDetails
//                                       {accessToken} -> PDF / details | denied
//   4. grantMemberVerificationAccess   signed-in, VERIFIED account email -> grant
//
// ── No oracle ─────────────────────────────────────────────────────────────
//
// Step 1 answers identically whether or not the address is a participant,
// and does the same credential work (mint, digest, seal) in both cases, so
// neither the body nor the obvious timing says which addresses are on a
// document. Every negative in steps 2–4 collapses into one "denied".
//
// ── Stored secrets ────────────────────────────────────────────────────────
//
// A code is stored as a digest salted by its challenge id; a grant token as a
// digest. The sealed copy of a code exists only so the notification worker
// can render it, and only while the challenge is live.

import type { VerificationId } from "@lagda/contracts";
import { validateRecipientEmail } from "@lagda/core";
import type { Clock } from "../common/ports/index.js";
import type {
  VerificationAccessStore, VerificationAccessCrypto, VerificationDetailsProjection,
  VerificationParticipantTarget,
} from "../common/ports/verification-access.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
  EvidenceEventType,
} from "../common/ports/index.js";
import { EVIDENCE_EVENT_TYPES } from "../common/ports/index.js";
import type { ObjectStorage } from "../common/ports/storage.js";
import { toStorageObjectKey } from "../common/ports/storage.js";
import { ResourceConflictError } from "../common/errors/index.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import { EVENT_VISIBILITY, describeEvidenceEvent } from "../audit/audit-trail.js";
import { parseVerificationId } from "./public-verification.js";

export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
export const VERIFICATION_GRANT_TTL_MS = 30 * 60 * 1000;
export const VERIFICATION_CODE_MAX_ATTEMPTS = 5;

const CODE_PATTERN = /^\d{6}$/u;

export interface VerificationAccount {
  readonly normalizedEmail: string;
  readonly emailVerified: boolean;
}

export interface VerificationAccessDependencies {
  readonly store: VerificationAccessStore;
  readonly crypto: VerificationAccessCrypto;
  readonly clock: Clock;
  readonly templates: NotificationTemplateRegistry;
  readonly ids: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly storage: ObjectStorage;
  /** The signed-in account's CURRENT address, read from the account itself. */
  readonly currentAccount: (userId: string) => Promise<VerificationAccount | null>;
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface VerificationCodeSent {
  readonly sent: true;
  readonly expiresInSeconds: number;
}

export type ParticipantStatus =
  | "signed" | "approved" | "declined" | "skipped" | "viewed" | "no-action";

export interface VerificationDetailsView {
  readonly documentTitle: string;
  readonly completedAt: number;
  readonly sealedDigest: string;
  readonly participants: readonly {
    readonly name: string;
    readonly maskedEmail: string;
    readonly recipientType: string;
    readonly status: ParticipantStatus;
    readonly actedAt: number | null;
    readonly routingOrder: number;
  }[];
  readonly events: readonly {
    readonly type: string;
    readonly label: string;
    readonly at: number;
  }[];
}

export type VerificationAccessResult =
  | {
    readonly outcome: "granted";
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly documentTitle: string;
    readonly recipientType: string;
    readonly details: VerificationDetailsView;
  }
  | { readonly outcome: "denied" };

export type VerificationDetailsResult =
  | { readonly outcome: "granted"; readonly details: VerificationDetailsView }
  | { readonly outcome: "denied" };

export interface VerificationDocumentStream {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

export type VerificationDocumentResult =
  | { readonly outcome: "found"; readonly document: VerificationDocumentStream }
  | { readonly outcome: "denied" };

/** Storage named the object; the object was not there. Not a client error. */
export class VerificationDocumentUnavailableError extends ResourceConflictError {
  constructor() {
    super("The completed document's stored bytes could not be read.");
  }
}

const DENIED = { outcome: "denied" } as const;

// ── Presentation ─────────────────────────────────────────────────────────────

/** "j•••@example.com": first character, a fixed mask, and the domain. */
export function maskParticipantEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.charAt(0)}•••${email.slice(at)}`;
}

const OUTCOME_STATUS: Partial<Record<string, ParticipantStatus>> = {
  "signature-completed": "signed",
  "approval-completed": "approved",
  "participant-declined": "declined",
  "participant-skipped": "skipped",
};

const KNOWN_TYPES: ReadonlySet<string> = new Set(EVIDENCE_EVENT_TYPES);

/** The details summary: masked participants and a short audit timeline. */
export function presentVerificationDetails(
  projection: VerificationDetailsProjection,
): VerificationDetailsView {
  const events = [...projection.events].sort((a, b) => a.occurredAt - b.occurredAt);

  const participants = [...projection.participants]
    .sort((a, b) => a.routingOrder - b.routingOrder || a.orderIndex - b.orderIndex)
    .map(participant => {
      let status: ParticipantStatus = "no-action";
      let actedAt: number | null = null;
      for (const event of events) {
        if (event.recipientId !== participant.requestRecipientId) continue;
        const outcome = OUTCOME_STATUS[event.eventType];
        if (outcome !== undefined) {
          status = outcome;
          actedAt = event.occurredAt;
        } else if (event.eventType === "document-viewed" && status === "no-action") {
          status = "viewed";
          actedAt = event.occurredAt;
        }
      }
      return {
        name: participant.name,
        maskedEmail: maskParticipantEmail(participant.email),
        recipientType: participant.recipientType,
        status,
        actedAt,
        routingOrder: participant.routingOrder,
      };
    });

  const timeline = events
    .filter(event => KNOWN_TYPES.has(event.eventType)
      && EVENT_VISIBILITY[event.eventType as EvidenceEventType] === "timeline")
    .map(event => ({
      type: event.eventType,
      label: describeEvidenceEvent(event.eventType as EvidenceEventType),
      at: event.occurredAt,
    }));

  return {
    documentTitle: projection.documentTitle,
    completedAt: projection.completedAt,
    sealedDigest: projection.sealedDigest,
    participants,
    events: timeline,
  };
}

// ── 1. Request a code ────────────────────────────────────────────────────────

const SENT: VerificationCodeSent = Object.freeze({
  sent: true, expiresInSeconds: VERIFICATION_CODE_TTL_MS / 1000,
});

/**
 * Always "sent". A code is created and emailed only when the address is a
 * participant of the completed document; nothing in the answer says which.
 */
export async function requestVerificationAccessCode(
  rawVerificationId: string,
  rawEmail: string,
  deps: VerificationAccessDependencies,
): Promise<VerificationCodeSent> {
  // The same credential work on every path, so the fast refusals below do not
  // stand out from the full one.
  const challengeId = deps.crypto.nextChallengeId();
  const code = deps.crypto.newCode();
  const codeDigest = deps.crypto.digestCode(challengeId, code);
  const sealed = deps.crypto.sealCode(code);

  const verificationId = parseVerificationId(rawVerificationId);
  const email = validateRecipientEmail(rawEmail);
  if (verificationId === null || !email.ok) return SENT;

  const now = deps.clock.now();
  await deps.store.issueChallenge({
    verificationId,
    normalizedEmail: email.key,
    challengeId,
    codeDigest,
    sealedCode: sealed.sealed,
    sealedKeyVersion: sealed.keyVersion,
    now,
    expiresAt: now + VERIFICATION_CODE_TTL_MS,
  }, async (target, notifications, transaction) => {
    await createNotificationIntent({
      notifications, templates: deps.templates, ids: deps.ids, clock: deps.clock,
    })({
      notificationType: "VERIFICATION_ACCESS_CODE",
      sourceId: challengeId,
      scope: { kind: "WORKSPACE", workspaceId: target.workspaceId },
      audience: {
        kind: "SIGNING_REQUEST_RECIPIENT",
        signingRequestRecipientId: target.requestRecipientId as never,
      },
      destination: target.destination,
      templateInput: {
        recipientName: target.recipientName,
        documentTitle: target.documentTitle,
      },
      secretRef: { kind: "CHALLENGE", challengeId },
    }, transaction);
  });
  return SENT;
}

// ── 2. Redeem it ─────────────────────────────────────────────────────────────

async function grantedPayload(
  verificationId: VerificationId,
  token: { readonly raw: string; readonly digest: string },
  target: VerificationParticipantTarget,
  deps: VerificationAccessDependencies,
): Promise<VerificationAccessResult> {
  const found = await deps.store.findDetails({
    verificationId, tokenDigest: token.digest, now: deps.clock.now(),
  });
  if (found === null) return DENIED;
  return {
    outcome: "granted",
    accessToken: token.raw,
    expiresAt: found.expiresAt,
    documentTitle: target.documentTitle,
    recipientType: target.recipientType,
    details: presentVerificationDetails(found),
  };
}

export async function redeemVerificationAccessCode(
  rawVerificationId: string,
  rawEmail: string,
  rawCode: string,
  deps: VerificationAccessDependencies,
): Promise<VerificationAccessResult> {
  const verificationId = parseVerificationId(rawVerificationId);
  if (verificationId === null) return DENIED;
  const email = validateRecipientEmail(rawEmail);
  if (!email.ok) return DENIED;
  const code = rawCode.trim();
  if (!CODE_PATTERN.test(code)) return DENIED;

  const now = deps.clock.now();
  const token = deps.crypto.issueGrantToken();
  const redemption = await deps.store.redeemChallenge({
    verificationId,
    normalizedEmail: email.key,
    now,
    maxAttempts: VERIFICATION_CODE_MAX_ATTEMPTS,
    matches: (challengeId, storedDigest) =>
      deps.crypto.digestsEqual(deps.crypto.digestCode(challengeId, code), storedDigest),
    grant: {
      grantId: deps.crypto.nextGrantId(),
      tokenDigest: token.digest,
      expiresAt: now + VERIFICATION_GRANT_TTL_MS,
    },
  });
  if (redemption.outcome === "denied") return DENIED;
  return grantedPayload(verificationId, token, redemption.target, deps);
}

// ── Signed-in participants ───────────────────────────────────────────────────

/**
 * No code for a signed-in account whose VERIFIED address is a participant —
 * the account already proved that mailbox. Anything else is the same denial,
 * and the caller falls back to the code flow.
 */
export async function grantMemberVerificationAccess(
  userId: string,
  rawVerificationId: string,
  deps: VerificationAccessDependencies,
): Promise<VerificationAccessResult> {
  const verificationId = parseVerificationId(rawVerificationId);
  if (verificationId === null) return DENIED;
  const account = await deps.currentAccount(userId);
  if (account === null || !account.emailVerified) return DENIED;

  const now = deps.clock.now();
  const token = deps.crypto.issueGrantToken();
  const target = await deps.store.issueMemberGrant({
    verificationId,
    normalizedEmail: account.normalizedEmail,
    userId,
    now,
    grant: {
      grantId: deps.crypto.nextGrantId(),
      tokenDigest: token.digest,
      expiresAt: now + VERIFICATION_GRANT_TTL_MS,
    },
  });
  if (target === null) return DENIED;
  return grantedPayload(verificationId, token, target, deps);
}

// ── 3. Use the grant ─────────────────────────────────────────────────────────

export async function getVerificationAccessDetails(
  rawVerificationId: string,
  rawToken: string,
  deps: VerificationAccessDependencies,
): Promise<VerificationDetailsResult> {
  const verificationId = parseVerificationId(rawVerificationId);
  if (verificationId === null) return DENIED;
  const tokenDigest = deps.crypto.digestGrantToken(rawToken);
  if (tokenDigest === null) return DENIED;
  const found = await deps.store.findDetails({ verificationId, tokenDigest, now: deps.clock.now() });
  if (found === null) return DENIED;
  return { outcome: "granted", details: presentVerificationDetails(found) };
}

export async function resolveVerificationAccessDocument(
  rawVerificationId: string,
  rawToken: string,
  deps: VerificationAccessDependencies,
): Promise<VerificationDocumentResult> {
  const verificationId = parseVerificationId(rawVerificationId);
  if (verificationId === null) return DENIED;
  const tokenDigest = deps.crypto.digestGrantToken(rawToken);
  if (tokenDigest === null) return DENIED;
  const ref = await deps.store.findDocumentRef({ verificationId, tokenDigest, now: deps.clock.now() });
  if (ref === null) return DENIED;

  const content = await deps.storage.getObject({
    zone: "artifacts", key: toStorageObjectKey(ref.storageReference),
  });
  if (content === null) throw new VerificationDocumentUnavailableError();
  return {
    outcome: "found",
    document: { mediaType: ref.mediaType, sizeBytes: ref.sizeBytes, stream: content.stream },
  };
}
