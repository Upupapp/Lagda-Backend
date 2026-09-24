// Migration 029's vocabulary, frozen against its own history.
//
// ── Why this test exists ───────────────────────────────────────────────────
//
// Migration 026 shipped a defect of exactly this shape: it widened the STEP
// vocabulary in `@lagda/contracts` and the STEP CHECK, and never touched the
// FAILURE CODE CHECK for the same vocabulary. The first real completion attempt
// would have raised Postgres 23514 on its only reachable path. Migration 027
// existed solely to fix it.
//
// The root cause was that a vocabulary lived in two places and only one of them
// was typechecked. A frozen `Record` makes adding a value without classifying it
// a compile error; nothing makes adding a value without widening its CHECK
// anything at all.
//
// The equivalent guard for completion codes is an INTEGRATION test, which needs
// a live PostgreSQL and skips without one. This one deliberately does not: it
// compares two TypeScript constants, so it runs in the ordinary suite and fails
// on a laptop with no database. The failure it prevents does not need a database
// to be real.
//
// ── Why this no longer compares against the LIVE application export ───────
//
// It used to — `.toEqual(EVIDENCE_EVENT_TYPES)` — because 029 was the newest
// widening at the time, and "029's list" and "everything the application can
// emit" were the same set. 069 added two more event types and its own CHECK
// widening, which made that equality false without either list being wrong:
// 029's list is what 029's CHECK actually admits, a historical fact, and it
// must stay exactly that. `069_approval_workflow.test.ts` now carries the
// "agrees with the live application" guard forward from where this one left
// off, the same way this file's OWN existence carries 003's forward.

import { describe, it, expect } from "vitest";
import {
  MIGRATION_029_EVENT_TYPES, MIGRATION_029_SOURCE_TYPES,
} from "./029_evidence_event_provenance.js";

describe("migration 029 event vocabulary", () => {
  it("admits exactly the nineteen event types 029 introduced", () => {
    // Sorted, because the CHECK is a set and declaration order is
    // presentation. This is now a frozen historical assertion — see the file
    // header for why it no longer compares against the live application
    // export.
    expect([...MIGRATION_029_EVENT_TYPES].sort()).toEqual([
      "authentication-completed", "certificate-generated", "completion-ready",
      "consent-accepted", "document-sealed", "document-viewed",
      "field-merge-completed", "final-seal-completed", "invitation-sent",
      "participant-declined", "recipient-activated", "signature-completed",
      "submission-accepted", "transaction-cancelled", "transaction-completed",
      "transaction-created", "transaction-expired", "transaction-sent",
      "verification-record-created",
    ]);
  });

  it("preserves migration 003's thirteen types unchanged", () => {
    // The first thirteen entries are 003's vocabulary and `down` narrows back to
    // them by slicing. Reordering or editing them would silently change what
    // `down` restores — the slice would still be thirteen long and would still
    // look right.
    expect(MIGRATION_029_EVENT_TYPES.slice(0, 13)).toEqual([
      "transaction-created", "transaction-sent", "transaction-cancelled",
      "transaction-expired", "transaction-completed", "invitation-sent",
      "authentication-completed", "consent-accepted", "document-viewed",
      "signature-completed", "participant-declined", "document-sealed",
      "verification-record-created",
    ]);
  });

  it("adds exactly the six types the gap analysis identified", () => {
    expect(MIGRATION_029_EVENT_TYPES.slice(13)).toEqual([
      "recipient-activated", "submission-accepted", "completion-ready",
      "field-merge-completed", "certificate-generated", "final-seal-completed",
    ]);
  });

  it("declares no duplicate event type", () => {
    // A duplicate is harmless in an SQL IN list and would quietly make the
    // `slice(13)` boundary wrong.
    expect(new Set(MIGRATION_029_EVENT_TYPES).size)
      .toBe(MIGRATION_029_EVENT_TYPES.length);
  });

  it("declares no duplicate source type", () => {
    expect(new Set(MIGRATION_029_SOURCE_TYPES).size)
      .toBe(MIGRATION_029_SOURCE_TYPES.length);
  });

  it("keeps every source type inside the column width", () => {
    // `source_type varchar(32)`. A longer literal would be admitted by the CHECK
    // and rejected by the column, which is a confusing pair of errors to debug.
    for (const type of MIGRATION_029_SOURCE_TYPES) {
      expect(type.length).toBeLessThanOrEqual(32);
    }
  });

  it("keeps every event type inside the column width", () => {
    // `event_type varchar(64)`.
    for (const type of MIGRATION_029_EVENT_TYPES) {
      expect(type.length).toBeLessThanOrEqual(64);
    }
  });
});
