// The repository behavioural contract.
//
// One specification, run against BOTH the in-memory fake and the PostgreSQL
// adapter. Where they diverge, either the fake is lying to application tests or
// the adapter is wrong — and both matter.
//
// This is deliberately NOT a security proof. Only the real database exercises
// RLS, constraints and SQLSTATE; the fake passing tells you the application-
// visible semantics match, nothing more.
//
// Lives in application because application owns the ports. `@lagda/db` imports
// it to run the same suite against PostgreSQL.

import { toSha256Digest, type UserId, type WorkspaceId, type WorkspaceMemberId,
  type TransactionId, type DocumentId } from "@lagda/contracts";
import type { TransactionManager, EvidenceEventId, ArtifactId } from "../common/ports/index.js";

export interface ContractHarness {
  readonly transactions: TransactionManager;
  /** Clears all state between cases. */
  reset(): Promise<void>;
}

export interface ContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  beforeEach: (fn: () => Promise<void> | void) => void;
  expect: (value: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toHaveLength(n: number): void;
    readonly rejects: { toThrow(): Promise<void> };
  };
}

const AT = Date.parse("2026-08-09T08:00:00.000Z");
const USER_A = "usr_a" as UserId;
const USER_B = "usr_b" as UserId;
const WS_A = "ws_contract_a" as WorkspaceId;
const WS_B = "ws_contract_b" as WorkspaceId;
const MEM_A = "mem_contract_a" as WorkspaceMemberId;
const MEM_B = "mem_contract_b" as WorkspaceMemberId;
const REQ = "txn_contract_1" as TransactionId;
const DOC = "doc_contract_1" as DocumentId;
const DIGEST = toSha256Digest("c".repeat(64));

/**
 * Runs the contract against a harness.
 *
 * The test API is injected rather than imported so this module carries no
 * Vitest dependency into the application package's runtime graph.
 */
export function runRepositoryContract(
  label: string,
  harnessFactory: () => ContractHarness,
  api: ContractTestApi,
): void {
  const { describe, it, beforeEach, expect } = api;

  describe(`repository contract — ${label}`, () => {
    let harness: ContractHarness;

    beforeEach(async () => {
      harness = harnessFactory();
      await harness.reset();
    });

    const seed = async (workspaceId: WorkspaceId, memberId: WorkspaceMemberId, userId: UserId) =>
      harness.transactions.runForWorkspace(workspaceId, async uow => {
        await uow.workspaces.insert({
          workspaceId, name: `Workspace ${workspaceId}`, ownerUserId: userId, createdAt: AT,
        });
        await uow.memberships.insert({
          memberId, workspaceId, userId, role: "owner", createdAt: AT,
        });
      });

    it("round-trips a workspace and its owner", async () => {
      await seed(WS_A, MEM_A, USER_A);

      const loaded = await harness.transactions.runForWorkspace(WS_A, async uow => ({
        workspace: await uow.workspaces.find(),
        members: await uow.memberships.list(),
      }));

      expect(loaded.workspace?.workspaceId).toBe(WS_A);
      expect(loaded.workspace?.createdAt).toBe(AT);
      expect(loaded.members).toHaveLength(1);
      expect(loaded.members[0]?.role).toBe("owner");
    });

    it("returns null for a member that does not exist", async () => {
      await seed(WS_A, MEM_A, USER_A);
      const missing = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.findMember("mem_nope" as WorkspaceMemberId));
      expect(missing).toBeNull();
    });

    it("returns null for a workspace that does not exist", async () => {
      const missing = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.workspaces.find());
      expect(missing).toBeNull();
    });

    it("CANNOT see another workspace's member", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      // Scoped to A, asking for B's member by ID.
      const found = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.findMember(MEM_B));
      expect(found).toBeNull();
    });

    it("lists only its own workspace's members", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      const inA = await harness.transactions.runForWorkspace(WS_A, uow => uow.memberships.list());
      expect(inA).toHaveLength(1);
      expect(inA[0]?.memberId).toBe(MEM_A);
    });

    it("counts owners within its own workspace only", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      const owners = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.countOwners());
      expect(owners).toBe(1);
    });

    it("REJECTS inserting a record belonging to another workspace", async () => {
      // The mistake this catches: building a record for B and writing it while
      // scoped to A. The workspace is never rewritten to match.
      await expect(
        harness.transactions.runForWorkspace(WS_A, uow =>
          uow.workspaces.insert({
            workspaceId: WS_B, name: "Wrong", ownerUserId: USER_A, createdAt: AT,
          })),
      ).rejects.toThrow();
    });

    it("REJECTS inserting a membership belonging to another workspace", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await expect(
        harness.transactions.runForWorkspace(WS_A, uow =>
          uow.memberships.insert({
            memberId: "mem_wrong" as WorkspaceMemberId, workspaceId: WS_B,
            userId: USER_A, role: "sender", createdAt: AT,
          })),
      ).rejects.toThrow();
    });

    it("applies a conditional role change when the role still matches", async () => {
      await seed(WS_A, MEM_A, USER_A);
      const applied = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: MEM_A, expectedRole: "owner", nextRole: "administrator",
        }));
      expect(applied).toBe(true);

      const after = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.findMember(MEM_A));
      expect(after?.role).toBe("administrator");
    });

    it("refuses a conditional change when the role has moved on", async () => {
      // The concurrency case: a second writer expecting the old value must not
      // overwrite the first writer's change.
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: MEM_A, expectedRole: "owner", nextRole: "administrator",
        }));

      const second = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: MEM_A, expectedRole: "owner", nextRole: "auditor",
        }));
      expect(second).toBe(false);

      const after = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.findMember(MEM_A));
      expect(after?.role).toBe("administrator");
    });

    it("CANNOT conditionally change another workspace's member", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      const applied = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: MEM_B, expectedRole: "owner", nextRole: "auditor",
        }));
      // False, not an error — indistinguishable from "already changed".
      expect(applied).toBe(false);

      const untouched = await harness.transactions.runForWorkspace(WS_B, uow =>
        uow.memberships.findMember(MEM_B));
      expect(untouched?.role).toBe("owner");
    });

    it("discards every write when the transaction fails", async () => {
      await expect(
        harness.transactions.runForWorkspace(WS_A, async uow => {
          await uow.workspaces.insert({
            workspaceId: WS_A, name: "Doomed", ownerUserId: USER_A, createdAt: AT,
          });
          await uow.memberships.insert({
            memberId: MEM_A, workspaceId: WS_A, userId: USER_A, role: "owner", createdAt: AT,
          });
          throw new Error("deliberate failure after both writes");
        }),
      ).rejects.toThrow();

      const survivors = await harness.transactions.runForWorkspace(WS_A, async uow => ({
        workspace: await uow.workspaces.find(),
        members: await uow.memberships.list(),
      }));
      expect(survivors.workspace).toBeNull();
      expect(survivors.members).toHaveLength(0);
    });

    it("sees its own uncommitted writes within the same transaction", async () => {
      const seen = await harness.transactions.runForWorkspace(WS_A, async uow => {
        await uow.workspaces.insert({
          workspaceId: WS_A, name: "Acme", ownerUserId: USER_A, createdAt: AT,
        });
        return uow.workspaces.find();
      });
      expect(seen?.name).toBe("Acme");
    });
    // ── Evidence ───────────────────────────────────────────────────────────
    //
    // Behaviour the fake and PostgreSQL must agree on. Ordering is the case that
    // matters: the adapter orders in SQL and the fake in JavaScript, so they are
    // two independent implementations of one rule and nothing but this suite
    // would notice them diverging.

    it("appends evidence and reads it back in the bound workspace", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.evidence.append({
          evidenceEventId: "ev_1" as EvidenceEventId,
          signingRequestId: REQ,
          eventType: "transaction-created",
          actor: { type: "workspace-user", actorId: USER_A },
          occurredAt: AT,
        }));

      const events = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.evidence.listForSigningRequest(REQ));

      expect(events.length).toBe(1);
      expect(events[0]?.workspaceId).toBe(WS_A);
    });

    it("returns an empty timeline for a signing request with no evidence", async () => {
      await seed(WS_A, MEM_A, USER_A);
      const events = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.evidence.listForSigningRequest("txn_absent" as TransactionId));
      expect(events.length).toBe(0);
    });

    it("breaks timestamp ties by event id, identically in both implementations", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_A, async uow => {
        for (const id of ["ev_c", "ev_a", "ev_b"]) {
          await uow.evidence.append({
            evidenceEventId: id as EvidenceEventId,
            signingRequestId: REQ,
            eventType: "document-viewed",
            actor: { type: "system" },
            occurredAt: AT,
          });
        }
      });

      const ids = (await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.evidence.listForSigningRequest(REQ))).map(e => e.evidenceEventId);

      expect(ids.join(",")).toBe("ev_a,ev_b,ev_c");
    });

    it("does not leak evidence across workspaces", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);
      await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.evidence.append({
          evidenceEventId: "ev_1" as EvidenceEventId,
          signingRequestId: REQ,
          eventType: "transaction-created",
          actor: { type: "system" },
          occurredAt: AT,
        }));

      const fromB = await harness.transactions.runForWorkspace(WS_B, uow =>
        uow.evidence.listForSigningRequest(REQ));

      expect(fromB.length).toBe(0);
    });

    it("exposes no mutation methods on the evidence repository", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_A, uow => {
        const names = Object.keys(uow.evidence).sort().join(",");
        expect(names).toBe("append,listForSigningRequest");
        return Promise.resolve();
      });
    });

    it("round-trips an artifact digest and size", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.artifacts.insert({
          artifactId: "art_1" as ArtifactId,
          workspaceId: WS_A,
          documentId: DOC,
          artifactType: "original",
          storageReference: "lagda://foundation/art_1",
          mediaType: "application/pdf",
          sizeBytes: 2048,
          digestAlgorithm: "sha-256",
          digest: DIGEST,
          createdAt: AT,
        }));

      const found = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.artifacts.find("art_1" as ArtifactId));

      expect(found?.digest).toBe(DIGEST);
      expect(found?.sizeBytes).toBe(2048);
    });

  });
}
