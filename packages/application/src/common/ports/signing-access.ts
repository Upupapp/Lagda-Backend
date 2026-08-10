// Signing access provisioning ports (BACKEND-33).
//
// ── What a bootstrap credential is, and is not ─────────────────────────────
//
// It authorizes ONE thing: beginning the recipient-access ceremony for one
// `SigningRequestRecipient`. It is a bearer secret in an email, and possession
// of it proves possession of the email — nothing about who a person is, and
// nothing about consent.
//
// BACKEND-34 turns it into a recipient context, after whatever authentication
// the product requires. Until then it opens a door and grants nothing behind it.
//
// ── Why these ports exist rather than direct crypto ────────────────────────
//
// The application layer must not depend on `@lagda/api`, where `node:crypto`
// lives. Every credential in LAGDA follows the same shape: a factory port here,
// an adapter there, one adapter per purpose so digest domains cannot collide.

import type { WorkspaceId, RecipientWorkflowState } from "@lagda/contracts";
import type {
  SigningRequestId, SigningRequestRecipientId,
} from "./signing-requests.js";

/**
 * SHA-256 of a raw bootstrap credential, domain-separated.
 *
 * A distinct brand from `InvitationTokenDigest`, `SessionTokenDigest` and the
 * rest. Seven credential types now digest to 64 hex characters, and the brands
 * are what stop one resolving as another — a verification token must never
 * open a signing link.
 */
export type SigningAccessDigest = string & { readonly __brand: "SigningAccessDigest" };

/** An encrypted value, recoverable by the server. The `SealedSecret` shape. */
export type SealedDeliverySecret =
  string & { readonly __brand: "SealedDeliverySecret" };

export type SigningAccessGrantId = string & { readonly __brand: "SigningAccessGrantId" };
export type DeliveryIntentId = string & { readonly __brand: "DeliveryIntentId" };

/**
 * Issues and digests signing bootstrap credentials.
 *
 * `issue()` returns the raw credential EXACTLY ONCE. It is sealed into a
 * delivery intent inside the same transaction and then dropped from memory;
 * nothing else may retain it.
 *
 * `digest()` returns null for anything that cannot be a credential — wrong
 * length, wrong alphabet, control characters — so BACKEND-34 can reject
 * garbage without a database round trip.
 */
export interface SigningAccessTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: SigningAccessDigest };
  readonly digest: (submitted: string) => SigningAccessDigest | null;
}

/**
 * Seals a raw credential so an asynchronous renderer can recover it.
 *
 * ── The one place LAGDA stores a recoverable secret besides a TOTP seed ────
 *
 * Every other credential is a one-way digest, because the server only ever
 * COMPARES. A signing link is different: the email that carries it is rendered
 * minutes or hours after the transaction commits, by a process that was not
 * there when the credential was generated.
 *
 * OD-098 recorded exactly this as the blocker on invitation delivery, and named
 * the resolution — encrypt it the way BACKEND-23 encrypts TOTP secrets. This
 * port is that, behind an interface, with its own key configuration.
 *
 * `seal` throws when no key is configured. Send then fails BEFORE the state
 * transition, which is the required behaviour: a plaintext fallback would be
 * worse than a refusal.
 */
export interface DeliverySecretSealer {
  /** Stamped beside the sealed value, so a key can rotate without a migration. */
  readonly keyVersion: string;
  /** @throws when no key is configured, or sealing fails. */
  readonly seal: (plaintext: string) => SealedDeliverySecret;
}

/**
 * Builds the recipient-facing signing URL.
 *
 * From CONFIGURED canonical base only. Never `Host`, never
 * `X-Forwarded-Host`, never `request.hostname` — a link built from an inbound
 * header is a link an attacker chose, sent by LAGDA, carrying a real
 * credential.
 *
 * The URL is never persisted and never logged. Only the raw token is sealed;
 * the renderer rebuilds the URL, so a stored row can never carry a host.
 */
export interface SigningLinkBuilder {
  readonly build: (rawCredential: string) => string;
}

export interface SigningAccessIdGenerator {
  nextSigningAccessGrantId(): SigningAccessGrantId;
  nextDeliveryIntentId(): DeliveryIntentId;
}

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * BACKEND-37 widened this from `"waiting" | "active"` to the canonical
 * four-value union and kept the name.
 *
 * Not an alias for tidiness: BACKEND-34's bootstrap check and BACKEND-35's
 * ceremony both read this type, and widening it is what forces both to handle
 * `signed` and `declined` rather than silently treating them as "not active".
 * A separate type would have let them keep the old two-value view and answer
 * "routing-waiting" to somebody who had already signed.
 */
export type RecipientActivationState = RecipientWorkflowState;

export interface RecipientActivationRecord {
  readonly recipientId: SigningRequestRecipientId;
  readonly state: RecipientActivationState;
  readonly activatedAt: number | null;
}

export interface NewSigningAccessGrant {
  readonly grantId: SigningAccessGrantId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  /** The DIGEST. The raw credential is never persisted here. */
  readonly credentialDigest: SigningAccessDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SigningAccessGrantRecord extends NewSigningAccessGrant {
  readonly revokedAt: number | null;
}

/**
 * A durable "send this" record.
 *
 * Carries a SNAPSHOT of everything the renderer needs, because a retry hours
 * later must produce the same email — and the workspace name and the sender's
 * display name are both mutable.
 */
export interface NewDeliveryIntent {
  readonly deliveryIntentId: DeliveryIntentId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly grantId: SigningAccessGrantId;
  readonly purpose: "signing-invitation";
  /** PII. Never logged. */
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly documentTitle: string;
  readonly senderDisplayName: string;
  readonly workspaceName: string;
  /** The sealed RAW TOKEN, not the URL. */
  readonly sealedCredential: SealedDeliverySecret;
  readonly sealedKeyVersion: string;
  readonly createdAt: number;
}

/**
 * Send-side persistence, bound to ONE workspace and ONE transaction.
 *
 * ── Methods that are deliberately absent ───────────────────────────────────
 *
 *   findGrantByDigest       BACKEND-34's, on a narrow public path. A workspace
 *                           repository that could resolve a credential would be
 *                           a workspace repository that could impersonate a
 *                           recipient
 *   revokeGrant             BACKEND-34, with the lifecycle that needs it
 *   markDispatched          BACKEND-45, with the provider that calls it
 *   listPendingIntents      BACKEND-45's dispatcher. The partial index exists
 *   updateActivation        BACKEND-37, when a cohort completes
 */
export interface ScopedSigningAccessRepository {
  /** @throws if a record's workspace differs from the bound scope. */
  insertGrant(grant: NewSigningAccessGrant): Promise<void>;
  insertDeliveryIntent(intent: NewDeliveryIntent): Promise<void>;
  /** The whole activation plan, in one statement group. */
  insertActivations(input: {
    readonly signingRequestId: SigningRequestId;
    readonly activations: readonly RecipientActivationRecord[];
    readonly createdAt: number;
  }): Promise<void>;
  /** For assertions and for BACKEND-37's later cohort advance. */
  listActivations(
    signingRequestId: SigningRequestId,
  ): Promise<readonly RecipientActivationRecord[]>;
}
