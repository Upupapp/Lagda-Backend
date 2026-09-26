// 082. A workspace's branding: how its name, sender, tagline, colour and logo
// appear. One row per workspace, absent until someone first saves branding —
// absence means "the LAGDA defaults", never an error.
//
// The display name is NOT stored here: it is the workspace's own name, so a
// rename and a branding edit can never disagree.

export const BRANDING_SENDER_NAME_MAX_LENGTH = 120;
export const BRANDING_TAGLINE_MAX_LENGTH = 160;
/** The PNG the browser produces from the chosen logo, bounded as stored. */
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024;
export const BRANDING_LOGO_MAX_DIMENSION = 1024;

export interface WorkspaceBrandingSettings {
  readonly senderDisplayName: string | null;
  readonly footerTagline: string | null;
  /** `#RRGGBB`, uppercase. Null means the LAGDA default. */
  readonly primaryColor: string | null;
}

export interface WorkspaceBrandingRecord extends WorkspaceBrandingSettings {
  readonly logo: {
    readonly digest: string;
    readonly width: number;
    readonly height: number;
    readonly updatedAt: number;
  } | null;
  readonly updatedAt: number;
}

export interface WorkspaceLogoImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** SHA-256 over the bytes as stored; doubles as the cache version. */
  readonly digest: string;
}

export interface ScopedWorkspaceBrandingRepository {
  find(): Promise<WorkspaceBrandingRecord | null>;
  findLogo(): Promise<(WorkspaceLogoImage & { readonly mediaType: "image/png" }) | null>;
  /** Creates the row on first save. */
  saveSettings(settings: WorkspaceBrandingSettings, now: number): Promise<void>;
  saveLogo(logo: WorkspaceLogoImage, now: number): Promise<void>;
  clearLogo(now: number): Promise<void>;
}
