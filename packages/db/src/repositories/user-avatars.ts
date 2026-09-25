// An account's profile photo (072). Read and written only by the account
// itself — callers pass the SESSION's user id, never one from a request.

import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema/index.js";

export interface StoredAvatar {
  readonly mediaType: "image/png";
  readonly bytes: Buffer;
  readonly digest: string;
}

export interface SaveAvatarInput {
  readonly userId: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly digest: string;
  readonly updatedAt: Date;
}

export interface UserAvatarRepository {
  readonly find: (userId: string) => Promise<StoredAvatar | null>;
  /** The digest only — what `/me` needs to version the image URL, without
   *  reading the bytes on every page load. */
  readonly versionOf: (userId: string) => Promise<string | null>;
  readonly save: (input: SaveAvatarInput) => Promise<void>;
  /** True when there was a photo to remove. */
  readonly remove: (userId: string) => Promise<boolean>;
}

export function createUserAvatarRepository(
  db: Kysely<Database> | Transaction<Database>,
): UserAvatarRepository {
  return {
    async find(userId) {
      const row = await db.selectFrom("user_avatars")
        .select(["image_bytes", "digest"])
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { mediaType: "image/png", bytes: row.image_bytes, digest: row.digest };
    },

    async versionOf(userId) {
      const row = await db.selectFrom("user_avatars")
        .select("digest")
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row?.digest ?? null;
    },

    async save(input) {
      const values = {
        media_type: "image/png",
        image_bytes: input.bytes,
        width: input.width,
        height: input.height,
        digest: input.digest,
        updated_at: input.updatedAt,
      };
      await db.insertInto("user_avatars")
        .values({ user_id: input.userId, ...values })
        .onConflict(oc => oc.column("user_id").doUpdateSet(values))
        .execute();
    },

    async remove(userId) {
      const result = await db.deleteFrom("user_avatars")
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
