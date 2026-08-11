// Hashing an uploaded verification file (BACKEND-42).
//
// ── What this deliberately is not ──────────────────────────────────────────
//
// Not an upload. A verification file is a temporary comparison input, not
// tenant content: it creates no Document, no Artifact, no object, and it is
// never written to disk. It exists as a sequence of chunks passing through a
// hash and is gone when the request ends (§66–§70).
//
// It is also never PARSED. No PDF library touches it, no JavaScript in it can
// run, no page is rendered, no text is extracted (§72, §73, §192). Comparing
// bytes needs none of that, and every one of those would be a way for a
// stranger's file to reach code that does something other than add to a digest.

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Sha256Digest } from "@lagda/contracts";

/**
 * The size ceiling for a public verification upload.
 *
 * 25 MB. A completed LAGDA document is a merged PDF plus a certificate — a few
 * hundred kilobytes typically, a few megabytes for a long one. The ceiling is
 * generous for real documents and small enough that the endpoint cannot be used
 * as a free hashing service.
 *
 * Enforced BY COUNTING as the stream arrives, not by trusting `Content-Length`:
 * that header is supplied by the caller and a chunked upload need not send one
 * at all.
 */
export const MAX_VERIFICATION_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Streams a request body through SHA-256 and returns the digest.
 *
 * Bounded memory: chunks are hashed and dropped, so a 25 MB file costs the
 * hash state and one chunk — never the whole document (§74, §75).
 *
 * @throws `Error("file-too-large")` when the stream exceeds the ceiling. The
 *         stream is destroyed at that moment rather than drained, so an
 *         attacker cannot make the server read gigabytes it has already
 *         decided to reject.
 * @throws `Error("file-unreadable")` when the connection fails mid-body.
 */
export async function hashStream(stream: Readable): Promise<Sha256Digest> {
  const hash = createHash("sha256");
  let total = 0;

  try {
    for await (const chunk of stream) {
      const bytes = chunk as Uint8Array;
      total += bytes.byteLength;
      if (total > MAX_VERIFICATION_FILE_BYTES) {
        // Stop reading immediately. Breaking out of `for await` closes the
        // iterator; `destroy` also tears down the underlying socket so the
        // remaining body is never received.
        stream.destroy();
        throw new Error("file-too-large");
      }
      hash.update(bytes);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === "file-too-large") throw cause;
    // An aborted or broken upload. Never surfaced with the underlying message,
    // which can carry socket and path detail.
    throw new Error("file-unreadable");
  }

  // An empty body is not a document. Hashing zero bytes yields a well-known
  // digest that would never match a real artifact — so this would answer
  // "no match" rather than "you sent nothing", which is a worse answer.
  if (total === 0) throw new Error("file-unreadable");

  return hash.digest("hex") as Sha256Digest;
}
