// Folder placement and the document lifecycle: what is refused, and why.

import { describe, it, expect } from "vitest";
import {
  checkFolderPlacement, folderSubtree, lifecycleStateOf, applyLifecycle,
  canApplyLifecycle, MAX_FOLDER_DEPTH, DOCUMENT_LIFECYCLE_STATES,
  type FolderNode,
} from "./index.js";

const WS = "ws_1";
const folder = (id: string, parent: string | null, ws = WS): FolderNode =>
  ({ folderId: id, workspaceId: ws, parentFolderId: parent });

describe("placement", () => {
  it("refuses a move that would close a loop", () => {
    const folders = [folder("a", null), folder("b", "a"), folder("c", "b")];
    expect(checkFolderPlacement("a", "c", WS, folders)).toBe("cycle");
  });

  it("allows filing deeper than an org chart would", () => {
    // A filing tree mirrors how people think about work and routinely reaches
    // "2026 / Contracts / Vendors / Acme / Amendments". The org-chart bound
    // would refuse that, which is why the two bounds are separate numbers.
    const folders: FolderNode[] = [folder("f0", null)];
    for (let i = 1; i < MAX_FOLDER_DEPTH; i++) {
      folders.push(folder(`f${String(i)}`, `f${String(i - 1)}`));
    }
    expect(checkFolderPlacement("new", `f${String(MAX_FOLDER_DEPTH - 1)}`, WS, folders))
      .toBeNull();
  });

  it("refuses a foreign parent exactly as a missing one", () => {
    const foreign = checkFolderPlacement("a", "x", WS, [folder("x", null, "ws_2")]);
    expect(foreign).toBe("cross-workspace");
    expect(checkFolderPlacement("a", "ghost", WS, [])).toBe("cross-workspace");
  });
});

describe("subtree", () => {
  it("includes the folder itself", () => {
    // "Documents in this folder" means the folder and everything under it.
    expect(folderSubtree("a", [folder("a", null)])).toEqual(["a"]);
  });

  it("collects descendants and nothing beside them", () => {
    const folders = [
      folder("root", null), folder("a", "root"), folder("b", "root"),
      folder("a1", "a"),
    ];
    expect([...folderSubtree("a", folders)].sort()).toEqual(["a", "a1"]);
  });
});

describe("lifecycle state", () => {
  it("is derived, so it cannot disagree with itself", () => {
    expect(lifecycleStateOf({ archivedAt: null, deletedAt: null })).toBe("active");
    expect(lifecycleStateOf({ archivedAt: 1, deletedAt: null })).toBe("archived");
    expect(lifecycleStateOf({ archivedAt: null, deletedAt: 1 })).toBe("trashed");
  });

  it("decides rather than throws on data the database forbids", () => {
    // A CHECK constraint makes both-set impossible. A read path that crashed on
    // it would take down a list view for everybody, so trash wins and the list
    // still renders.
    expect(lifecycleStateOf({ archivedAt: 1, deletedAt: 2 })).toBe("trashed");
  });

  it("has exactly three states", () => {
    expect(DOCUMENT_LIFECYCLE_STATES).toHaveLength(3);
  });
});

describe("lifecycle transitions", () => {
  it("archives and restores an active document", () => {
    expect(applyLifecycle("active", "archive")).toBe("archived");
    expect(applyLifecycle("archived", "restore")).toBe("active");
  });

  it("restores from trash to ACTIVE, never straight to archived", () => {
    // Restoring is putting something back where it was, and where it was is the
    // folder. Archiving it again is a second, deliberate act.
    expect(applyLifecycle("trashed", "restore")).toBe("active");
    expect(canApplyLifecycle("trashed", "archive")).toBe(false);
  });

  it("permits permanent deletion ONLY from trash", () => {
    // The handbook is explicit: do not delete permanently unless the lifecycle
    // supports it. Trash is the staging area that makes it supportable.
    expect(canApplyLifecycle("trashed", "delete")).toBe(true);
    expect(canApplyLifecycle("active", "delete")).toBe(false);
    expect(canApplyLifecycle("archived", "delete")).toBe(false);
  });

  it("distinguishes deleted from not-allowed", () => {
    // Three outcomes, genuinely different. Collapsing them would make permanent
    // deletion look like a refusal to every caller.
    expect(applyLifecycle("trashed", "delete")).toBeNull();
    expect(applyLifecycle("active", "delete")).toBeUndefined();
  });

  it("can trash an archived document without restoring it first", () => {
    // Cleaning out an archive is ordinary. Forcing a restore first would put the
    // document back in a folder somebody deliberately took it out of.
    expect(applyLifecycle("archived", "trash")).toBe("trashed");
  });
});
