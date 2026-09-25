// Profile photo validation (072).
//
// The same stance as `signature-image.ts`, and for the same reasons: PNG
// only, checked from the magic bytes and the IHDR header — 24 bytes of
// arithmetic, not a decoder — so no image library ever parses untrusted
// bytes. The browser crops and scales the photo into a small PNG before
// upload, so a PNG is always what an honest client sends. SVG in particular
// is refused by construction: it is a scriptable document wearing an image's
// name, and this image is later served back from our own origin.

import { sha256Hex } from "./signature-image.js";

export const MAX_AVATAR_BYTES = 400 * 1024;
export const MAX_AVATAR_DIMENSION = 512;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_OFFSET = 8;
const MIN_PNG_BYTES = 24;

export interface ValidatedAvatar {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  /** Over the bytes AS STORED — never a client's claim. */
  readonly digest: string;
}

export function validateAvatarImage(base64: string): ValidatedAvatar | null {
  // Bound the TRANSPORT before decoding, so a hostile body cannot make the
  // process allocate before any check has run.
  if (base64.length === 0) return null;
  if (base64.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 128) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  const bytes = Buffer.from(base64, "base64");
  // Node's decoder is lenient; a round trip is the real cleanliness check.
  if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    return null;
  }

  if (bytes.length < MIN_PNG_BYTES || bytes.length > MAX_AVATAR_BYTES) return null;
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  if (bytes.subarray(IHDR_OFFSET + 4, IHDR_OFFSET + 8).toString("ascii") !== "IHDR") {
    return null;
  }

  const width = bytes.readUInt32BE(IHDR_OFFSET + 8);
  const height = bytes.readUInt32BE(IHDR_OFFSET + 12);
  if (width < 1 || height < 1) return null;
  if (width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) return null;

  return { bytes, width, height, digest: sha256Hex(bytes) };
}
