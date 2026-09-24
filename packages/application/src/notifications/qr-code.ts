// A small PNG QR code encoding a URL, as an inline `data:` URI.
//
// Synchronous and I/O-free — `qr-image`'s `imageSync` builds the PNG bytes
// entirely in memory from the QR matrix; no filesystem, no network, no
// randomness. That keeps this usable from `templates.ts`'s `render()`
// functions, which `rendering.ts` documents as pure (S205): the same URL
// always produces the same bytes, so a template stays deterministic and
// testable with fixtures.
//
// Inline `data:` rather than a hosted image URL for the same reason the logo
// is inline (see `assets/lagda-logo.ts`): most mail clients block remote
// images by default, and a QR code a reader has to click "show images" to
// even see has failed at the one thing it exists to do.

import qrImage from "qr-image";

/**
 * The raw PNG bytes. Shared by every caller that needs the same code at a
 * different destination — an email attachment, a downloadable file for
 * printing and showing in person — so the encoding parameters are chosen
 * once, here, rather than redecided at each call site.
 *
 * `size` is qr-image's per-module pixel scale, not a target image
 * dimension: the default (6) suits a ~132px inline email thumbnail; a
 * caller producing a standalone image to print and scan from across a room
 * wants a larger one, hence the optional override.
 */
export function qrCodePng(url: string, options?: { readonly size?: number }): Buffer {
  return qrImage.imageSync(url, {
    type: "png",
    // A signing link is a long, high-entropy token — "M" (15% recovery)
    // keeps the resulting code scannable at a small size instead of the
    // dense, hard-to-scan grid "H" would produce for the same data.
    ec_level: "M",
    size: options?.size ?? 6,
    margin: 1,
  }) as Buffer;
}

export function qrCodePngBase64(url: string, options?: { readonly size?: number }): string {
  return qrCodePng(url, options).toString("base64");
}

/**
 * Kept for anything that genuinely wants an inline `data:` URI (there is
 * currently nothing — `templates.ts` moved to CID attachments; see
 * `EmailAttachment`'s doc comment for why). Not removed: it is a one-line,
 * still-correct convenience over `qrCodePngBase64`, and re-adding it later
 * would just be this line again.
 */
export function qrCodeDataUri(url: string): string {
  return `data:image/png;base64,${qrCodePngBase64(url)}`;
}
