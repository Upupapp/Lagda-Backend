// The port the ceremony and the claim speak for prepared signatures.
//
// Mirrors @lagda/db exactly, and offers no lookup by user for the same reason
// the account-link port does not: that is the query an inbox would need, and
// this table must not become the thing an inbox is built on.

export interface PreparedSignature {
  readonly purpose: "signature" | "initials";
  readonly representationType: "TYPED_SIGNATURE_V1" | "RASTER_SIGNATURE_V1";
  readonly typedText: string | null;
  readonly typedStyleIndex: number | null;
  readonly rasterBytes: Buffer | null;
  readonly rasterMediaType: string | null;
  readonly rasterWidth: number | null;
  readonly rasterHeight: number | null;
  readonly digest: string;
  readonly sourceDigest: string;
  readonly preparedByUserId: string;
  /** Offered only back to this session. */
  readonly preparedForSessionId: string;
  readonly preparedAt: Date;
}

export interface PrepareSignatureInput extends Omit<PreparedSignature, "preparedAt"> {
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly preparedAt: Date;
}

export interface PreparedSignatureRepository {
  prepare: (input: PrepareSignatureInput) => Promise<void>;
  /**
   * What was prepared FOR THIS SESSION.
   *
   * The session is a required argument rather than an optional filter,
   * because a caller that forgets it would silently get someone else's
   * prepared signature — and the one thing this table must never do is hand
   * a mark to a browser that did not earn it.
   */
  listForSession: (
    signingRequestId: string, recipientId: string, sessionId: string,
  ) => Promise<PreparedSignature[]>;
  /** Spends every prepared row for this recipient. */
  consumeForRecipient: (
    signingRequestId: string, recipientId: string,
  ) => Promise<void>;
}
