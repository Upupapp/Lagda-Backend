// The completion certificate seam (BACKEND-40).
//
// ── What the certificate is, stated once ───────────────────────────────────
//
// A human-readable record of what LAGDA ACTUALLY RECORDED about one signing
// request: who signed, when, how they authenticated, what they consented to,
// and the digest of the document they signed against.
//
// What it is NOT, and the product says so itself in two places
// (`CompletionPage.tsx:5`, `TransactionDetailPage.tsx:674`): a legal
// certificate, a court-admissible instrument, proof of legal identity, a KYC
// record, an X.509 or PKI certificate, or a PAdES validation report. LAGDA
// implements none of those, and the certificate must never imply otherwise.
//
// ── Curated, not a dump ────────────────────────────────────────────────────
//
// The model below is a DELIBERATE projection, not a view over the evidence
// store. Generic evidence carries user agents, internal identifiers and
// security events that must not reach a human-visible page that gets forwarded
// to third parties. Every field here was chosen; nothing arrives because it
// happened to be in a row.
//
// BACKEND-43 owns the comprehensive audit trail. This is the summary.

import type { Sha256Digest } from "@lagda/contracts";

// ── Versions ─────────────────────────────────────────────────────────────────

/**
 * The certificate's DATA SCHEMA version.
 *
 * Increments when the meaning or set of certified facts changes — never for a
 * layout change. A stored certificate must stay interpretable under the version
 * it was produced with, which a package version or a git SHA cannot express
 * (§28).
 */
export const COMPLETION_CERTIFICATE_VERSION = "completion-certificate-v1" as const;
export type CompletionCertificateVersion = typeof COMPLETION_CERTIFICATE_VERSION;

/**
 * The RENDERING version, deliberately separate (§27).
 *
 * Layout, pagination, typography and date formatting can change without the
 * certified facts changing. Two versions means a layout fix does not falsely
 * claim the evidence schema moved, and a schema change is not hidden behind a
 * visual tweak.
 */
export const COMPLETION_CERTIFICATE_RENDERER_VERSION = "certificate-renderer-v1" as const;
export type CompletionCertificateRendererVersion =
  typeof COMPLETION_CERTIFICATE_RENDERER_VERSION;

// ── The model ────────────────────────────────────────────────────────────────

/**
 * How a recipient authenticated, as the CLOSED vocabulary BACKEND-34 records.
 *
 * Mirrored rather than imported as a display string so the renderer cannot be
 * handed a method it has no wording for. An unknown value fails closed (§179);
 * it is never labelled "Verified".
 */
export type CertifiedAuthenticationMethod = "link-only" | "email-otp";

/** One acceptance of one disclosure version, exactly as recorded. */
export interface CertifiedConsent {
  readonly consentType: string;
  readonly consentVersion: string;
  readonly acceptedAt: number;
}

/**
 * One participant's certified facts.
 *
 * Only signers appear. §49: the certificate is a record of signing evidence,
 * and a recipient who took no signing action has no evidence to certify.
 */
export interface CertifiedParticipantV1 {
  /** Internal, for deterministic ordering and provenance. NOT rendered. */
  readonly recipientId: string;

  /** From the request's IMMUTABLE recipient snapshot. Never a Contact. */
  readonly name: string;

  /**
   * MASKED, and masked here rather than in the renderer.
   *
   * A certificate is the artifact most likely to be forwarded onward, and the
   * name already identifies the signer — the address is supporting delivery
   * identity (§32). The full value stays in the immutable request snapshot, so
   * nothing is lost for audit.
   *
   * Masking in the MODEL means the renderer never holds the full address, so a
   * future layout change cannot accidentally print one.
   */
  readonly maskedEmail: string;

  /** Immutable ordering from the request snapshot (§50). */
  readonly routingOrder: number;
  readonly orderIndex: number;

  /** The method actually established. Never upgraded to a stronger claim. */
  readonly authenticationMethod: CertifiedAuthenticationMethod;

  /**
   * When this recipient FIRST ENTERED the signing ceremony, if recorded.
   *
   * §7: this means an authenticated recipient opened the ceremony. It does NOT
   * mean a human read the document, and no wording derived from it may say so.
   * The first entry only — not every reload (§152).
   */
  readonly firstEnteredAt: number | null;

  /** The acceptance relevant to THIS signing, or null if none is recorded. */
  readonly consent: CertifiedConsent | null;

  /**
   * THE authoritative signing instant — `RecipientSubmission.acceptedAt`.
   *
   * Required, not optional. A participant on this certificate signed; a
   * recipient whose state says signed but has no submission is corruption, and
   * the builder fails rather than certifying a signature with no time (§75).
   * Never regenerated at certificate time (§8).
   */
  readonly signedAt: number;
}

/**
 * Everything certificate-v1 certifies.
 *
 * ── Deliberately absent, each for a stated reason ──────────────────────────
 *
 *   completedAt          §167/§168. The request is not completed yet, and
 *                        requiring it here would make the certificate depend on
 *                        a step that depends on the certificate.
 *   final sealed digest  §14/§162. Does not exist. No placeholder either.
 *   seal metadata        §163. Nothing is sealed at this point.
 *   verificationId       §15. BACKEND-41/42 own verification identity.
 *   merged digest        Owner decision, 2026-08-11: internal provenance only.
 *                        Two similar hashes on one page invite a reader to
 *                        compare the wrong one, and "merged signing candidate"
 *                        is not explicable to a signer. It lives on the
 *                        artifact record where BACKEND-41/42 can use it.
 *   this certificate's
 *   own digest           §95. Cannot be inside itself without circularity. It
 *                        is artifact metadata.
 *   IP address           Not stored as evidence anywhere in LAGDA. Measured,
 *                        not merely declined.
 *   user agent           Stored, and omitted by policy (§36).
 *   field values         §44. The certificate summarizes evidence; it is not a
 *                        second copy of the form data.
 *   signature images     §43. The signed document already renders the mark.
 */
export interface CompletionCertificateModelV1 {
  readonly certificateVersion: CompletionCertificateVersion;

  /** Opaque internal reference, carried for provenance. */
  readonly signingRequestId: string;

  /**
   * The title FROZEN on the signing request at send time.
   *
   * `signing_requests.document_title`, never the mutable Document's current
   * title (§22). Renaming a document after signing must not rewrite what the
   * certificate says was signed.
   */
  readonly documentTitle: string;

  /**
   * The digest of the document the signers signed against.
   *
   * The request's frozen `sourceArtifactId`. Labelled in the renderer as the
   * SIGNING SOURCE document — not "prepared", which names an artifact kind
   * LAGDA has never produced (preparation is metadata-only).
   */
  readonly sourceDocumentDigest: Sha256Digest;

  /** Signers, in deterministic order. At least one. */
  readonly participants: readonly CertifiedParticipantV1[];

  /**
   * When the CERTIFICATE was produced — a fact about this document, and not
   * about the signing (§9 of the command).
   *
   * Supplied, never read from a clock inside the renderer, so a retry that
   * reuses an accepted output cannot disagree with it (§111).
   */
  readonly generatedAt: number;
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface CompletionCertificateResult {
  /** The rendered certificate. */
  readonly certificate: Uint8Array;
  readonly mediaType: "application/pdf";
  /** Byte length as produced. The caller records it; it does not trust a claim. */
  readonly sizeBytes: number;
  readonly digestAlgorithm: "sha-256";
  /** Digest of the EXACT bytes above, computed after rendering. */
  readonly digest: Sha256Digest;
  readonly certificateVersion: CompletionCertificateVersion;
  readonly rendererVersion: CompletionCertificateRendererVersion;
}

/**
 * Renders a curated certificate model.
 *
 * A THIRD seam in `@lagda/sealing`, alongside `DocumentSealer` and
 * `FieldMerger`, each with one caller. It never seals, never touches storage,
 * never reads a clock, and never sees a database row — the model is already
 * curated when it arrives.
 */
export interface CompletionCertificateGenerator {
  generate(model: CompletionCertificateModelV1): Promise<CompletionCertificateResult>;
}

// ── Masking ──────────────────────────────────────────────────────────────────

/**
 * The deterministic mask (§192).
 *
 * `juan@example.com` → `j***@example.com`; `a@x.test` → `***@x.test`.
 *
 * Rules, and each is a decision:
 *
 *   - a FIXED three asterisks, never one per hidden character, so the mask does
 *     not leak the local part's length
 *   - the first character survives only when the local part has more than one,
 *     because otherwise the "mask" would reveal the entire local part
 *   - the domain is kept in full: it is delivery identity, it is what makes the
 *     masked value recognisable to the person reading it, and it is not
 *     personally identifying on its own
 *
 * Anything without a single `@` is masked ENTIRELY. A malformed address is not
 * a reason to print an unmasked string, and this function must never be the
 * thing that lets one through.
 */
export function maskEmailForCertificate(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.length > 1 ? `${local[0] ?? ""}***@${domain}` : `***@${domain}`;
}
