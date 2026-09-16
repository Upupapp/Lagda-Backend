// No test file existed for either scanner provider before this — a gap
// surfaced by the Phase 1 readiness audit. `fetch` is mocked here rather than
// hitting the real MetaDefender Cloud API (no API key exists in this repo,
// and none should be invented — see the still-open OPSWAT ToS question).
// Every case defends the same "fail closed" contract as the ClamAV suite:
// anything outside the explicit clean/infected result codes must come back
// `unavailable`, never `clean`.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createMetaDefenderScanner } from "./metadefender-scanner.js";

const CONFIG = {
  apiKey: "test-key",
  apiBaseUrl: "https://metadefender.test/v4",
  timeoutMs: 2000,
  maxFileBytes: 1_000_000,
  pollIntervalMs: 1,
  maxPollAttempts: 3,
};

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("createMetaDefenderScanner", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reports clean on scan_all_result_i 0", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data_id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({ scan_results: { scan_all_result_i: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({ outcome: "clean" });
  });

  it("reports infected with the signature on an infected result code", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data_id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({
        scan_results: {
          scan_all_result_i: 1,
          scan_details: { engineA: { threat_found: "Eicar-Test-Signature" } },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({ outcome: "infected", signature: "Eicar-Test-Signature" });
  });

  it("keeps polling through pending codes, then resolves clean", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data_id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({ scan_results: { scan_all_result_i: 254 } }))
      .mockResolvedValueOnce(jsonResponse({ scan_results: { scan_all_result_i: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({ outcome: "clean" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never reports clean for an undocumented result code (fail closed)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data_id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({ scan_results: { scan_all_result_i: 9999 } }));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result.outcome).toBe("unavailable");
  });

  it("reports unavailable if the polling budget is exhausted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data_id: "d1" }))
      .mockResolvedValue(jsonResponse({ scan_results: { scan_all_result_i: 255 } }));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({
      outcome: "unavailable",
      reason: "scanner did not complete within the polling budget",
    });
  });

  it("reports unavailable when the upload is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 401));
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner(CONFIG);
    const result = await scanner.scan({ byteSize: 3, content: oneChunk(Buffer.from("abc")) });
    expect(result.outcome).toBe("unavailable");
  });

  it("refuses a file over maxFileBytes before ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createMetaDefenderScanner({ ...CONFIG, maxFileBytes: 2 });
    const result = await scanner.scan({ byteSize: 100, content: oneChunk(Buffer.from("abc")) });
    expect(result).toEqual({
      outcome: "unavailable",
      reason: "file exceeds the scanner's maximum file size",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isAvailable resolves true when the apikey endpoint responds ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true } as Response));
    const scanner = createMetaDefenderScanner(CONFIG);
    expect(await scanner.isAvailable()).toBe(true);
  });

  it("isAvailable resolves false on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));
    const scanner = createMetaDefenderScanner(CONFIG);
    expect(await scanner.isAvailable()).toBe(false);
  });
});
