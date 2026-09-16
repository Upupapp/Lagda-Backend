// The handler seam: payload validation only. Behavior against real
// dependencies (stale-run recovery) is proven against real
// PostgreSQL/pg-boss/MinIO in completion-pipeline.integration.test.ts.

import { describe, it, expect } from "vitest";
import { parseCompletionReconcilePayload } from "./completion-reconcile.js";
import { TerminalJobError } from "@lagda/application";

describe("payload validation", () => {
  it("accepts a workspace id and nothing else", () => {
    expect(parseCompletionReconcilePayload({ workspaceId: "ws_1" }))
      .toEqual({ workspaceId: "ws_1" });
  });

  it("rejects a payload missing the workspace id", () => {
    expect(() => parseCompletionReconcilePayload({})).toThrow(TerminalJobError);
  });

  it("rejects a payload carrying extra fields", () => {
    expect(() => parseCompletionReconcilePayload({
      workspaceId: "ws_1", completionRunId: "crun_1",
    })).toThrow(TerminalJobError);
  });

  it("treats malformed input as terminal, not retryable", () => {
    for (const bad of [null, "ws_1", 42, { workspaceId: 1 }]) {
      expect(() => parseCompletionReconcilePayload(bad)).toThrow(TerminalJobError);
    }
  });
});
