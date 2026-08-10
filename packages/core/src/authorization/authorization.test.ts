// The authorization policy, exhaustively.
//
// Table-driven and complete: every role against every capability, every actor
// role against every target role. 126 + 49 assertions that run with no database,
// no HTTP and nothing mocked — which is the point of keeping the policy pure.
//
// The expectations here are written out by hand ON PURPOSE. A test that derived
// them from `ROLE_CAPABILITIES` would assert that the policy equals itself and
// would pass after any change to it. These tables are a second, independent
// statement of the intended matrix, and the two have to agree.

import { describe, it, expect } from "vitest";
import type { WorkspaceRole } from "@lagda/contracts";
import { WORKSPACE_ROLES, INVITABLE_WORKSPACE_ROLES } from "@lagda/contracts";
import {
  WORKSPACE_CAPABILITIES, hasCapability, capabilitiesFor,
  canGrantRole, canGrantInvitationRole,
  wouldRemoveLastOwner, assertOwnerRemains, OWNERSHIP_MODEL,
  type WorkspaceCapability,
} from "./index.js";
import { InvariantViolationError } from "../common/index.js";

// ── The expected matrix, written independently of the policy ────────────────

/** The four contact capabilities, which travel together in every role. */
const CONTACT_CAPABILITIES: readonly WorkspaceCapability[] = [
  "contact.view", "contact.create", "contact.update", "contact.archive",
];

/**
 * Document WRITE. Held by the four roles with `prepare_documents`.
 *
 * Separate from `document.view` because — unlike contacts — the product does
 * NOT move them together: `view_documents` reaches six roles and
 * `prepare_documents` only four.
 */
const DOCUMENT_WRITE: readonly WorkspaceCapability[] = [
  "document.create", "document.update",
  // BACKEND-30. Authoring the signing layout is the product's
  // `prepare_documents`, held by the same four roles as the other document
  // writes — and declared separately so the first product change that
  // distinguishes renaming from preparing is a one-line edit.
  "document.prepare",
  // BACKEND-32. Committing that layout to an immutable workflow. The same four
  // roles today, and separate for the same reason one step further along:
  // preparing is reversible and creating a signing request is not.
  "signing-request.create",
  // BACKEND-33. Releasing it to counterparties. Same four roles again, and the
  // one most likely to be split first - assembling a document and releasing it
  // are different acts with different consequences.
  "signing-request.send",
];

/**
 * Reading a signing request travels with `document.view`, not with create.
 *
 * Six roles, including `reviewer` and `auditor`. An auditor who could not see
 * what was asked of whom could not audit anything that happened to it.
 */
const DOCUMENT_READ: readonly WorkspaceCapability[] = [
  "document.view", "signing-request.view",
];

const ADMIN_CAPABILITIES: readonly WorkspaceCapability[] = [
  "workspace.view", "workspace.update",
  "membership.view", "membership.role.change", "membership.remove",
  "invitation.view", "invitation.create", "invitation.resend", "invitation.revoke",
];

const EXPECTED: Readonly<Record<WorkspaceRole, readonly WorkspaceCapability[]>> = {
  owner: [
    ...ADMIN_CAPABILITIES, ...CONTACT_CAPABILITIES,
    ...DOCUMENT_READ, ...DOCUMENT_WRITE, "workspace.ownership.transfer",
  ],
  administrator: [
    ...ADMIN_CAPABILITIES, ...CONTACT_CAPABILITIES,
    ...DOCUMENT_READ, ...DOCUMENT_WRITE,
  ],
  // The only role with NOTHING beyond `workspace.view`. Not a PlatformRole, so
  // it holds neither `manage_contacts` nor `view_documents` (OD-100).
  member: ["workspace.view"],
  // The two rows that make this matrix worth having. Both hold every contact
  // capability and NO membership capability — a shape no `owner ||
  // administrator` check could have produced, and the product's own answer:
  // `manage_contacts` is in four roles' permission sets, and `sender` is the
  // role the address book exists for.
  template_administrator: [
    "workspace.view", ...CONTACT_CAPABILITIES, ...DOCUMENT_READ, ...DOCUMENT_WRITE,
  ],
  sender: [
    "workspace.view", ...CONTACT_CAPABILITIES, ...DOCUMENT_READ, ...DOCUMENT_WRITE,
  ],
  // No contact capability at all, INCLUDING view. `manage_contacts` is also the
  // navigation gate on /app/contacts, so these roles cannot reach the address
  // book — and it holds counterparties' names, emails and phone numbers.
  // READ without WRITE. The asymmetry that no `owner || administrator` check
  // could produce, and the product's own answer: `view_documents` without
  // `prepare_documents`. A reviewer reads documents for a living and creates
  // none; an auditor cannot review what happened without reading it.
  reviewer: ["workspace.view", ...DOCUMENT_READ],
  auditor: ["workspace.view", ...DOCUMENT_READ],
};

describe("the role model", () => {
  it("contains exactly the roles the product has", () => {
    // Speculative roles other products ship and LAGDA does not: `super_admin`,
    // `manager`, `editor`, `contributor`, `viewer`, `billing_admin`,
    // `security_admin`. The last three appear in the frontend's `PlatformRole`
    // but have no workspace-membership meaning — see the product inventory.
    expect([...WORKSPACE_ROLES].sort()).toEqual([
      "administrator", "auditor", "member", "owner",
      "reviewer", "sender", "template_administrator",
    ]);
  });

  it("uses a single ownership model, stated in code", () => {
    expect(OWNERSHIP_MODEL).toBe("SINGLE_OWNER");
  });
});

// ── The exhaustive capability matrix ─────────────────────────────────────────

describe("role to capability matrix", () => {
  for (const role of WORKSPACE_ROLES) {
    for (const capability of WORKSPACE_CAPABILITIES) {
      const expected = EXPECTED[role].includes(capability);
      it(`${role} ${expected ? "HAS" : "does NOT have"} ${capability}`, () => {
        expect(hasCapability(role, capability)).toBe(expected);
      });
    }
  }

  it("covers every role and every capability with no gaps", () => {
    // Guards the loop above: if a role or capability were added and the
    // EXPECTED table not updated, this fails rather than the matrix silently
    // testing fewer combinations.
    expect(Object.keys(EXPECTED).sort()).toEqual([...WORKSPACE_ROLES].sort());
    expect(WORKSPACE_CAPABILITIES.length).toBe(21);
  });
});

describe("default deny", () => {
  it("denies a capability that does not exist", () => {
    expect(hasCapability("owner", "document.delete" as WorkspaceCapability)).toBe(false);
  });

  it("denies EVERY capability to a role that does not exist", () => {
    // A value that reached the policy without a mapping is a bug, and the safe
    // behaviour for a bug inside an authorization function is to refuse.
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(hasCapability("superuser" as WorkspaceRole, capability)).toBe(false);
    }
  });

  it("returns no capabilities for an unknown role", () => {
    expect(capabilitiesFor("superuser" as WorkspaceRole)).toEqual([]);
  });

  it("never grants a capability through a wildcard or an inherited role", () => {
    // `member` holds exactly one capability. If a hierarchy or a fallback were
    // ever introduced, this is where it would show up.
    expect(capabilitiesFor("member")).toEqual(["workspace.view"]);
  });
});

describe("the capability projection", () => {
  it("returns a COPY that cannot mutate the policy", () => {
    const first = capabilitiesFor("owner");
    first.push("document.delete" as WorkspaceCapability);
    first.length = 0;

    // The next caller is unaffected, and the policy still denies.
    expect(capabilitiesFor("owner")).toContain("workspace.update");
    expect(hasCapability("owner", "workspace.update")).toBe(true);
  });

  it("matches the matrix exactly for every role", () => {
    for (const role of WORKSPACE_ROLES) {
      expect([...capabilitiesFor(role)].sort()).toEqual([...EXPECTED[role]].sort());
    }
  });
});

// ── The exhaustive grant matrix ──────────────────────────────────────────────

describe("role grant matrix", () => {
  /** Roles that may hand out roles at all. */
  const GRANTORS: readonly WorkspaceRole[] = ["owner", "administrator"];

  for (const actorRole of WORKSPACE_ROLES) {
    for (const targetRole of WORKSPACE_ROLES) {
      const expected = targetRole !== "owner" && GRANTORS.includes(actorRole);
      it(`${actorRole} ${expected ? "MAY" : "may NOT"} grant ${targetRole}`, () => {
        expect(canGrantRole(actorRole, targetRole)).toBe(expected);
      });
    }
  }

  it("lets NOBODY grant owner — not even the owner", () => {
    // Ownership moves through a dedicated transfer operation and nothing else.
    // A role dropdown that could mint an owner would break
    // `assertExactlyOneOwner` days after anyone reviewed it.
    for (const actorRole of WORKSPACE_ROLES) {
      expect(canGrantRole(actorRole, "owner")).toBe(false);
      expect(canGrantInvitationRole(actorRole, "owner")).toBe(false);
    }
  });

  it("lets an administrator create peers but never a superior", () => {
    expect(canGrantRole("administrator", "administrator")).toBe(true);
    expect(canGrantRole("administrator", "owner")).toBe(false);
  });

  it("lets no ordinary role grant anything", () => {
    for (const actorRole of ["member", "sender", "reviewer", "auditor",
      "template_administrator"] as const) {
      for (const targetRole of WORKSPACE_ROLES) {
        expect(canGrantRole(actorRole, targetRole)).toBe(false);
      }
    }
  });
});

describe("invitation grant matrix", () => {
  for (const actorRole of WORKSPACE_ROLES) {
    for (const targetRole of INVITABLE_WORKSPACE_ROLES) {
      const expected = hasCapability(actorRole, "invitation.create");
      it(`${actorRole} ${expected ? "MAY" : "may NOT"} invite as ${targetRole}`, () => {
        expect(canGrantInvitationRole(actorRole, targetRole)).toBe(expected);
      });
    }
  }

  it("keeps owner out of the invitable set entirely", () => {
    expect(INVITABLE_WORKSPACE_ROLES).not.toContain("owner");
  });
});

// ── Ownership safety ─────────────────────────────────────────────────────────

describe("last-owner protection", () => {
  it("blocks demoting the only owner", () => {
    expect(wouldRemoveLastOwner({ currentRole: "owner", ownerCount: 1 })).toBe(true);
  });

  it("blocks it even if the count is somehow already zero", () => {
    expect(wouldRemoveLastOwner({ currentRole: "owner", ownerCount: 0 })).toBe(true);
  });

  it("permits it when another owner remains", () => {
    // Unreachable under SINGLE_OWNER, and the policy stays honest so a change
    // to the ownership model does not require rewriting this function.
    expect(wouldRemoveLastOwner({ currentRole: "owner", ownerCount: 2 })).toBe(false);
  });

  it("never blocks a non-owner, whatever the count", () => {
    for (const role of WORKSPACE_ROLES) {
      if (role === "owner") continue;
      expect(wouldRemoveLastOwner({ currentRole: role, ownerCount: 1 })).toBe(false);
    }
  });

  it("throws when a resulting state would have no owner", () => {
    expect(() => { assertOwnerRemains(0); }).toThrow(InvariantViolationError);
    expect(() => { assertOwnerRemains(1); }).not.toThrow();
  });
});

// ── Purity ───────────────────────────────────────────────────────────────────

describe("the policy is deterministic", () => {
  it("returns the same answer for the same inputs, always", () => {
    for (const role of WORKSPACE_ROLES) {
      for (const capability of WORKSPACE_CAPABILITIES) {
        const first = hasCapability(role, capability);
        expect(hasCapability(role, capability)).toBe(first);
        expect(hasCapability(role, capability)).toBe(first);
      }
    }
  });
});
