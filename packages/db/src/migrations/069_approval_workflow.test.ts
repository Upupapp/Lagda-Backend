// Migration 069's vocabulary must agree with the application's.
//
// Carries forward the guard `029_evidence_event_provenance.test.ts` first
// established — see that file's header for why this compares two TypeScript
// constants rather than needing a live database, and why 029's own copy of
// this assertion was retired to a frozen historical one once this file
// existed to take over the "agrees with the live application" duty.

import { describe, it, expect } from "vitest";
import { EVIDENCE_EVENT_TYPES } from "@lagda/application";
import { MIGRATION_069_EVENT_TYPES } from "./069_approval_workflow.js";

describe("migration 069 event vocabulary", () => {
  it("admits exactly the event types the application can produce", () => {
    expect([...MIGRATION_069_EVENT_TYPES].sort())
      .toEqual([...EVIDENCE_EVENT_TYPES].sort());
  });

  it("adds exactly the two approval-ceremony types to 029's list", () => {
    expect(MIGRATION_069_EVENT_TYPES.slice(19)).toEqual([
      "approval-completed", "participant-skipped",
    ]);
  });

  it("declares no duplicate event type", () => {
    expect(new Set(MIGRATION_069_EVENT_TYPES).size)
      .toBe(MIGRATION_069_EVENT_TYPES.length);
  });

  it("keeps every event type inside the column width", () => {
    // `event_type varchar(64)`.
    for (const type of MIGRATION_069_EVENT_TYPES) {
      expect(type.length).toBeLessThanOrEqual(64);
    }
  });
});
