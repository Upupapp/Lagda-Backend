// Workspace lifecycle (BACKEND-25).
//
// Four use cases and one authorization seam. Deliberately not exported from
// here: invitations, member management, role assignment, ownership transfer,
// archive, restore and deletion — each belongs to a later command and none has
// a placeholder (§193, §194, §265).

export * from "./workspace-access.js";
export * from "./create-workspace.js";
export * from "./list-my-workspaces.js";
export * from "./get-workspace.js";
export * from "./get-workspace-member.js";
