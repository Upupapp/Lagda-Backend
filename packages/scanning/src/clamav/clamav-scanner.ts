// ClamAV, over the daemon's own INSTREAM protocol.
//
// ── Why the protocol directly, and not a wrapper ───────────────────────────
//
// INSTREAM is small and stable: send `zINSTREAM\0`, then length-prefixed
// chunks, then a zero-length chunk, then read one reply. Implementing it here
// means no unmaintained npm wrapper sits between LAGDA and the one control that
// stops malware reaching a customer, and no `clamscan` CLI is invoked with a
// filename interpolated into a shell (§52).
//
// Nothing shells out. Nothing writes a temp file. The bytes go over a socket.
//
// ── Fail closed ────────────────────────────────────────────────────────────
//
// Every failure path returns `unavailable`, never `clean`. A refused
// connection, a timeout, a truncated reply, an unrecognised response - all of
// them mean "LAGDA does not know", and "does not know" must never be recorded
// as "safe" (INV-222).

import { connect, type Socket } from "node:net";
import type {
  MalwareScanInput, MalwareScanResult, MalwareScanner,
} from "@lagda/application";

export interface ClamAvConfig {
  readonly host: string;
  readonly port: number;
  /**
   * Bounds the whole scan. A stuck scanner must not hold an HTTP request open
   * indefinitely (§113).
   */
  readonly timeoutMs: number;
  /**
   * clamd's own `StreamMaxLength`. LAGDA's upload maximum must not exceed it:
   * a file too large for the scanner would come back as an ERROR, and an
   * unscannable file must never be treated as clean (§111).
   */
  readonly maxStreamBytes: number;
}

/** clamd's wire chunk size. 64 KiB keeps well under its default limits. */
const CHUNK_BYTES = 64 * 1024;

export function createClamAvScanner(config: ClamAvConfig): MalwareScanner {
  return {
    async scan(input: MalwareScanInput): Promise<MalwareScanResult> {
      if (input.byteSize > config.maxStreamBytes) {
        // Refused BEFORE sending. Discovering this from clamd would produce an
        // error reply that is easy to mistake for a transport problem, and the
        // file would be unscanned either way.
        return {
          outcome: "unavailable",
          reason: "file exceeds the scanner's maximum stream size",
        };
      }

      let socket: Socket | undefined;
      try {
        socket = await openSocket(config);
        const reply = await runInStream(socket, input.content, config.timeoutMs);
        return interpret(reply);
      } catch (error) {
        return {
          outcome: "unavailable",
          // A short operator-facing reason. Never the scanner's raw output and
          // never anything derived from the file.
          reason: error instanceof Error ? error.name : "scanner error",
        };
      } finally {
        socket?.destroy();
      }
    },

    async isAvailable(): Promise<boolean> {
      // PING/PONG. Cheap, and deliberately not a scan: a health probe that
      // scanned a file would cost a full engine pass on every check (§55).
      let socket: Socket | undefined;
      try {
        socket = await openSocket(config);
        const reply = await command(socket, Buffer.from("zPING\0"), config.timeoutMs);
        // NULs stripped BEFORE comparing. clamd terminates its reply with a
        // NUL, and `trim()` does not remove it — so a perfectly healthy scanner
        // reported itself unavailable, which fails closed and would have
        // disabled every upload while looking like a scanner outage.
        return reply.replace(/\0/g, "").trim() === "PONG";
      } catch {
        return false;
      } finally {
        socket?.destroy();
      }
    },
  };
}

/**
 * Interprets a clamd reply.
 *
 * Matched on the protocol's own vocabulary - `OK`, `FOUND`, `ERROR` - not on
 * free text. Anything unrecognised is `unavailable`, because an unparsed reply
 * is not evidence of cleanliness (§112).
 */
function interpret(reply: string): MalwareScanResult {
  const line = reply.replace(/\0/g, "").trim();

  if (/\bOK$/.test(line)) return { outcome: "clean" };

  if (/\bFOUND$/.test(line)) {
    // `stream: Eicar-Test-Signature.UNOFFICIAL FOUND`
    const match = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
    return {
      outcome: "infected",
      // INTERNAL telemetry only. Returning it to a client tells an attacker
      // which signature caught them (§87).
      ...(match?.[1] === undefined ? {} : { signature: match[1] }),
    };
  }

  if (/\bERROR$/.test(line) || /size limit exceeded/i.test(line)) {
    return { outcome: "unavailable", reason: "scanner reported an error" };
  }

  return { outcome: "unavailable", reason: "unrecognised scanner response" };
}

function openSocket(config: ClamAvConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("ScannerConnectTimeout"));
    }, config.timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** Sends one command and reads the single reply clamd returns before closing. */
function command(socket: Socket, payload: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("ScannerTimeout"));
    }, timeoutMs);

    socket.on("data", chunk => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(payload);
  });
}

/**
 * Streams content to clamd and returns its verdict.
 *
 * Chunks are written with backpressure respected: when the socket buffer is
 * full, `write` returns false and this waits for `drain` rather than queueing
 * the whole file in memory (§104).
 */
async function runInStream(
  socket: Socket, content: AsyncIterable<Uint8Array>, timeoutMs: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let settle: ((value: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const reply = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const timer = setTimeout(() => {
    socket.destroy();
    fail?.(new Error("ScannerTimeout"));
  }, timeoutMs);

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    // clamd answers INSTREAM with ONE NUL-terminated line and then closes.
    // Resolving on the terminator rather than waiting for `end` keeps a scanner
    // that holds the socket open from consuming the whole timeout.
    if (chunk.includes(0)) {
      clearTimeout(timer);
      settle?.(Buffer.concat(chunks).toString("utf8"));
    }
  });
  socket.once("end", () => {
    clearTimeout(timer);
    settle?.(Buffer.concat(chunks).toString("utf8"));
  });
  socket.once("error", (error: Error) => {
    clearTimeout(timer);
    fail?.(error);
  });

  socket.write(Buffer.from("zINSTREAM\0"));

  for await (const part of content) {
    for (let at = 0; at < part.byteLength; at += CHUNK_BYTES) {
      const slice = part.subarray(at, Math.min(at + CHUNK_BYTES, part.byteLength));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(slice.byteLength, 0);
      await write(socket, Buffer.concat([header, Buffer.from(slice)]));
    }
  }

  // A zero-length chunk terminates the stream and asks for the verdict.
  await write(socket, Buffer.alloc(4));
  return reply;
}

function write(socket: Socket, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const flushed = socket.write(payload, (error) => {
      if (error) reject(error);
    });
    if (flushed) {
      resolve();
      return;
    }
    socket.once("drain", () => { resolve(); });
  });
}
