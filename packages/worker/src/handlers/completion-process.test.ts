// The handler seam: payload validation only. Behavior against real
// dependencies (claim, idempotency, retry) is proven against real
// PostgreSQL/pg-boss/MinIO in completion-pipeline.integration.test.ts —
// exactly the "not unit tests alone" requirement for this class of wiring.

import { describe, it, expect } from "vitest";
import { parseCompletionProcessPayload } from "./completion-process.js";
import { TerminalJobError } from "@lagda/application";

describe("payload validation", () => {
  it("accepts a workspace id and a run id, and nothing else", () => {
    expect(parseCompletionProcessPayload({
      workspaceId: "ws_1", completionRunId: "crun_1",
    })).toEqual({ workspaceId: "ws_1", completionRunId: "crun_1" });
  });

  it("rejects a payload missing either identifier", () => {
    for (const bad of [
      { workspaceId: "ws_1" },
      { completionRunId: "crun_1" },
      {},
    ]) {
      expect(() => parseCompletionProcessPayload(bad)).toThrow(TerminalJobError);
    }
  });

  it("rejects a payload carrying extra fields", () => {
    expect(() => parseCompletionProcessPayload({
      workspaceId: "ws_1", completionRunId: "crun_1", extra: "nope",
    })).toThrow(TerminalJobError);
  });

  it("treats malformed input as terminal, not retryable", () => {
    for (const bad of [null, "crun_1", 42, { workspaceId: 1, completionRunId: 2 }]) {
      expect(() => parseCompletionProcessPayload(bad)).toThrow(TerminalJobError);
    }
  });
});
