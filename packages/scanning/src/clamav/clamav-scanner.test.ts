// No test file existed for either scanner provider before this — a gap
// surfaced by the Phase 1 readiness audit. These exercise the real clamd
// INSTREAM/PING wire protocol against a small fake TCP server, not a live
// ClamAV instance, so they run in CI without docker-compose.local.yml's
// ClamAV service. Every case here defends the "fail closed" contract:
// anything that isn't an explicit clean/infected verdict from the real
// protocol must come back `unavailable`, never `clean`.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createClamAvScanner } from "./clamav-scanner.js";

async function fakeClamd(
  onStream: (chunks: Buffer[]) => string,
): Promise<{ port: number; server: Server }> {
  const server = createServer((socket: Socket) => {
    let mode: "unknown" | "instream" | "ping" = "unknown";
    const streamChunks: Buffer[] = [];
    let awaitingLength: Buffer | null = null;

    socket.on("data", (data: Buffer) => {
      if (mode === "unknown") {
        if (data.toString("latin1").startsWith("zINSTREAM\0")) {
          mode = "instream";
          data = data.subarray("zINSTREAM\0".length);
        } else if (data.toString("latin1").startsWith("zPING\0")) {
          socket.end(Buffer.from("PONG\0"));
          return;
        }
      }
      if (mode === "instream") {
        let buf = awaitingLength ? Buffer.concat([awaitingLength, data]) : data;
        awaitingLength = null;
        while (buf.byteLength >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            socket.end(Buffer.from(`${onStream(streamChunks)}\0`));
            return;
          }
          if (buf.byteLength < 4 + len) { awaitingLength = buf; return; }
          streamChunks.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, server };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("createClamAvScanner", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("reports clean on clamd's OK reply", async () => {
    const fake = await fakeClamd(() => "stream: OK");
    server = fake.server;
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: fake.port, timeoutMs: 2000, maxStreamBytes: 1_000_000,
    });
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("reports infected with the signature on a FOUND reply", async () => {
    const fake = await fakeClamd(() => "stream: Eicar-Test-Signature.UNOFFICIAL FOUND");
    server = fake.server;
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: fake.port, timeoutMs: 2000, maxStreamBytes: 1_000_000,
    });
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({ outcome: "infected", signature: "Eicar-Test-Signature.UNOFFICIAL" });
  });

  it("never reports clean for an unrecognised reply (fail closed)", async () => {
    const fake = await fakeClamd(() => "stream: something the protocol has never sent before");
    server = fake.server;
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: fake.port, timeoutMs: 2000, maxStreamBytes: 1_000_000,
    });
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result.outcome).toBe("unavailable");
  });

  it("reports unavailable, not clean, on ERROR", async () => {
    const fake = await fakeClamd(() => "stream: ERROR");
    server = fake.server;
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: fake.port, timeoutMs: 2000, maxStreamBytes: 1_000_000,
    });
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result.outcome).toBe("unavailable");
  });

  it("refuses a file over maxStreamBytes before ever connecting", async () => {
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: 1, timeoutMs: 2000, maxStreamBytes: 2,
    });
    const result = await scanner.scan({ byteSize: 100, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({
      outcome: "unavailable",
      reason: "file exceeds the scanner's maximum stream size",
    });
  });

  it("reports unavailable when nothing is listening on the configured port", async () => {
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: 1, timeoutMs: 500, maxStreamBytes: 1_000_000,
    });
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result.outcome).toBe("unavailable");
  });

  it("isAvailable resolves true on a real PONG", async () => {
    const fake = await fakeClamd(() => "stream: OK");
    server = fake.server;
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: fake.port, timeoutMs: 2000, maxStreamBytes: 1_000_000,
    });
    expect(await scanner.isAvailable()).toBe(true);
  });

  it("isAvailable resolves false when the connection is refused", async () => {
    const scanner = createClamAvScanner({
      host: "127.0.0.1", port: 1, timeoutMs: 500, maxStreamBytes: 1_000_000,
    });
    expect(await scanner.isAvailable()).toBe(false);
  });
});
