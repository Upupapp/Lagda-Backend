// Drawn-signature validation (BACKEND-36).
//
// ── What this refuses to trust ─────────────────────────────────────────────
//
// A base64 string that claims to be a PNG. Every part of that claim is checked
// against the bytes: the magic signature, the IHDR chunk, the dimensions, the
// length. §52 — the `data:image/png;base64,` header proves nothing, which is
// why the contract refuses to accept one at all and this only ever sees the
// payload.
//
// ── PNG only, and no image library ─────────────────────────────────────────
//
// A PNG's dimensions live at a FIXED offset in a fixed first chunk, so reading
// them is 8 bytes of arithmetic rather than a decoder. That matters: pulling in
// an image library to parse untrusted bytes would add the exact attack surface
// this is trying to bound, and §201 says not to unless necessary.
//
// The product's canvas emits `image/png` and nothing else. JPEG, WebP, GIF,
// SVG and PDF are all refused — SVG most deliberately, because it is a
// scriptable document wearing an image's name (§57, §259).

import { createHash } from "node:crypto";
import type {
  SignatureImageValidator, ValidatedRasterSignature,
} from "@lagda/application";
import {
  RASTER_SIGNATURE_MAX_BYTES, RASTER_SIGNATURE_MAX_DIMENSION,
} from "@lagda/contracts";

/**
 * SHA-256 over stored image bytes, hex. Exported so the profile-photo
 * validator (072) digests images with THIS implementation rather than a
 * second one — the hashing allowlist in tests/architecture/sealing.test.ts
 * keeps one implementation per domain, and "image bytes as stored" is this
 * module's domain.
 */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The eight-byte PNG signature. Nothing else is accepted. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Length(4) + "IHDR"(4) + width(4) + height(4) = the first 24 bytes matter. */
const IHDR_OFFSET = 8;
const MIN_PNG_BYTES = 24;

/**
 * Can this PNG have transparent pixels at all?
 *
 * ── Why this matters ──────────────────────────────────────────────────────
 *
 * The sealer embeds a signature with `drawImage` and no compositing control,
 * so a FULLY OPAQUE image paints an opaque rectangle over whatever it lands
 * on in the finished document. The signer never sees it happen: the preview
 * shows their signature, and the white box appears only in the sealed PDF.
 *
 * ── Why this is not a decoder ─────────────────────────────────────────────
 *
 * PNG colour type is one byte at a fixed offset in IHDR. 4 (grey+alpha) and 6
 * (RGB+alpha) carry a per-pixel alpha channel. 3 (palette) can carry
 * transparency, but only via a `tRNS` chunk, so that case walks the chunk
 * headers — lengths and four-character names, never chunk CONTENTS. No
 * inflate, no un-filter, no image library: the same bound this module's header
 * draws around untrusted bytes.
 *
 * Types 0 and 2 have no alpha channel and no tRNS-with-alpha meaning that
 * would help here, so they are answered false without a scan.
 *
 * This reports CAPABILITY, not fact: a type-6 PNG whose every pixel is opaque
 * passes. Proving actual transparency needs the decoder this module refuses to
 * add, and the client already removes backgrounds before upload. This exists
 * to refuse the obviously-wrong case cheaply, not to be a guarantee.
 */
export function pngCanHaveTransparency(bytes: Buffer): boolean {
  const COLOUR_TYPE_OFFSET = IHDR_OFFSET + 17;
  if (bytes.length <= COLOUR_TYPE_OFFSET) return false;

  const colourType = bytes[COLOUR_TYPE_OFFSET];
  if (colourType === 4 || colourType === 6) return true;
  if (colourType !== 3) return false;

  // Palette: look for a tRNS chunk. Chunk layout is
  // length(4) | type(4) | data(length) | crc(4), starting after the magic.
  let offset = PNG_MAGIC.length;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    // A length that would overflow the buffer is malformed; stop rather than
    // wrap around and read arbitrary offsets.
    const next = offset + 12 + length;
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

export function createSignatureImageValidator(): SignatureImageValidator {
  return {
    validate(base64: string): ValidatedRasterSignature | null {
      // Bound the TRANSPORT before decoding. Decoding first would let a
      // hostile caller make the process allocate before any check ran.
      if (base64.length === 0) return null;
      if (base64.length > Math.ceil((RASTER_SIGNATURE_MAX_BYTES * 4) / 3) + 128) {
        return null;
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

      let bytes: Buffer;
      try {
        bytes = Buffer.from(base64, "base64");
      } catch {
        return null;
      }
      // Node's base64 decoder is lenient — it ignores what it cannot parse
      // rather than throwing. So a round-trip is the real check: if re-encoding
      // does not reproduce the input, the input was not clean base64.
      if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
        return null;
      }

      if (bytes.length < MIN_PNG_BYTES) return null;
      if (bytes.length > RASTER_SIGNATURE_MAX_BYTES) return null;
      if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
      if (bytes.subarray(IHDR_OFFSET + 4, IHDR_OFFSET + 8).toString("ascii")
          !== "IHDR") {
        return null;
      }

      const width = bytes.readUInt32BE(IHDR_OFFSET + 8);
      const height = bytes.readUInt32BE(IHDR_OFFSET + 12);
      // Zero is malformed; the upper bound refuses a decompression bomb whose
      // header claims a canvas nobody could have drawn on (§200).
      if (width < 1 || height < 1) return null;
      if (width > RASTER_SIGNATURE_MAX_DIMENSION) return null;
      if (height > RASTER_SIGNATURE_MAX_DIMENSION) return null;

      return {
        bytes,
        // The VALIDATED type, from the magic bytes. Never a client's claim.
        mediaType: "image/png",
        width,
        height,
        // Over the bytes AS STORED. Nothing normalizes them, so this is also
        // the hash of what arrived — but the guarantee is about storage, and
        // if normalization is ever added this must follow it (§202).
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    },

    digestCanonical(value: string): string {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
}
