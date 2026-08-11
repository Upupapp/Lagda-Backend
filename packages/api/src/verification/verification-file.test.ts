// Hashing an uploaded verification file (BACKEND-42).
//
// The bound is the interesting property. This endpoint is reachable with no
// credential of any kind, so "it stops reading at 25 MB" has to be true rather
// than intended.

import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { hashStream, MAX_VERIFICATION_FILE_BYTES } from "./verification-file.js";

/** A stream of `count` chunks of `size` bytes, produced lazily. */
function chunks(count: number, size: number): Readable {
  let emitted = 0;
  return new Readable({
    read() {
      if (emitted >= count) return void this.push(null);
      emitted += 1;
      this.push(Buffer.alloc(size, 0x41));
    },
  });
}

describe("hashing", () => {
  it("matches the published vector for \"abc\"", async () => {
    // The SAME vector `@lagda/sealing`'s digest suite asserts. Both hashers are
    // pinned to the published value rather than to each other, so a drift in
    // either is caught by its own suite — and the comparison this endpoint
    // performs against `signed_document_hash` cannot silently start failing
    // because one side changed encoding.
    expect(await hashStream(Readable.from([Buffer.from("abc")]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces lowercase hex of exactly 64 characters", async () => {
    expect(await hashStream(Readable.from([Buffer.from("LAGDA")])))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes SHA-256 over the exact bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7 a completed document");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await hashStream(Readable.from([bytes]))).toBe(expected);
  });

  it("produces the same digest whatever the chunk boundaries", async () => {
    // The failure this catches is a hasher that resets per chunk, or one that
    // only hashes the first. Both look correct on a single-chunk fixture.
    const whole = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789");
    const split = [whole.subarray(0, 7), whole.subarray(7, 30), whole.subarray(30)];

    expect(await hashStream(Readable.from(split)))
      .toBe(await hashStream(Readable.from([whole])));
  });

  it("matches an independently computed digest for a multi-megabyte file", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const independent = createHash("sha256");
    for (let i = 0; i < 5; i += 1) independent.update(chunk);

    expect(await hashStream(chunks(5, 1024 * 1024)))
      .toBe(independent.digest("hex"));
  });
});

describe("the bound", () => {
  it("accepts a file at the limit", async () => {
    const digest = await hashStream(chunks(25, 1024 * 1024));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("REFUSES a file over the limit", async () => {
    await expect(hashStream(chunks(26, 1024 * 1024)))
      .rejects.toThrow("file-too-large");
  });

  it("stops READING rather than draining the rest", async () => {
    // The property that matters for abuse: an attacker announcing a 10 GB body
    // must not get 10 GB read before the rejection. Counted by how many chunks
    // the producer was actually asked for.
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 1;
        this.push(Buffer.alloc(1024 * 1024, 0x41));
      },
    });

    await expect(hashStream(endless)).rejects.toThrow("file-too-large");
    // 25 MB of chunks plus the one that crossed the line, and a little slack
    // for Node's read-ahead — nowhere near unbounded.
    expect(produced).toBeLessThan(40);
  });

  it("does not trust a declared length — the count is what bounds it", async () => {
    // No Content-Length is consulted anywhere; a chunked upload need not send
    // one. This stream declares nothing and is still bounded.
    await expect(hashStream(chunks(30, 1024 * 1024)))
      .rejects.toThrow("file-too-large");
  });
});

describe("refusals", () => {
  it("refuses an empty body", async () => {
    // Hashing zero bytes yields a valid, well-known digest that would simply
    // never match — answering "no match" to someone who sent nothing, which is
    // a worse answer than refusing.
    await expect(hashStream(Readable.from([]))).rejects.toThrow("file-unreadable");
  });

  it("refuses a broken upload without leaking the underlying error", async () => {
    const broken = new Readable({
      read() { this.destroy(new Error("ECONNRESET /var/tmp/socket-9f2")); },
    });

    // Not `.catch(e => e)`: that resolves to the DIGEST when the stream
    // unexpectedly succeeds, and every assertion below then runs against a
    // string, passing vacuously.
    let error: Error;
    try {
      await hashStream(broken);
      throw new Error("Expected the stream to be refused, but it hashed.");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error.message).toBe("file-unreadable");
    // Socket and path detail never reaches the caller.
    expect(error.message).not.toContain("ECONNRESET");
    expect(error.message).not.toContain("/var/tmp");
  });
});

describe("what it never does", () => {
  it("exposes no parsing, rendering or persistence surface", async () => {
    // The module's whole API is one function returning a digest. There is no
    // path by which a stranger's file reaches a PDF library, a disk, or object
    // storage — §66-§73, asserted structurally because the guarantee IS the
    // absence.
    const module = await import("./verification-file.js");
    expect(Object.keys(module).sort())
      .toEqual(["MAX_VERIFICATION_FILE_BYTES", "hashStream"]);
  });

  it("bounds at 25 MB", () => {
    expect(MAX_VERIFICATION_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});
