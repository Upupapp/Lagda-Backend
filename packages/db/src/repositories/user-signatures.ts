// The saved-signature library: a user's own reusable marks.
//
// ── Every method takes the caller's own id ────────────────────────────────
//
// There is no `findById(signatureId)`. Each read and each write is scoped by
// `user_id` in the WHERE clause, so "read someone else's saved signature" is
// not a query this module can express — the same structural boundary the
// account routes rely on, one layer down. Migration 050 explains why that is
// the boundary rather than a row-level-security policy.
//
// ── Why `upsert` rather than insert-then-update ───────────────────────────
//
// `user_signatures_one_per_purpose` is a UNIQUE constraint on
// (user_id, purpose). A read-then-write would race a concurrent double-POST
// and one of the two would hit the constraint as an unhandled error. Letting
// PostgreSQL resolve it means "save my signature" is idempotent by
// construction rather than by the client remembering to only click once.

import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema/index.js";

export type UserSignaturePurpose = "signature" | "initials";

export interface SavedSignature {
  readonly userSignatureId: string;
  readonly purpose: UserSignaturePurpose;
  readonly representationType: "TYPED_SIGNATURE_V1" | "RASTER_SIGNATURE_V1";
  readonly typedText: string | null;
  readonly typedStyleIndex: number | null;
  readonly rasterBytes: Buffer | null;
  readonly rasterMediaType: string | null;
  readonly rasterWidth: number | null;
  readonly rasterHeight: number | null;
  readonly digest: string;
  readonly validatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveSignatureInput {
  readonly userSignatureId: string;
  readonly userId: string;
  readonly purpose: UserSignaturePurpose;
  readonly representationType: "TYPED_SIGNATURE_V1" | "RASTER_SIGNATURE_V1";
  readonly typedText: string | null;
  readonly typedStyleIndex: number | null;
  readonly rasterBytes: Buffer | null;
  readonly rasterMediaType: string | null;
  readonly rasterWidth: number | null;
  readonly rasterHeight: number | null;
  readonly digest: string;
  readonly validatedAt: Date | null;
  readonly now: Date;
}

export interface UserSignatureRepository {
  list: (userId: string) => Promise<SavedSignature[]>;
  find: (userId: string, purpose: UserSignaturePurpose) => Promise<SavedSignature | null>;
  save: (input: SaveSignatureInput) => Promise<SavedSignature>;
  remove: (userId: string, purpose: UserSignaturePurpose) => Promise<boolean>;
}

interface Row {
  user_signature_id: string;
  purpose: string;
  representation_type: string;
  typed_text: string | null;
  typed_style_index: number | null;
  raster_bytes: Buffer | null;
  raster_media_type: string | null;
  raster_width: number | null;
  raster_height: number | null;
  digest: string;
  validated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toSavedSignature(row: Row): SavedSignature {
  return {
    userSignatureId: row.user_signature_id,
    purpose: row.purpose as UserSignaturePurpose,
    representationType: row.representation_type as SavedSignature["representationType"],
    typedText: row.typed_text,
    typedStyleIndex: row.typed_style_index,
    rasterBytes: row.raster_bytes,
    rasterMediaType: row.raster_media_type,
    rasterWidth: row.raster_width,
    rasterHeight: row.raster_height,
    digest: row.digest,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createUserSignatureRepository(
  db: Kysely<Database> | Transaction<Database>,
): UserSignatureRepository {
  return {
    async list(userId: string): Promise<SavedSignature[]> {
      const rows = await db.selectFrom("user_signatures").selectAll()
        .where("user_id", "=", userId)
        .orderBy("purpose")
        .execute();
      return rows.map(row => toSavedSignature(row as unknown as Row));
    },

    async find(userId, purpose): Promise<SavedSignature | null> {
      const row = await db.selectFrom("user_signatures").selectAll()
        .where("user_id", "=", userId)
        .where("purpose", "=", purpose)
        .executeTakeFirst();
      return row === undefined ? null : toSavedSignature(row);
    },

    async save(input): Promise<SavedSignature> {
      // Replacing a signature keeps `created_at` from the row it replaces —
      // "saved since" is about the library entry, not about this upload.
      const row = await db.insertInto("user_signatures")
        .values({
          user_signature_id: input.userSignatureId,
          user_id: input.userId,
          purpose: input.purpose,
          representation_type: input.representationType,
          typed_text: input.typedText,
          typed_style_index: input.typedStyleIndex,
          raster_bytes: input.rasterBytes,
          raster_media_type: input.rasterMediaType,
          raster_width: input.rasterWidth,
          raster_height: input.rasterHeight,
          digest: input.digest,
          validated_at: input.validatedAt,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict(conflict => conflict
          .columns(["user_id", "purpose"])
          .doUpdateSet({
            representation_type: input.representationType,
            typed_text: input.typedText,
            typed_style_index: input.typedStyleIndex,
            raster_bytes: input.rasterBytes,
            raster_media_type: input.rasterMediaType,
            raster_width: input.rasterWidth,
            raster_height: input.rasterHeight,
            digest: input.digest,
            validated_at: input.validatedAt,
            updated_at: input.now,
          }))
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSavedSignature(row);
    },

    async remove(userId, purpose): Promise<boolean> {
      const result = await db.deleteFrom("user_signatures")
        .where("user_id", "=", userId)
        .where("purpose", "=", purpose)
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },
  };
}
