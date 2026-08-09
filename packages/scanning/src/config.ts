// Scanner configuration.
//
// Validated at load. A malware scanner configured wrongly fails closed at
// runtime, which is safe but presents as "uploads are broken" rather than
// "MALWARE_SCANNER_HOST is missing".

import type { ClamAvConfig } from "./clamav/clamav-scanner.js";

export class ScannerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerConfigError";
  }
}

function readInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ScannerConfigError(`${name} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

export function loadScannerConfig(env: NodeJS.ProcessEnv = process.env): ClamAvConfig {
  const host = env["MALWARE_SCANNER_HOST"];
  if (host === undefined || host.trim() === "") {
    throw new ScannerConfigError(
      "MALWARE_SCANNER_HOST is not configured. Uploads require malware scanning "
      + "and there is no configuration that disables it.",
    );
  }
  return {
    host,
    port: readInt(env["MALWARE_SCANNER_PORT"], "MALWARE_SCANNER_PORT", 3310),
    timeoutMs: readInt(env["MALWARE_SCANNER_TIMEOUT_MS"], "MALWARE_SCANNER_TIMEOUT_MS", 30_000),
    // Must be >= LAGDA's upload maximum. If it were smaller, a large file
    // would arrive unscannable and the pipeline would correctly refuse it -
    // presenting as a LAGDA outage rather than a misconfiguration.
    maxStreamBytes: readInt(
      env["MALWARE_SCANNER_MAX_STREAM_BYTES"], "MALWARE_SCANNER_MAX_STREAM_BYTES",
      30 * 1024 * 1024,
    ),
  };
}
