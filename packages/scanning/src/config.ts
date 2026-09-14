// Scanner configuration.
//
// Validated at load. A malware scanner configured wrongly fails closed at
// runtime, which is safe but presents as "uploads are broken" rather than
// "MALWARE_SCANNER_HOST is missing".
//
// ── Provider selection ──────────────────────────────────────────────────────
//
// MALWARE_SCANNER_PROVIDER picks which scanner backs uploads — "clamav"
// (default, self-hosted, the long-term intent) or "metadefender" (hosted,
// temporary substitute for deployments that cannot yet afford ClamAV's
// memory footprint — see metadefender/metadefender-scanner.ts). Exactly one
// is ever configured; there is still no configuration that disables
// scanning entirely, matching the pre-existing invariant below.

import type { ClamAvConfig } from "./clamav/clamav-scanner.js";
import type { MetaDefenderConfig } from "./metadefender/metadefender-scanner.js";

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

export type ScannerConfig =
  | { readonly provider: "clamav"; readonly clamav: ClamAvConfig }
  | { readonly provider: "metadefender"; readonly metadefender: MetaDefenderConfig };

function loadClamAvConfig(env: NodeJS.ProcessEnv): ClamAvConfig {
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

function loadMetaDefenderConfig(env: NodeJS.ProcessEnv): MetaDefenderConfig {
  const apiKey = env["MALWARE_SCANNER_METADEFENDER_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new ScannerConfigError(
      "MALWARE_SCANNER_METADEFENDER_API_KEY is not configured. Uploads require "
      + "malware scanning and there is no configuration that disables it.",
    );
  }
  return {
    apiKey: apiKey.trim(),
    apiBaseUrl: (env["MALWARE_SCANNER_METADEFENDER_API_BASE_URL"] ?? "https://api.metadefender.com/v4").trim(),
    timeoutMs: readInt(
      env["MALWARE_SCANNER_TIMEOUT_MS"], "MALWARE_SCANNER_TIMEOUT_MS", 30_000),
    // The Community (free) tier's own advertised ceiling is 750MB; bounded
    // lower here to match LAGDA's own upload maximum, same reasoning as
    // ClamAV's maxStreamBytes — never send more than the plan can scan.
    maxFileBytes: readInt(
      env["MALWARE_SCANNER_MAX_STREAM_BYTES"], "MALWARE_SCANNER_MAX_STREAM_BYTES",
      30 * 1024 * 1024,
    ),
    pollIntervalMs: readInt(
      env["MALWARE_SCANNER_METADEFENDER_POLL_INTERVAL_MS"],
      "MALWARE_SCANNER_METADEFENDER_POLL_INTERVAL_MS", 2_000,
    ),
    maxPollAttempts: readInt(
      env["MALWARE_SCANNER_METADEFENDER_MAX_POLL_ATTEMPTS"],
      "MALWARE_SCANNER_METADEFENDER_MAX_POLL_ATTEMPTS", 30,
    ),
  };
}

export function loadScannerConfig(env: NodeJS.ProcessEnv = process.env): ScannerConfig {
  const provider = env["MALWARE_SCANNER_PROVIDER"] ?? "clamav";
  if (provider === "metadefender") {
    return { provider: "metadefender", metadefender: loadMetaDefenderConfig(env) };
  }
  if (provider !== "clamav") {
    throw new ScannerConfigError(
      `MALWARE_SCANNER_PROVIDER must be clamav or metadefender, got ${JSON.stringify(provider)}.`,
    );
  }
  return { provider: "clamav", clamav: loadClamAvConfig(env) };
}
