// 082. Branding: every member reads it, owners and administrators change it,
// the display name IS the workspace name, and each change is logged.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
} from "../test-support/fakes.js";
import { createIdempotencyKeyDigester, createIdempotencyRecordIds } from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "./create-workspace.js";
import {
  getWorkspaceBranding, updateWorkspaceBranding, setWorkspaceLogo, removeWorkspaceLogo,
  resetWorkspaceBranding, getWorkspaceLogo,
} from "./branding.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";

const AT = Date.parse("2026-09-26T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const MEMBER = "usr_member" as UserId;
const STRANGER = "usr_stranger" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: `ses_${userId}` as SessionId });

let store: InMemoryStore;
let deps: { transactions: FakeTransactionManager; clock: FixedClock };
let workspaceId: WorkspaceId;
const LOGO = { bytes: new Uint8Array([1, 2, 3]), width: 400, height: 120, digest: "a".repeat(64) };

beforeEach(async () => {
  store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  deps = { transactions, clock: new FixedClock(AT) };
  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT), workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });
  workspaceId = created.workspaceId;
  store.memberships.push(
    { memberId: "mem_admin" as never, workspaceId, userId: ADMIN, role: "administrator", createdAt: AT },
    { memberId: "mem_member" as never, workspaceId, userId: MEMBER, role: "member", createdAt: AT },
  );
});

describe("reading", () => {
  it("shows the defaults, named after the workspace, before anything is saved", async () => {
    await expect(getWorkspaceBranding(actor(MEMBER), workspaceId, deps)).resolves.toEqual({
      displayName: "Acme Legal", senderDisplayName: null, footerTagline: null, primaryColor: null,
      logo: null, updatedAt: null, canEdit: false,
    });
    expect((await getWorkspaceBranding(actor(OWNER), workspaceId, deps)).canEdit).toBe(true);
  });

  it("hides the workspace from a non-member", async () => {
    await expect(getWorkspaceBranding(actor(STRANGER), workspaceId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("changing", () => {
  it("saves the settings, uppercases the colour, and logs what changed", async () => {
    const view = await updateWorkspaceBranding(actor(ADMIN), workspaceId, {
      senderDisplayName: "Acme Legal Team", footerTagline: "Trusted since 1998", primaryColor: "#0a4b8c",
    }, deps);
    expect(view).toMatchObject({
      senderDisplayName: "Acme Legal Team", footerTagline: "Trusted since 1998", primaryColor: "#0A4B8C", updatedAt: AT,
    });
    const logged = store.activity.filter(a => a.action === "workspace.branding_changed");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.details["changed"]).toBe("sender name, footer tagline, brand colour");
  });

  it("renames the WORKSPACE when the display name changes", async () => {
    const view = await updateWorkspaceBranding(actor(OWNER), workspaceId, { displayName: "Acme Law" }, deps);
    expect(view.displayName).toBe("Acme Law");
    expect(store.activity.map(a => a.action)).toContain("workspace.renamed");
    expect(store.activity.map(a => a.action)).not.toContain("workspace.branding_changed");
  });

  it("leaves absent keys alone, clears with null, and logs nothing when nothing changed", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { senderDisplayName: "Team", primaryColor: "#112233" }, deps);
    const view = await updateWorkspaceBranding(actor(OWNER), workspaceId, { senderDisplayName: null }, deps);
    expect(view).toMatchObject({ senderDisplayName: null, primaryColor: "#112233" });
    const before = store.activity.length;
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { primaryColor: "#112233" }, deps);
    expect(store.activity.length).toBe(before);
  });

  it("refuses a bad colour, an over-long tagline and control characters", async () => {
    for (const input of [
      { primaryColor: "blue" }, { primaryColor: "#12345" },
      { footerTagline: "x".repeat(161) }, { senderDisplayName: "Team\u0007" },
    ]) {
      await expect(updateWorkspaceBranding(actor(OWNER), workspaceId, input, deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
  });

  it("is for owners and administrators only", async () => {
    await expect(updateWorkspaceBranding(actor(MEMBER), workspaceId, { primaryColor: "#000000" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(setWorkspaceLogo(actor(MEMBER), workspaceId, LOGO, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(resetWorkspaceBranding(actor(MEMBER), workspaceId, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("the logo", () => {
  it("is set, readable by any member, removed, and each step logged", async () => {
    const set = await setWorkspaceLogo(actor(OWNER), workspaceId, LOGO, deps);
    expect(set.logo).toEqual({ version: LOGO.digest, width: 400, height: 120 });
    await expect(getWorkspaceLogo(actor(MEMBER), workspaceId, deps)).resolves.toMatchObject({ mediaType: "image/png", width: 400 });
    const removed = await removeWorkspaceLogo(actor(OWNER), workspaceId, deps);
    expect(removed.logo).toBeNull();
    await expect(getWorkspaceLogo(actor(MEMBER), workspaceId, deps)).resolves.toBeNull();
    expect(store.activity.filter(a => a.action === "workspace.branding_changed").map(a => a.details["changed"]))
      .toEqual(["logo", "logo removed"]);
  });

  it("reset returns everything but the name to the defaults", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { senderDisplayName: "Team", primaryColor: "#112233" }, deps);
    await setWorkspaceLogo(actor(OWNER), workspaceId, LOGO, deps);
    const reset = await resetWorkspaceBranding(actor(OWNER), workspaceId, deps);
    expect(reset).toMatchObject({
      displayName: "Acme Legal", senderDisplayName: null, footerTagline: null, primaryColor: null, logo: null,
    });
  });
});
