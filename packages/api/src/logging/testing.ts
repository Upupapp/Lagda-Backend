// Capturing structured logs for assertions. **Test support only.**
//
// Assertions are made against PARSED FIELDS, never against terminal text. A
// test that greps formatted output passes or fails on the formatter, and the
// formatter is not what any of these tests are about.

import { Writable } from "node:stream";

export interface CapturedLog {
  readonly level: number;
  readonly msg?: string;
  readonly [field: string]: unknown;
}

export interface LogCapture {
  /** The stream to hand Pino. */
  readonly stream: Writable;
  /** Every line parsed. Lines that are not JSON are surfaced, not swallowed. */
  lines(): readonly CapturedLog[];
  /** The whole raw output. Used to assert a secret appears NOWHERE. */
  raw(): string;
  clear(): void;
}

export function createLogCapture(): LogCapture {
  let chunks: string[] = [];

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    lines(): readonly CapturedLog[] {
      return chunks
        .join("")
        .split("\n")
        .filter(line => line.trim().length > 0)
        .map(line => {
          try {
            return JSON.parse(line) as CapturedLog;
          } catch {
            // Surfaced rather than dropped: a non-JSON line in a structured
            // logger is itself a defect, and silently filtering it would hide
            // exactly the thing worth failing on.
            return { level: 0, msg: "[unparseable]", raw: line } satisfies CapturedLog;
          }
        });
    },
    raw: () => chunks.join(""),
    clear: () => { chunks = []; },
  };
}
