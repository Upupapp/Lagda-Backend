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

import { toStorageObjectKey } from "../common/ports/storage.js";
import { toSha256Digest, type UserId, type WorkspaceId, type WorkspaceMemberId,
  type TransactionId, type DocumentId } from "@lagda/contracts";
import type { TransactionManager, EvidenceEventId, ArtifactId } from "../common/ports/index.js";

export interface ContractHarness {
  readonly transactions: TransactionManager;
  /** Clears all state between cases. */
  reset(): Promise<void>;
  /**
   * Ensures an account exists for `userId`.
   *
   * Required by the PostgreSQL adapter since migration 013 gave
   * `workspace_memberships.user_id` a foreign key. A no-op for the in-memory
   * fake, which models repositories rather than the database's referential
   * integrity.
   */
  seedUser(userId: UserId): Promise<void>;
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

/** Per-workspace, because `document_id` is globally unique. */
const documentFor = (workspaceId: WorkspaceId): DocumentId =>
  `${DOC}_${workspaceId}` as DocumentId;
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

    // Every membership references a real account since migration 013. The
    // harness creates one where the adapter needs it and no-ops for the fake,
    // which has no accounts table — the contract describes repository
    // behaviour, not the referential integrity only PostgreSQL can enforce.
    const seed = async (workspaceId: WorkspaceId, memberId: WorkspaceMemberId, userId: UserId) => {
      await harness.seedUser(userId);
      return harness.transactions.runForWorkspace(workspaceId, async uow => {
        await uow.workspaces.insert({
          workspaceId, name: `Workspace ${workspaceId}`, createdAt: AT,
        });
        await uow.memberships.insert({
          memberId, workspaceId, userId, role: "owner", createdAt: AT,
        });
        // The document every artifact assertion below hangs off.
        //
        // Required since BACKEND-29: `document_artifacts.document_id` is now a
        // compound foreign key to `documents`, so an artifact can no longer
        // name a document that does not exist. Before migration 016 that
        // column pointed at nothing and these fixtures were silently writing
        // dangling references.
        //
        // The id is DERIVED FROM THE WORKSPACE because `document_id` is the
        // primary key of `documents` and is therefore globally unique — a
        // fixture that seeded the same id into two workspaces would collide.
        await uow.documents.insert({
          documentId: documentFor(workspaceId), workspaceId,
          title: "Contract fixture",
          originalFilename: null, createdByUserId: userId, createdAt: AT,
        });
      });
    };

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
            workspaceId: WS_B, name: "Wrong", createdAt: AT,
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
            workspaceId: WS_A, name: "Doomed", createdAt: AT,
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
          workspaceId: WS_A, name: "Acme", createdAt: AT,
        });
        return uow.workspaces.find();
      });
      expect(seen?.name).toBe("Acme");
    });

    // ── Workspace metadata (BACKEND-25) ────────────────────────────────────

    it("renames the bound workspace and leaves its identity alone", async () => {
      await seed(WS_A, MEM_A, USER_A);

      const applied = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.workspaces.updateName("Renamed"));
      expect(applied).toBe(true);

      const after = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.workspaces.find());
      expect(after?.name).toBe("Renamed");
      // The tenant identity and the creation time are untouched. A rename must
      // not produce a new tenant, and must not rewrite history.
      expect(after?.workspaceId).toBe(WS_A);
      expect(after?.createdAt).toBe(AT);
    });

    it("reports false when renaming a workspace that does not exist", async () => {
      const applied = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.workspaces.updateName("Nothing"));
      expect(applied).toBe(false);
    });

    it("cannot rename another workspace from this one's scope", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      // Scoped to B, the update touches B — there is no parameter that could
      // aim it at A, which is the property the scoped repository exists for.
      await harness.transactions.runForWorkspace(WS_B, uow =>
        uow.workspaces.updateName("B renamed"));

      const a = await harness.transactions.runForWorkspace(WS_A, uow =>
        uow.workspaces.find());
      expect(a?.name).toBe(`Workspace ${WS_A}`);
    });

    // ── User-scoped membership reads (BACKEND-25) ──────────────────────────

    it("lists only the caller's own workspaces", async () => {
      await seed(WS_A, MEM_A, USER_A);
      await seed(WS_B, MEM_B, USER_B);

      const mine = await harness.transactions.runForUser(USER_A, uow =>
        uow.memberships.listWorkspaces());

      expect(mine).toHaveLength(1);
      expect(mine[0]?.workspaceId).toBe(WS_A);
      expect(mine[0]?.role).toBe("owner");
      expect(mine[0]?.membershipId).toBe(MEM_A);
    });

    it("returns an empty list for a user with no memberships", async () => {
      await seed(WS_A, MEM_A, USER_A);
      const none = await harness.transactions.runForUser(USER_B, uow =>
        uow.memberships.listWorkspaces());
      expect(none).toHaveLength(0);
    });

    it("lists every workspace one user belongs to", async () => {
      // The multi-tenancy property: one global account, several independent
      // memberships. `USER_A` is deliberately a member of both.
      await seed(WS_A, MEM_A, USER_A);
      await harness.transactions.runForWorkspace(WS_B, async uow => {
        await uow.workspaces.insert({
          workspaceId: WS_B, name: `Workspace ${WS_B}`, createdAt: AT,
        });
        await uow.memberships.insert({
          memberId: MEM_B, workspaceId: WS_B, userId: USER_A,
          role: "owner", createdAt: AT + 1000,
        });
      });

      const mine = await harness.transactions.runForUser(USER_A, uow =>
        uow.memberships.listWorkspaces());

      expect(mine).toHaveLength(2);
      // Newest membership first, and both adapters must agree — the SQL orders
      // in the database and the fake orders in JavaScript.
      expect(mine[0]?.workspaceId).toBe(WS_B);
      expect(mine[1]?.workspaceId).toBe(WS_A);
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
          eventVersion: 1,
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
            eventVersion: 1,
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
          eventVersion: 1,
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
          documentId: documentFor(WS_A),
          artifactType: "original",
          storageReference: toStorageObjectKey("workspaces/ws_a/documents/doc_1/artifacts/art_1.pdf"),
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
