// 082. A workspace's branding row. No delete path exists: reset and removing
// the logo are updates, and the runtime role holds no DELETE on the table.

import type { Kysely, Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type { ScopedWorkspaceBrandingRepository } from "@lagda/application";
import type { Database } from "../schema/index.js";

type Db = Kysely<Database> | Transaction<Database>;

export function createScopedWorkspaceBrandingRepository(
  db: Db, workspaceId: WorkspaceId,
): ScopedWorkspaceBrandingRepository {
  const upsert = async (values: Record<string, unknown>, now: number) => {
    await db.insertInto("workspace_branding")
      .values({ workspace_id: workspaceId, updated_at: new Date(now), ...values })
      .onConflict(oc => oc.column("workspace_id").doUpdateSet({ updated_at: new Date(now), ...values }))
      .execute();
  };

  return {
    async find() {
      const row = await db.selectFrom("workspace_branding")
        .select([
          "sender_display_name", "footer_tagline", "primary_color",
          "logo_digest", "logo_width", "logo_height", "logo_updated_at", "updated_at",
        ])
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        senderDisplayName: row.sender_display_name,
        footerTagline: row.footer_tagline,
        primaryColor: row.primary_color,
        logo: row.logo_digest === null || row.logo_width === null || row.logo_height === null
          || row.logo_updated_at === null ? null
          : {
              digest: row.logo_digest, width: row.logo_width, height: row.logo_height,
              updatedAt: row.logo_updated_at.getTime(),
            },
        updatedAt: row.updated_at.getTime(),
      };
    },

    async findLogo() {
      const row = await db.selectFrom("workspace_branding")
        .select(["logo_bytes", "logo_width", "logo_height", "logo_digest"])
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (row === undefined || row.logo_bytes === null || row.logo_width === null
        || row.logo_height === null || row.logo_digest === null) return null;
      return {
        bytes: new Uint8Array(row.logo_bytes), width: row.logo_width, height: row.logo_height,
        digest: row.logo_digest, mediaType: "image/png" as const,
      };
    },

    async saveSettings(settings, now) {
      await upsert({
        sender_display_name: settings.senderDisplayName,
        footer_tagline: settings.footerTagline,
        primary_color: settings.primaryColor,
      }, now);
    },

    async saveLogo(logo, now) {
      await upsert({
        logo_media_type: "image/png",
        logo_bytes: Buffer.from(logo.bytes),
        logo_width: logo.width,
        logo_height: logo.height,
        logo_digest: logo.digest,
        logo_updated_at: new Date(now),
      }, now);
    },

    async clearLogo(now) {
      await db.updateTable("workspace_branding")
        .set({
          logo_media_type: null, logo_bytes: null, logo_width: null, logo_height: null,
          logo_digest: null, logo_updated_at: null, updated_at: new Date(now),
        })
        .where("workspace_id", "=", workspaceId)
        .execute();
    },
  };
}
