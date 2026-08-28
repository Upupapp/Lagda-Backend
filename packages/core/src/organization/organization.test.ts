// Organization hierarchy: the placements that must be refused.

import { describe, it, expect } from "vitest";
import {
  checkUnitPlacement, descendantsOf, MAX_UNIT_DEPTH,
  ORGANIZATION_UNIT_KINDS, isOrganizationUnitKind, type UnitNode,
} from "./index.js";

const WS = "ws_1";
const unit = (id: string, parent: string | null, ws = WS): UnitNode =>
  ({ unitId: id, workspaceId: ws, parentUnitId: parent });

describe("placement", () => {
  it("allows a root unit", () => {
    expect(checkUnitPlacement("u1", null, WS, [])).toBeNull();
  });

  it("refuses a unit as its own parent", () => {
    expect(checkUnitPlacement("u1", "u1", WS, [unit("u1", null)]))
      .toBe("self-parent");
  });

  it("refuses a move that would close a loop", () => {
    // u1 → u2 → u3. Moving u1 under u3 makes the chain eat itself.
    const units = [unit("u1", null), unit("u2", "u1"), unit("u3", "u2")];
    expect(checkUnitPlacement("u1", "u3", WS, units)).toBe("cycle");
  });

  it("terminates on a loop that already exists in the data", () => {
    // Not reachable through the API, but a walk that could spin on corrupt
    // data is a walk that takes the process down rather than failing a request.
    const units = [unit("u1", "u2"), unit("u2", "u1")];
    expect(checkUnitPlacement("u3", "u1", WS, units)).toBe("cycle");
  });

  it("refuses a chain deeper than the bound", () => {
    const units: UnitNode[] = [unit("u0", null)];
    for (let i = 1; i <= MAX_UNIT_DEPTH + 1; i++) {
      units.push(unit(`u${String(i)}`, `u${String(i - 1)}`));
    }
    expect(checkUnitPlacement("new", `u${String(MAX_UNIT_DEPTH + 1)}`, WS, units))
      .toBe("too-deep");
  });

  it("accepts a chain exactly at the bound", () => {
    // The bound is a limit, not an off-by-one trap. A hierarchy the product
    // genuinely has must fit.
    const units: UnitNode[] = [unit("u0", null)];
    for (let i = 1; i < MAX_UNIT_DEPTH; i++) {
      units.push(unit(`u${String(i)}`, `u${String(i - 1)}`));
    }
    expect(checkUnitPlacement("new", `u${String(MAX_UNIT_DEPTH - 1)}`, WS, units))
      .toBeNull();
  });

  it("answers the same for a foreign parent as for a missing one", () => {
    // A caller who could tell them apart would learn that a unit id exists in
    // somebody else's workspace.
    const foreign = checkUnitPlacement("u1", "other", WS, [unit("other", null, "ws_2")]);
    const missing = checkUnitPlacement("u1", "ghost", WS, []);
    expect(foreign).toBe("cross-workspace");
    expect(missing).toBe("cross-workspace");
  });
});

describe("descendants", () => {
  it("includes the root itself", () => {
    // "Documents in this department" means the department AND its divisions,
    // which is what somebody filing under it expects.
    expect(descendantsOf("u1", [unit("u1", null)])).toEqual(["u1"]);
  });

  it("collects a whole subtree and nothing beside it", () => {
    const units = [
      unit("root", null), unit("a", "root"), unit("b", "root"),
      unit("a1", "a"), unit("elsewhere", null),
    ];
    expect([...descendantsOf("a", units)].sort()).toEqual(["a", "a1"]);
  });

  it("terminates on a cyclic subtree", () => {
    const units = [unit("a", "b"), unit("b", "a")];
    expect(descendantsOf("a", units).length).toBeLessThanOrEqual(2);
  });
});

describe("kinds", () => {
  it("carries no behaviour -- nothing branches on it", () => {
    // Seven labels for one structural thing. If a kind ever needs behaviour it
    // stops being a label, and that is a modelling decision rather than a
    // switch statement somebody adds in a hurry.
    expect(ORGANIZATION_UNIT_KINDS).toHaveLength(7);
    expect(isOrganizationUnitKind("department")).toBe(true);
    expect(isOrganizationUnitKind("Department")).toBe(false);
    expect(isOrganizationUnitKind("guild")).toBe(false);
  });
});
