// Organization units: what the use cases refuse, and why.

import { describe, it, expect } from "vitest";
import {
  createOrganizationUnit, updateOrganizationUnit, archiveOrganizationUnit,
  addUnitMember, removeUnitMember, listOrganizationUnits,
  type OrganizationDependencies, type OrganizationUnitId,
} from "./index.js";
import {
  InMemoryStore, FakeTransactionManager, FixedClock,
} from "../test-support/fakes.js";
import type { WorkspaceId, UserId } from "@lagda/contracts";

const AT = 1_760_000_000_000;
const WS = "ws_1" as WorkspaceId;
const OWNER = "usr_owner" as UserId;
const MEMBER = "usr_member" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

function harness() {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  let next = 0;

  store.workspaces.set(WS, {
    workspaceId: WS, name: "Reyes Legal", createdAt: AT,
  });
  store.memberships.push(
    { memberId: "mem_1", workspaceId: WS, userId: OWNER, role: "owner", createdAt: AT } as never,
    { memberId: "mem_2", workspaceId: WS, userId: MEMBER, role: "member", createdAt: AT } as never,
  );

  const deps: OrganizationDependencies = {
    transactions,
    clock: new FixedClock(AT),
    unitIds: {
      nextOrganizationUnitId: () => {
        next += 1;
        return `unit_${String(next)}` as OrganizationUnitId;
      },
    },
  };

  return { store, deps };
}

const create = (deps: OrganizationDependencies, over: {
  name?: string; kind?: string; parentUnitId?: string; actor?: UserId;
} = {}) => createOrganizationUnit({
  actor: { userId: over.actor ?? OWNER },
  workspaceId: WS,
  name: over.name ?? "Records",
  kind: over.kind ?? "department",
  ...(over.parentUnitId === undefined ? {} : { parentUnitId: over.parentUnitId }),
}, deps);

describe("authorization", () => {
  it("refuses a member who may read the chart but not edit it", async () => {
    // A unit is a container, not a permission -- but editing the container is
    // administration. A member reads the directory and changes nothing.
    const h = harness();
    await expect(create(h.deps, { actor: MEMBER })).rejects.toThrow();
  });

  it("lets a member read the chart", async () => {
    // The whole reason `unit.view` is separated from the write set: routing a
    // document to the right office requires knowing the offices.
    const h = harness();
    await create(h.deps);

    const units = await listOrganizationUnits(
      { actor: { userId: MEMBER }, workspaceId: WS }, h.deps);

    expect(units).toHaveLength(1);
  });

  it("refuses somebody who is not in the workspace at all", async () => {
    const h = harness();
    await expect(create(h.deps, { actor: OUTSIDER })).rejects.toThrow();
  });
});

describe("creation", () => {
  it("creates a root unit", async () => {
    const h = harness();
    const unit = await create(h.deps);

    expect(unit.parentUnitId).toBeNull();
    expect(unit.kind).toBe("department");
    expect(unit.archivedAt).toBeNull();
  });

  it("refuses a kind the product does not have", async () => {
    // The vocabulary is closed so a client cannot invent a hierarchy the
    // product then has to honour.
    const h = harness();
    await expect(create(h.deps, { kind: "guild" })).rejects.toThrow();
  });

  it("refuses an empty name", async () => {
    const h = harness();
    await expect(create(h.deps, { name: "   " })).rejects.toThrow();
  });

  it("trims the name rather than storing what was typed", async () => {
    const h = harness();
    const unit = await create(h.deps, { name: "  Records  " });
    expect(unit.name).toBe("Records");
  });

  it("refuses a parent from another workspace exactly as a missing one", async () => {
    const h = harness();
    await expect(create(h.deps, { parentUnitId: "unit_elsewhere" }))
      .rejects.toThrow();
  });

  it("refuses a duplicate name under the same parent", async () => {
    // Two "Records" under one department is ambiguous to a human choosing from
    // a list. The database index is the guarantee; this proves the path reaches
    // it rather than silently accepting.
    const h = harness();
    await create(h.deps, { name: "Records" });
    await expect(create(h.deps, { name: "records" })).rejects.toThrow();
  });

  it("allows the same name under different parents", async () => {
    // "Records" can exist under two departments. Only siblings collide.
    const h = harness();
    const a = await create(h.deps, { name: "Legal" });
    const b = await create(h.deps, { name: "Finance" });

    await create(h.deps, { name: "Records", parentUnitId: a.unitId });
    await expect(create(h.deps, { name: "Records", parentUnitId: b.unitId }))
      .resolves.toBeDefined();
  });
});

describe("moving", () => {
  it("refuses a move that would close a loop", async () => {
    const h = harness();
    const parent = await create(h.deps, { name: "Legal" });
    const child = await create(h.deps, {
      name: "Contracts", parentUnitId: parent.unitId,
    });

    await expect(updateOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: parent.unitId, name: "Legal", parentUnitId: child.unitId,
    }, h.deps)).rejects.toThrow();
  });

  it("renames without moving when no parent is supplied", async () => {
    // Absent means "leave it", not "make it a root". The difference is a whole
    // subtree relocating because a form omitted a field.
    const h = harness();
    const parent = await create(h.deps, { name: "Legal" });
    const child = await create(h.deps, {
      name: "Contracts", parentUnitId: parent.unitId,
    });

    const updated = await updateOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: child.unitId, name: "Agreements",
    }, h.deps);

    expect(updated.name).toBe("Agreements");
    expect(updated.parentUnitId).toBe(parent.unitId);
  });

  it("promotes to a root when the parent is explicitly null", async () => {
    const h = harness();
    const parent = await create(h.deps, { name: "Legal" });
    const child = await create(h.deps, {
      name: "Contracts", parentUnitId: parent.unitId,
    });

    const updated = await updateOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: child.unitId, name: "Contracts", parentUnitId: null,
    }, h.deps);

    expect(updated.parentUnitId).toBeNull();
  });
});

describe("archiving", () => {
  it("refuses while live children remain", async () => {
    // Archiving a department must not silently retire every division inside
    // it. Somebody has to decide where those go, and a cascade makes that
    // decision invisible.
    const h = harness();
    const parent = await create(h.deps, { name: "Legal" });
    await create(h.deps, { name: "Contracts", parentUnitId: parent.unitId });

    await expect(archiveOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS, unitId: parent.unitId,
    }, h.deps)).rejects.toThrow();
  });

  it("archives a leaf, and the row survives", async () => {
    // Archived, never deleted: documents and audit records reference units, and
    // "this department was dissolved" is information rather than an absence.
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });

    await archiveOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS, unitId: unit.unitId,
    }, h.deps);

    const units = await listOrganizationUnits(
      { actor: { userId: OWNER }, workspaceId: WS }, h.deps);
    expect(units).toHaveLength(1);
    expect(units[0]?.archivedAt).toBe(AT);
  });

  it("refuses to archive twice", async () => {
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });
    const archive = () => archiveOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS, unitId: unit.unitId,
    }, h.deps);

    await archive();
    await expect(archive()).rejects.toThrow();
  });
});

describe("membership", () => {
  it("refuses to file somebody who is not in the workspace", async () => {
    // The database enforces this with a compound FK. The fake reproduces it, so
    // a use case that skipped the check fails here rather than in an
    // integration run nobody has executed.
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });

    await expect(addUnitMember({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: unit.unitId, userId: OUTSIDER,
    }, h.deps)).rejects.toThrow();
  });

  it("adds somebody twice without complaining", async () => {
    // A second click is the state the caller asked for, not an error.
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });
    const add = () => addUnitMember({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: unit.unitId, userId: MEMBER,
    }, h.deps);

    await add();
    await expect(add()).resolves.toBeUndefined();
  });

  it("removes somebody who was never there without complaining", async () => {
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });

    await expect(removeUnitMember({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: unit.unitId, userId: MEMBER,
    }, h.deps)).resolves.toBeUndefined();
  });

  it("refuses to staff an archived unit", async () => {
    const h = harness();
    const unit = await create(h.deps, { name: "Legal" });
    await archiveOrganizationUnit({
      actor: { userId: OWNER }, workspaceId: WS, unitId: unit.unitId,
    }, h.deps);

    await expect(addUnitMember({
      actor: { userId: OWNER }, workspaceId: WS,
      unitId: unit.unitId, userId: MEMBER,
    }, h.deps)).rejects.toThrow();
  });
});
