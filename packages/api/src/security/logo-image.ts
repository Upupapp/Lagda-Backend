// Workspace logo validation (082).
//
// The profile photo's stance (072), with a logo's bounds: PNG only, checked
// from the magic bytes and the IHDR header — arithmetic, not a decoder — so no
// image library parses untrusted bytes. The browser scales the chosen PNG or
// JPEG into a PNG before upload. SVG is refused by construction: it is a
// scriptable document, and this image is served back from our own origin.

import {
  BRANDING_LOGO_MAX_BYTES, BRANDING_LOGO_MAX_DIMENSION, type WorkspaceLogoImage,
} from "@lagda/application";
import { sha256Hex } from "./signature-image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_OFFSET = 8;
const MIN_PNG_BYTES = 24;

/** The longest base64 a valid logo can be, plus slack for padding. */
export const MAX_LOGO_BASE64_LENGTH = Math.ceil((BRANDING_LOGO_MAX_BYTES * 4) / 3) + 128;

export function validateLogoImage(base64: string): WorkspaceLogoImage | null {
  // Bound the transport before decoding anything.
  if (base64.length === 0 || base64.length > MAX_LOGO_BASE64_LENGTH) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  const bytes = Buffer.from(base64, "base64");
  // Node's decoder is lenient; a round trip is the real cleanliness check.
  if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) return null;
  if (bytes.length < MIN_PNG_BYTES || bytes.length > BRANDING_LOGO_MAX_BYTES) return null;
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  if (bytes.subarray(IHDR_OFFSET + 4, IHDR_OFFSET + 8).toString("ascii") !== "IHDR") return null;

  const width = bytes.readUInt32BE(IHDR_OFFSET + 8);
  const height = bytes.readUInt32BE(IHDR_OFFSET + 12);
  if (width < 1 || height < 1) return null;
  if (width > BRANDING_LOGO_MAX_DIMENSION || height > BRANDING_LOGO_MAX_DIMENSION) return null;

  return { bytes, width, height, digest: sha256Hex(bytes) };
}
