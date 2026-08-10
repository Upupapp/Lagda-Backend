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

/** The eight-byte PNG signature. Nothing else is accepted. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Length(4) + "IHDR"(4) + width(4) + height(4) = the first 24 bytes matter. */
const IHDR_OFFSET = 8;
const MIN_PNG_BYTES = 24;

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
