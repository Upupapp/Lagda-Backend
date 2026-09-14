// MetaDefender Cloud (OPSWAT), over its public HTTP API.
//
// ── Why this exists alongside ClamAV, not instead of it ────────────────────
//
// ClamAV needs its signature database resident in memory (~1GB measured) to
// do its job, which some deployments cannot afford yet. This adapter is a
// temporary, swappable substitute for exactly those deployments — see
// MALWARE_SCANNER_PROVIDER in config.ts. ClamAV's own adapter is untouched
// and remains the intended long-term scanner; nothing here replaces it.
//
// ── No SDK ───────────────────────────────────────────────────────────────
//
// Same reasoning as packages/email/src/postmark.ts: this is two HTTP calls,
// and implementing them directly keeps the failure classification (what
// counts as "unavailable" vs a real verdict) under LAGDA's control rather
// than a vendor SDK's defaults.
//
// ── Fail closed, same contract as ClamAV's adapter ──────────────────────────
//
// Every unexpected response, timeout, or scan-result code outside the
// explicit clean/infected set returns `unavailable`, never `clean`. The
// numeric scan_all_result_i codes below are the small subset this adapter
// treats as terminal; every other code (there are dozens — archive errors,
// encrypted files, sandbox verdicts, etc.) falls through to `unavailable`
// deliberately, matching the "unrecognised is never evidence of
// cleanliness" rule in interpret() over in clamav-scanner.ts.

import type {
  MalwareScanInput, MalwareScanResult, MalwareScanner,
} from "@lagda/application";

export interface MetaDefenderConfig {
  readonly apiKey: string;
  readonly apiBaseUrl: string;
  /** Bounds each individual HTTP call (upload, or one poll). */
  readonly timeoutMs: number;
  /** This deployment's free-tier (or plan) file-size ceiling. A file over
   *  this is refused before ever reaching MetaDefender — same reasoning as
   *  ClamAV's maxStreamBytes: an unscannable file must never be treated as
   *  clean. */
  readonly maxFileBytes: number;
  readonly pollIntervalMs: number;
  /** Bounds total wait time: maxPollAttempts * pollIntervalMs. A scan that
   *  never finishes must eventually report `unavailable`, not hang the
   *  upload request forever. */
  readonly maxPollAttempts: number;
}

/** scan_all_result_i codes this adapter treats as terminal — see
 *  https://www.opswat.com/docs/mdcloud/integrations/description-on-scan-result-codes.
 *  Everything else (dozens of other codes) is deliberately NOT listed here
 *  and falls through to `unavailable`. */
const RESULT_CLEAN = 0;
const RESULT_INFECTED = new Set([1, 2]); // Infected/Known, Suspicious
const RESULT_PENDING = new Set([254, 255]); // In queue, In progress

interface MetaDefenderUploadResponse {
  readonly data_id?: string;
}

interface MetaDefenderScanStatusResponse {
  readonly scan_results?: {
    readonly scan_all_result_i?: number;
    readonly scan_details?: Record<string, { readonly threat_found?: string }>;
  };
}

export function createMetaDefenderScanner(config: MetaDefenderConfig): MalwareScanner {
  const base = config.apiBaseUrl.replace(/\/+$/u, "");

  return {
    async scan(input: MalwareScanInput): Promise<MalwareScanResult> {
      if (input.byteSize > config.maxFileBytes) {
        // Refused before ever buffering or sending — same placement as
        // ClamAV's equivalent check.
        return {
          outcome: "unavailable",
          reason: "file exceeds the scanner's maximum file size",
        };
      }

      let dataId: string;
      try {
        // MetaDefender's upload is a single HTTP body, unlike ClamAV's true
        // streamed protocol — the content must be fully buffered first.
        // Bounded by the maxFileBytes check above, so this never buffers an
        // unbounded amount.
        const body = await bufferContent(input.content);
        dataId = await submitForScan(base, config, body);
      } catch (error) {
        return {
          outcome: "unavailable",
          reason: error instanceof Error ? error.name : "scanner error",
        };
      }

      try {
        return await pollForResult(base, config, dataId);
      } catch (error) {
        return {
          outcome: "unavailable",
          reason: error instanceof Error ? error.name : "scanner error",
        };
      }
    },

    async isAvailable(): Promise<boolean> {
      // A cheap liveness probe — the API key's own quota endpoint, never a
      // scan (same reasoning as ClamAV's PING/PONG: a health check that
      // consumed scan quota would cost real money/rate-limit budget on
      // every check).
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          const response = await fetch(`${base}/apikey`, {
            method: "GET",
            headers: { apikey: config.apiKey },
            signal: controller.signal,
          });
          return response.ok;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    },
  };
}

async function bufferContent(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of content) {
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

async function submitForScan(
  base: string, config: MetaDefenderConfig, body: Buffer,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${base}/file`, {
      method: "POST",
      headers: {
        apikey: config.apiKey,
        "Content-Type": "application/octet-stream",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`MetaDefenderUploadRejected:${String(response.status)}`);
    }
    const parsed = await response.json() as MetaDefenderUploadResponse;
    if (parsed.data_id === undefined || parsed.data_id === "") {
      throw new Error("MetaDefenderUploadMissingDataId");
    }
    return parsed.data_id;
  } finally {
    clearTimeout(timer);
  }
}

async function pollForResult(
  base: string, config: MetaDefenderConfig, dataId: string,
): Promise<MalwareScanResult> {
  for (let attempt = 0; attempt < config.maxPollAttempts; attempt += 1) {
    if (attempt > 0) await sleep(config.pollIntervalMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let parsed: MetaDefenderScanStatusResponse;
    try {
      const response = await fetch(`${base}/file/${encodeURIComponent(dataId)}`, {
        method: "GET",
        headers: { apikey: config.apiKey },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { outcome: "unavailable", reason: `scanner reported status ${String(response.status)}` };
      }
      parsed = await response.json() as MetaDefenderScanStatusResponse;
    } catch (error) {
      return {
        outcome: "unavailable",
        reason: error instanceof Error ? error.name : "scanner error",
      };
    } finally {
      clearTimeout(timer);
    }

    const code = parsed.scan_results?.scan_all_result_i;
    if (code === undefined) {
      return { outcome: "unavailable", reason: "unrecognised scanner response" };
    }
    if (RESULT_PENDING.has(code)) continue; // keep polling

    if (code === RESULT_CLEAN) return { outcome: "clean" };
    if (RESULT_INFECTED.has(code)) {
      // INTERNAL telemetry only — the first engine to report a name, never
      // returned to a client (same rule as ClamAV's `signature` field).
      const details = parsed.scan_results?.scan_details ?? {};
      const firstNamed = Object.values(details).find((d) => d.threat_found !== undefined && d.threat_found !== "");
      return {
        outcome: "infected",
        ...(firstNamed?.threat_found === undefined ? {} : { signature: firstNamed.threat_found }),
      };
    }
    // Every other documented code (archive errors, encrypted files, sandbox
    // verdicts, rate-limited, etc.) is deliberately NOT evidence of
    // cleanliness.
    return { outcome: "unavailable", reason: `scanner reported result code ${String(code)}` };
  }
  return { outcome: "unavailable", reason: "scanner did not complete within the polling budget" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
