// Public document verification (BACKEND-42).
//
// A narrow read-only capability over ONE successfully completed LAGDA record.
// It is not public workspace access, and the shape of this module is what keeps
// those two things apart.
//
// ── Two outcomes, deliberately ─────────────────────────────────────────────
//
// The product's `TransactionRecordStatus` has eleven members, including
// `record-found-in-progress`, `-draft`, `-cancelled`, `-declined`, `-expired`
// and `-archived`. Every one of those tells an anonymous caller that a signing
// request EXISTS and what state it is in.
//
// That is tenant disclosure through an unauthenticated endpoint. A
// `record-found-declined` response would tell a stranger holding a leaked
// reference that a named party refused to sign — §19, §21 and §22 all forbid
// it, and nothing in the completed-document use case needs it.
//
// So this returns `completed` or `not-found`, and nothing else. The richer
// vocabulary stays available to the AUTHENTICATED `/app/verify` surface, whose
// caller already holds workspace authorization.

import type { Sha256Digest, VerificationId } from "@lagda/contracts";
import type { PublicVerificationLookup } from "../common/ports/index.js";

/**
 * The version of the PUBLIC contract, not of the seal or the pipeline.
 *
 * §144. A public response shape that evolves without a version leaves every
 * consumer guessing which fields they may rely on.
 */
export const PUBLIC_VERIFICATION_SCHEMA_VERSION = "public-verification-v1" as const;

/**
 * The canonical verification reference format.
 *
 * **Stricter than the frontend's parser, on purpose.** The product's
 * `VER_ID_RE` is `/^LAGDA-VER-\d{4}-\w{4,10}$/i` and would happily accept a
 * FOUR-character suffix — roughly 8 million values, enumerable at any plausible
 * public rate limit.
 *
 * LAGDA mints ten. Nothing has ever minted fewer (no completion existed before
 * BACKEND-41), so requiring the full length costs nothing and closes the door
 * on a short reference ever resolving — including one minted by some future
 * code path that reads the frontend regex and takes its lower bound.
 *
 * A malformed reference is rejected BEFORE the database is touched, which also
 * means a probe with a short id costs nothing to serve.
 */
const CANONICAL_VERIFICATION_ID = /^LAGDA-VER-\d{4}-[0-9A-Za-z]{10}$/;

/**
 * Parses user input into a verification reference, or refuses.
 *
 * Trims surrounding whitespace — a reference gets copied out of a PDF and
 * pasted, and leading space is not the user's mistake to pay for. Internal
 * characters are never altered (§164), and case is NOT normalized: the
 * identifier's alphabet is case-sensitive, so lowercasing would map two
 * distinct references onto one.
 */
export function parseVerificationId(raw: string): VerificationId | null {
  const trimmed = raw.trim();
  return CANONICAL_VERIFICATION_ID.test(trimmed) ? (trimmed as VerificationId) : null;
}

// ── The public result ────────────────────────────────────────────────────────

/**
 * What an anonymous caller may learn.
 *
 * An explicit allowlist. Deliberately absent: workspace id, signing request id,
 * document id, artifact ids, completion run id, seal id, storage keys, signer
 * names, signer emails, IP addresses, user agents, signature representations,
 * field values, and every evidence event.
 *
 * `participantCount` is the only thing said about the people involved — how
 * MANY acted, never who. Adding names to a public, indexable endpoint is not a
 * decision that can be reversed once search engines have it.
 */
export interface PublicVerificationView {
  readonly schemaVersion: typeof PUBLIC_VERIFICATION_SCHEMA_VERSION;
  readonly verificationId: VerificationId;
  /** When LAGDA completed the final artifact. Not any signer's time. */
  readonly completedAt: number;
  readonly participantCount: number;
  readonly finalDocument: {
    readonly digestAlgorithm: "sha-256";
    /** The authoritative byte-integrity value for the completed document. */
    readonly digest: Sha256Digest;
  };
  readonly seal: {
    readonly scheme: "hash-evidence";
    readonly version: number;
    readonly digestAlgorithm: "sha-256";
    /**
     * A plain-language description of what the seal IS.
     *
     * Mapped from scheme and version rather than composed at the call site, so
     * one wording exists and it changes only when the scheme does.
     */
    readonly description: string;
  };
}

export type PublicVerificationResult =
  | { readonly outcome: "completed"; readonly view: PublicVerificationView }
  /**
   * Absent, malformed, restricted, or not completed — ALL of them.
   *
   * Collapsed on purpose. A caller able to distinguish "no such reference" from
   * "exists but is not completed" has an oracle for which references exist and
   * for the state of other people's documents.
   */
  | { readonly outcome: "not-found" };

/**
 * The public seal description, by scheme.
 *
 * A total record over the closed scheme vocabulary: a new scheme without a
 * description is a compile error rather than an unlabelled response.
 *
 * The wording says what LAGDA did and stops. §133 — it must not imply PAdES,
 * X.509, PNPKI, RFC 3161, HSM, notarization or identity verification, because
 * LAGDA implements none of them.
 */
const SEAL_DESCRIPTIONS: Readonly<Record<"hash-evidence", string>> = Object.freeze({
  "hash-evidence":
    "LAGDA completed this document using its versioned hash and evidence "
    + "sealing process. The completed document is identified by the SHA-256 "
    + "digest shown above. This record confirms what LAGDA holds; it is not a "
    + "digital signature certificate and does not verify signer identity.",
});

// ── The use case ─────────────────────────────────────────────────────────────

export interface PublicVerificationDependencies {
  readonly lookup: PublicVerificationLookup;
}

/**
 * Resolves a verification reference to the public view, or reports not-found.
 *
 * Read-only in every sense: it writes no row, records no evidence event, and
 * creates no signing-viewed fact. Someone verifying a document publicly is not
 * a participant in it (§97, §98).
 */
export async function getPublicVerification(
  rawVerificationId: string,
  deps: PublicVerificationDependencies,
): Promise<PublicVerificationResult> {
  const verificationId = parseVerificationId(rawVerificationId);
  // Refused before the database is touched, so a malformed probe costs nothing.
  if (verificationId === null) return { outcome: "not-found" };

  const record = await deps.lookup.findByVerificationId(verificationId);
  if (record === null) return { outcome: "not-found" };

  return {
    outcome: "completed",
    view: {
      schemaVersion: PUBLIC_VERIFICATION_SCHEMA_VERSION,
      verificationId: record.verificationId,
      completedAt: record.completedAt,
      participantCount: record.participantCount,
      finalDocument: {
        digestAlgorithm: record.digestAlgorithm,
        // The SIGNED document's digest — the completed artifact a holder would
        // hash. Not `originalDocumentHash`, which is the pre-signature upload
        // and would never match a completed file.
        digest: record.signedDocumentHash,
      },
      seal: {
        scheme: record.sealScheme,
        version: record.sealVersion,
        digestAlgorithm: record.digestAlgorithm,
        description: SEAL_DESCRIPTIONS[record.sealScheme],
      },
    },
  };
}

// ── File comparison ──────────────────────────────────────────────────────────

export type FileComparisonOutcome =
  | { readonly outcome: "not-found" }
  | {
    readonly outcome: "compared";
    readonly matches: boolean;
    readonly digestAlgorithm: "sha-256";
    readonly authoritativeDigest: Sha256Digest;
    readonly uploadedDigest: Sha256Digest;
  };

/**
 * Compares an uploaded file's digest against the completed artifact's.
 *
 * The digest is computed by the CALLER — the route, streaming — and passed in
 * here already computed. This function never sees bytes, which is what keeps
 * the use case free of upload plumbing and makes it trivially testable.
 *
 * **The caller must compute it server-side.** §59: a client-supplied hash is a
 * claim about a file nobody checked, and accepting one would make the whole
 * comparison decorative.
 *
 * A mismatch is a SUCCESSFUL comparison (§168). It is not an error, and it is
 * not evidence of forgery — the commonest cause is a viewer that re-saved the
 * PDF, which changes bytes without changing anything a reader would notice.
 */
export async function compareUploadedFile(
  input: {
    readonly rawVerificationId: string;
    /** Computed server-side, over the exact uploaded bytes. */
    readonly uploadedDigest: Sha256Digest;
  },
  deps: PublicVerificationDependencies,
): Promise<FileComparisonOutcome> {
  const verificationId = parseVerificationId(input.rawVerificationId);
  if (verificationId === null) return { outcome: "not-found" };

  const record = await deps.lookup.findByVerificationId(verificationId);
  if (record === null) return { outcome: "not-found" };

  return {
    outcome: "compared",
    // Both values are public integrity data, so a timing-safe comparison buys
    // nothing here — but nothing is lost by comparing whole strings either.
    matches: input.uploadedDigest === record.signedDocumentHash,
    digestAlgorithm: record.digestAlgorithm,
    authoritativeDigest: record.signedDocumentHash,
    uploadedDigest: input.uploadedDigest,
  };
}
