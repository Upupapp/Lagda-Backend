// A saved signature handed to one ceremony.
//
// Written by the workspace realm at claim time, read and then deleted by the
// recipient realm at submission. The direction is the point: pushed once,
// deliberately, by the side that legitimately holds it — never pulled by the
// side that must not reach across.
//
// There is no `listByUser`, and there will not be one. The only question this
// table answers is "has a signature been prepared for THIS recipient of THIS
// request", which is the question the ceremony asks. Anything broader would
// be a way to enumerate someone's pending documents from their signature
// library, which is the same boundary migration 051 exists to hold.

import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema/index.js";

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

interface Row {
  purpose: string;
  representation_type: string;
  typed_text: string | null;
  typed_style_index: number | null;
  raster_bytes: Buffer | null;
  raster_media_type: string | null;
  raster_width: number | null;
  raster_height: number | null;
  digest: string;
  source_digest: string;
  prepared_by_user_id: string;
  prepared_for_session_id: string;
  prepared_at: Date;
}

function toPrepared(row: Row): PreparedSignature {
  return {
    purpose: row.purpose as PreparedSignature["purpose"],
    representationType: row.representation_type as PreparedSignature["representationType"],
    typedText: row.typed_text,
    typedStyleIndex: row.typed_style_index,
    rasterBytes: row.raster_bytes,
    rasterMediaType: row.raster_media_type,
    rasterWidth: row.raster_width,
    rasterHeight: row.raster_height,
    digest: row.digest,
    sourceDigest: row.source_digest,
    preparedByUserId: row.prepared_by_user_id,
    preparedForSessionId: row.prepared_for_session_id,
    preparedAt: row.prepared_at,
  };
}

export function createPreparedSignatureRepository(
  db: Kysely<Database> | Transaction<Database>,
): PreparedSignatureRepository {
  return {
    async prepare(input): Promise<void> {
      // Claiming twice replaces rather than accumulates — the primary key is
      // (request, recipient, purpose), so there is nowhere for a second copy
      // to go, and the most recent claim is the one the signer just made.
      await db.insertInto("prepared_signatures").values({
        signing_request_id: input.signingRequestId,
        request_recipient_id: input.recipientId,
        purpose: input.purpose,
        representation_type: input.representationType,
        typed_text: input.typedText,
        typed_style_index: input.typedStyleIndex,
        raster_bytes: input.rasterBytes,
        raster_media_type: input.rasterMediaType,
        raster_width: input.rasterWidth,
        raster_height: input.rasterHeight,
        digest: input.digest,
        source_digest: input.sourceDigest,
        prepared_by_user_id: input.preparedByUserId,
        prepared_for_session_id: input.preparedForSessionId,
        prepared_at: input.preparedAt,
      })
        .onConflict(conflict => conflict
          .columns(["signing_request_id", "request_recipient_id", "purpose"])
          .doUpdateSet({
            representation_type: input.representationType,
            typed_text: input.typedText,
            typed_style_index: input.typedStyleIndex,
            raster_bytes: input.rasterBytes,
            raster_media_type: input.rasterMediaType,
            raster_width: input.rasterWidth,
            raster_height: input.rasterHeight,
            digest: input.digest,
            source_digest: input.sourceDigest,
            prepared_by_user_id: input.preparedByUserId,
            prepared_for_session_id: input.preparedForSessionId,
            prepared_at: input.preparedAt,
          }))
        .execute();
    },

    async listForSession(signingRequestId, recipientId, sessionId): Promise<PreparedSignature[]> {
      const rows = await db.selectFrom("prepared_signatures").selectAll()
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .where("prepared_for_session_id", "=", sessionId)
        .orderBy("purpose")
        .execute();
      return rows.map(row => toPrepared(row as unknown as Row));
    },

    async consumeForRecipient(signingRequestId, recipientId): Promise<void> {
      await db.deleteFrom("prepared_signatures")
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .execute();
    },
  };
}
