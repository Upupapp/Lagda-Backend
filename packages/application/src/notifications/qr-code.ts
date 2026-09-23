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

export function qrCodeDataUri(url: string): string {
  const png = qrImage.imageSync(url, {
    type: "png",
    // A signing link is a long, high-entropy token — "M" (15% recovery)
    // keeps the resulting code scannable at a small size instead of the
    // dense, hard-to-scan grid "H" would produce for the same data.
    ec_level: "M",
    size: 6,
    margin: 1,
  }) as Buffer;
  return `data:image/png;base64,${png.toString("base64")}`;
}
