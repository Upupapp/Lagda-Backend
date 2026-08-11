// Building the completion certificate model (BACKEND-40).
//
// Converts authoritative immutable facts into the curated
// `CompletionCertificateModelV1`. This is the only place that decides what a
// certificate says.
//
// ── Fails CLOSED, everywhere ───────────────────────────────────────────────
//
// §75 and §79. A certificate is read as a record of what happened, so a missing
// authoritative fact must stop it being produced — never be rendered as
// "Unknown", and never quietly omitted so the page merely looks shorter.
//
// The distinction that matters: a fact that is OPTIONAL BY DESIGN (a recipient
// who was never asked for consent) is absent; a fact that is REQUIRED and
// missing (a signer with no submission time) is a failure. Those two must not
// collapse into one another, because the second is corruption and the first is
// Tuesday.

import type {
  CertifiedAuthenticationMethod, CertifiedParticipantV1,
  CertifiedParticipantFacts, CompletionCertificateModelV1,
} from "../common/ports/index.js";
import {
  COMPLETION_CERTIFICATE_VERSION, maskEmailForCertificate,
} from "../common/ports/index.js";
import type { Sha256Digest } from "@lagda/contracts";

/**
 * A certificate fact that is required and absent, or inconsistent.
 *
 * Carries a BOUNDED reason and never the value that was wrong. §42: this
 * message reaches logs, and certificate inputs are signer content.
 */
export class CertificateFactMissingError extends Error {
  constructor(readonly reason: CertificateFactProblem, readonly recipientId?: string) {
    super(`The completion certificate cannot be built: ${reason}.`);
    this.name = "CertificateFactMissingError";
  }
}

export type CertificateFactProblem =
  | "no-signed-participants"
  | "missing-signed-at"
  | "unsupported-authentication-method"
  | "incomplete-consent"
  | "missing-document-title"
  | "missing-source-digest";

/**
 * The methods this certificate version can certify.
 *
 * Checked against the CLOSED product vocabulary, not merely against what the
 * renderer happens to have wording for. A method the product introduces without
 * a certificate decision must fail here, at the point the decision is missing —
 * not be labelled by whatever default the renderer would otherwise pick (§179).
 */
const CERTIFIABLE_METHODS: readonly CertifiedAuthenticationMethod[] =
  ["link-only", "email-otp"];

function certifiableMethod(value: string, recipientId: string): CertifiedAuthenticationMethod {
  const found = CERTIFIABLE_METHODS.find(candidate => candidate === value);
  if (found === undefined) {
    throw new CertificateFactMissingError("unsupported-authentication-method", recipientId);
  }
  return found;
}

export interface CertificateModelInput {
  readonly signingRequestId: string;
  readonly documentTitle: string;
  readonly sourceDocumentDigest: Sha256Digest;
  readonly participants: readonly CertifiedParticipantFacts[];
  /** Supplied by the step from its clock, never read here. */
  readonly generatedAt: number;
}

/**
 * Builds the model, or refuses.
 *
 * Deliberately pure: no repository, no clock, no storage. Everything it needs
 * has already been read, which is what makes its refusals testable without a
 * database and what stops a "just one more lookup" from reaching a mutable
 * table (§18–§21).
 */
export function buildCompletionCertificateModel(
  input: CertificateModelInput,
): CompletionCertificateModelV1 {
  if (input.documentTitle.trim().length === 0) {
    // §22: the title is a historical snapshot taken at send. An empty one means
    // the snapshot is not there, and the current Document's title must NOT be
    // substituted — that would present today's name as historical evidence.
    throw new CertificateFactMissingError("missing-document-title");
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceDocumentDigest)) {
    throw new CertificateFactMissingError("missing-source-digest");
  }
  if (input.participants.length === 0) {
    // A certificate certifying nobody would assert that a signing happened
    // with no signers in it.
    throw new CertificateFactMissingError("no-signed-participants");
  }

  const participants = input.participants.map(toCertifiedParticipant);

  return {
    certificateVersion: COMPLETION_CERTIFICATE_VERSION,
    signingRequestId: input.signingRequestId,
    documentTitle: input.documentTitle,
    sourceDocumentDigest: input.sourceDocumentDigest,
    participants,
    generatedAt: input.generatedAt,
  };
}

function toCertifiedParticipant(facts: CertifiedParticipantFacts): CertifiedParticipantV1 {
  if (!Number.isFinite(facts.signedAt) || facts.signedAt <= 0) {
    // A participant reached this list by HAVING an accepted submission, so a
    // missing signing time means the submission row is corrupt. §148.
    throw new CertificateFactMissingError("missing-signed-at", facts.recipientId);
  }

  return {
    recipientId: facts.recipientId,
    name: facts.name,
    // Masked HERE, so the renderer never holds a full address and a future
    // layout change cannot print one by accident.
    maskedEmail: maskEmailForCertificate(facts.email),
    routingOrder: facts.routingOrder,
    orderIndex: facts.orderIndex,
    authenticationMethod: certifiableMethod(facts.authenticationMethod, facts.recipientId),
    firstEnteredAt: facts.firstEnteredAt,
    consent: toConsent(facts),
    signedAt: facts.signedAt,
  };
}

/**
 * Consent, all-or-nothing.
 *
 * Absent consent is legitimate — not every recipient is asked. A PARTIAL
 * consent is not: a type with no version, or a version with no acceptance time,
 * means the record is broken, and certifying "consented" without saying to what
 * or when is exactly the overclaim §40 guards against.
 */
function toConsent(facts: CertifiedParticipantFacts): CertifiedParticipantV1["consent"] {
  const present = [facts.consentType, facts.consentVersion, facts.consentAcceptedAt]
    .filter(value => value !== null).length;

  if (present === 0) return null;
  if (present !== 3 || facts.consentType === null || facts.consentVersion === null
    || facts.consentAcceptedAt === null) {
    throw new CertificateFactMissingError("incomplete-consent", facts.recipientId);
  }

  return {
    consentType: facts.consentType,
    consentVersion: facts.consentVersion,
    acceptedAt: facts.consentAcceptedAt,
  };
}
