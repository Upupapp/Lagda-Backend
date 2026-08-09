// Mapping is pure, so it is tested without a database.
//
// This covers the case deliberately removed from the integration suite: a
// persisted value the domain does not recognise. Reproducing it there needed
// the CHECK constraint dropped, and a test that mutates SCHEMA breaks isolation
// — TRUNCATE clears rows, not DDL, so one failed run leaks a missing constraint
// into every later run. Here the bad row is just an object.

import { describe, it, expect } from "vitest";
import { toMembershipRecord, toWorkspaceRecord, PersistenceMappingError } from "./index.js";

const CREATED_AT = new Date("2026-08-09T06:30:00.000Z");

describe("row → domain mapping", () => {
  it("maps a valid membership row", () => {
    const record = toMembershipRecord({
      member_id: "mem_1", workspace_id: "ws_1", user_id: "usr_1",
      role: "owner", created_at: CREATED_AT,
    });
    expect(record.role).toBe("owner");
    expect(record.createdAt).toBe(CREATED_AT.getTime());
  });

  it("REFUSES a role the domain does not recognise", () => {
    // A value written by an older release, or edited during an incident.
    // `row.role as WorkspaceRole` would let it through silently.
    expect(() => toMembershipRecord({
      member_id: "mem_legacy", workspace_id: "ws_1", user_id: "usr_1",
      role: "legacy_role", created_at: CREATED_AT,
    })).toThrow(PersistenceMappingError);
  });

  it("names the column but never the offending value", () => {
    // A malformed persisted value can be PII; an error message reaches logs.
    try {
      toMembershipRecord({
        member_id: "m", workspace_id: "w", user_id: "u",
        role: "juan@example.com", created_at: CREATED_AT,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("workspace_memberships.role");
    }
  });

  it("converts timestamps to a numeric instant, never a Date", () => {
    // Date is mutable — handing one out lets a caller change a record's time.
    const record = toWorkspaceRecord({
      workspace_id: "ws_1", name: "Acme",
      owner_user_id: "usr_1", created_at: CREATED_AT,
    });
    expect(typeof record.createdAt).toBe("number");
    expect(new Date(record.createdAt).toISOString()).toBe("2026-08-09T06:30:00.000Z");
  });

  it("refuses an invalid persisted timestamp", () => {
    expect(() => toWorkspaceRecord({
      workspace_id: "ws_1", name: "Acme",
      owner_user_id: "usr_1", created_at: new Date("nonsense"),
    })).toThrow(PersistenceMappingError);
  });
});
