// Evidence, artifact and finalization persistence, against REAL PostgreSQL.
//
// Every claim BACKEND-10 makes about immutability, tenancy and constraints is a
// claim about the DATABASE, and only the database can be asked. A fake cannot
// refuse an UPDATE it was never granted.

import { toStorageObjectKey } from "@lagda/application";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  WorkspaceId, DocumentId, TransactionId, VerificationId, Sha256Digest,
} from "@lagda/contracts";
import type {
  ArtifactId, ArtifactRecord, EvidenceEventId, EvidenceEventInput,
  SealId, SealRecord, VerificationRecord, RecipientId,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createPublicVerificationLookup } from "./repositories/evidence.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, withRawTenantTransaction,
} from "./testing/harness.js";

const WS_A = "ws_evidence_a" as WorkspaceId;
const WS_B = "ws_evidence_b" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
/**
 * Workspace B's own document.
 *
 * `document_id` is the PRIMARY KEY of `documents`, so it is globally unique and
 * `doc_1` cannot exist in both workspaces. Since BACKEND-29 an artifact must
 * name a document in ITS OWN workspace, so the cross-tenant assertions below
 * need a real B-side document to hang a B-side artifact off.
 */
const DOC_B = "doc_b1" as DocumentId;

/** The document a workspace's fixture artifacts belong to. */
const documentFor = (workspaceId: WorkspaceId): DocumentId =>
  workspaceId === WS_B ? DOC_B : DOC;
const REQ = "txn_1" as TransactionId;
const HASH_A = "a".repeat(64) as Sha256Digest;
const HASH_B = "b".repeat(64) as Sha256Digest;

const artifact = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  artifactId: "art_original" as ArtifactId,
  workspaceId: WS_A,
  // Derived from the workspace, so `artifact({ workspaceId: WS_B })` names B's
  // document rather than A's. An explicit `documentId` in `over` still wins.
  documentId: documentFor(over.workspaceId ?? WS_A),
  artifactType: "original",
  storageReference: toStorageObjectKey("workspaces/ws_a/documents/doc_1/artifacts/art_original.pdf"),
  mediaType: "application/pdf",
  sizeBytes: 12_345,
  digestAlgorithm: "sha-256",
  digest: HASH_A,
  createdAt: 0,
  ...over,
});

const event = (over: Partial<EvidenceEventInput> = {}): EvidenceEventInput => ({
  evidenceEventId: "ev_1" as EvidenceEventId,
  signingRequestId: REQ,
  eventType: "transaction-created",
  actor: { type: "workspace-user", actorId: "usr_1" },
  occurredAt: Date.parse("2026-08-09T10:00:00Z"),
  ...over,
});

const seal = (over: Partial<SealRecord> = {}): SealRecord => ({
  sealId: "seal_1" as SealId,
  workspaceId: WS_A,
  signingRequestId: REQ,
  sealedArtifactId: "art_sealed" as ArtifactId,
  sealScheme: "hash-evidence",
  sealVersion: 1,
  digestAlgorithm: "sha-256",
  originalDocumentHash: HASH_A,
  signedDocumentHash: HASH_B,
  sealedAt: Date.parse("2026-08-09T12:00:00Z"),
  ...over,
});

const verification = (over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  verificationId: "LAGDA-WSA-20260809-7F3A2C" as VerificationId,
  workspaceId: WS_A,
  signingRequestId: REQ,
  documentId: DOC,
  sealId: "seal_1" as SealId,
  completedAt: Date.parse("2026-08-09T12:00:00Z"),
  participantCount: 2,
  ...over,
});

describe.skipIf(!hasIntegrationDatabase())("evidence persistence on PostgreSQL", () => {
  let database: LagdaDatabase;
  let transactions: ReturnType<typeof createTransactionManager>;

  beforeAll(async () => {
    database = await createTestDatabase();
    transactions = createTransactionManager(database.db);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await truncateAll(database);
    for (const id of [WS_A, WS_B]) {
      await transactions.runForWorkspace(id, async (uow) => {
        await uow.workspaces.insert({ workspaceId: id, name: id, createdAt: 0 });
        // Documents, required since BACKEND-29 added the compound foreign key
        // from `document_artifacts` to `documents`. `doc_2` exists because the
        // provenance and ordering assertions use a second document.
        const documents = id === WS_B ? [DOC_B] : [DOC, "doc_2" as DocumentId];
        for (const documentId of documents) {
          await uow.documents.insert({
            documentId, workspaceId: id, title: documentId,
            originalFilename: null,
            createdByUserId: "usr_evidence_fixture" as never,
            createdAt: 0,
          });
        }
      });
    }
  });

  // ── Append and read ────────────────────────────────────────────────────────

  it("appends an event and reads it back", async () => {
    await transactions.runForWorkspace(WS_A, (uow) => uow.evidence.append(event()));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.evidenceEventId).toBe("ev_1");
    expect(found?.workspaceId).toBe(WS_A);
    expect(found?.eventType).toBe("transaction-created");
    expect(found?.actor).toEqual({ type: "workspace-user", actorId: "usr_1" });
  });

  it("returns an empty list for a signing request with no events", async () => {
    const events = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest("txn_absent" as TransactionId));
    expect(events).toEqual([]);
  });

  it("stamps recorded_at at the database, distinct from occurred_at", async () => {
    // occurred_at is a business fact from the application Clock; recorded_at is
    // when the row landed. Here occurred_at is deliberately in the past, so a
    // repository that conflated them would return the same value twice.
    const past = Date.parse("2020-01-01T00:00:00Z");
    await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.append(event({ occurredAt: past })));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.occurredAt).toBe(past);
    expect(found?.recordedAt).toBeGreaterThan(past);
  });

  it("orders deterministically when two events share a timestamp", async () => {
    // The case timestamp-only ordering gets wrong. Two recipients acting in the
    // same millisecond is not exotic — it is what a parallel signing flow does.
    const at = Date.parse("2026-08-09T10:00:00Z");
    await transactions.runForWorkspace(WS_A, async (uow) => {
      await uow.evidence.append(event({ evidenceEventId: "ev_c" as EvidenceEventId, occurredAt: at }));
      await uow.evidence.append(event({ evidenceEventId: "ev_a" as EvidenceEventId, occurredAt: at }));
      await uow.evidence.append(event({ evidenceEventId: "ev_b" as EvidenceEventId, occurredAt: at }));
    });

    const ids = (await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ))).map((e) => e.evidenceEventId);

    expect(ids).toEqual(["ev_a", "ev_b", "ev_c"]);
  });

  it("orders by occurrence before identity", async () => {
    await transactions.runForWorkspace(WS_A, async (uow) => {
      await uow.evidence.append(event({
        evidenceEventId: "ev_a" as EvidenceEventId,
        occurredAt: Date.parse("2026-08-09T12:00:00Z"),
      }));
      await uow.evidence.append(event({
        evidenceEventId: "ev_z" as EvidenceEventId,
        occurredAt: Date.parse("2026-08-09T10:00:00Z"),
      }));
    });

    const ids = (await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ))).map((e) => e.evidenceEventId);

    expect(ids).toEqual(["ev_z", "ev_a"]);
  });

  it("records a system actor with no actor id", async () => {
    await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.append(event({
        evidenceEventId: "ev_sys" as EvidenceEventId,
        eventType: "transaction-expired",
        actor: { type: "system" },
      })));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.actor).toEqual({ type: "system" });
  });

  it("records a recipient actor, which is not a workspace user", async () => {
    await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.append(event({
        eventType: "document-viewed",
        actor: { type: "recipient", actorId: "rcp_1" as RecipientId },
        recipientId: "rcp_1" as RecipientId,
      })));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.actor).toEqual({ type: "recipient", actorId: "rcp_1" });
  });

  it("round-trips observed request context and versioned details", async () => {
    await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.append(event({
        eventType: "consent-accepted",
        observed: { clientIp: "203.0.113.42", clientUserAgent: "Mozilla/5.0 (probe)" },
        details: { version: 1, payload: { consentVersion: "2026-01", accepted: true } },
      })));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.observed?.clientIp).toBe("203.0.113.42");
    expect(found?.observed?.clientUserAgent).toBe("Mozilla/5.0 (probe)");
    expect(found?.details).toEqual({
      version: 1, payload: { consentVersion: "2026-01", accepted: true },
    });
  });

  it("omits observed context entirely for a system event", async () => {
    // A worker has no client. Forcing a placeholder IP would be inventing
    // evidence, so the field is absent rather than falsified.
    await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.append(event({ actor: { type: "system" }, eventType: "transaction-expired" })));

    const [found] = await transactions.runForWorkspace(WS_A, (uow) =>
      uow.evidence.listForSigningRequest(REQ));

    expect(found?.observed).toBeUndefined();
  });

  // ── Immutability ───────────────────────────────────────────────────────────

  describe("append-only enforcement", () => {
    it("grants the runtime role INSERT and SELECT only", async () => {
      const { rows } = await sql<{ table_name: string; privilege_type: string }>`
        select table_name, privilege_type
        from information_schema.table_privileges
        where grantee = 'lagda_app'
          and table_name in ('evidence_events','document_artifacts',
                             'document_seals','verification_records')
        order by table_name, privilege_type
      `.execute(database.db);

      const byTable = new Map<string, string[]>();
      for (const row of rows) {
        byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type]);
      }

      for (const table of ["evidence_events", "document_artifacts",
                           "document_seals", "verification_records"]) {
        expect(byTable.get(table)?.sort()).toEqual(["INSERT", "SELECT"]);
      }
    });

    it("denies UPDATE on evidence to the runtime role", async () => {
      // Asked of PostgreSQL directly rather than asserted from the grant list:
      // a privilege inherited from PUBLIC or a role membership would not appear
      // above and would still permit the write.
      const { rows } = await sql<{ allowed: boolean }>`
        select has_table_privilege('lagda_app', 'evidence_events', 'UPDATE') as allowed
      `.execute(database.db);
      expect(rows[0]?.allowed).toBe(false);
    });

    it("denies DELETE on evidence to the runtime role", async () => {
      const { rows } = await sql<{ allowed: boolean }>`
        select has_table_privilege('lagda_app', 'evidence_events', 'DELETE') as allowed
      `.execute(database.db);
      expect(rows[0]?.allowed).toBe(false);
    });

    it("still permits UPDATE on ordinary tables — the negative control", async () => {
      // Without this, the two checks above would pass just as happily if the
      // role had no privileges at all, or did not exist.
      const { rows } = await sql<{ allowed: boolean }>`
        select has_table_privilege('lagda_app', 'workspaces', 'UPDATE') as allowed
      `.execute(database.db);
      expect(rows[0]?.allowed).toBe(true);
    });

    it("exposes no update or delete method on the repository", async () => {
      await transactions.runForWorkspace(WS_A, (uow) => {
        const methods = Object.keys(uow.evidence);
        expect(methods.sort()).toEqual(["append", "listForSigningRequest"]);
        return Promise.resolve();
      });
    });
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("does not let workspace B read workspace A evidence", async () => {
      await transactions.runForWorkspace(WS_A, (uow) => uow.evidence.append(event()));

      const fromB = await transactions.runForWorkspace(WS_B, (uow) =>
        uow.evidence.listForSigningRequest(REQ));

      expect(fromB).toEqual([]);
    });

    it("rejects an artifact claiming another workspace", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({ workspaceId: WS_B }))),
      ).rejects.toThrow(/workspace/i);
    });

    it("rejects a seal claiming another workspace", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal({ workspaceId: WS_B }), verification: verification(),
          })),
      ).rejects.toThrow(/workspace/i);
    });

    it("rejects a verification record claiming another workspace", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal(), verification: verification({ workspaceId: WS_B }),
          })),
      ).rejects.toThrow(/workspace/i);
    });

    it("prevents a seal in one workspace referencing another workspace's artifact", async () => {
      // The database rejects this, not the application. The compound foreign
      // key (workspace_id, sealed_artifact_id) has no matching row in A even
      // though the artifact ID exists in B.
      await transactions.runForWorkspace(WS_B, (uow) =>
        uow.artifacts.insert(artifact({
          workspaceId: WS_B, artifactId: "art_sealed" as ArtifactId, artifactType: "sealed",
        })));

      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({ seal: seal(), verification: verification() })),
      ).rejects.toBeDefined();
    });

    it("prevents artifact provenance crossing workspaces", async () => {
      await transactions.runForWorkspace(WS_B, (uow) =>
        uow.artifacts.insert(artifact({ workspaceId: WS_B })));

      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({
            artifactId: "art_sealed" as ArtifactId,
            artifactType: "sealed",
            sourceArtifactId: "art_original" as ArtifactId,
          }))),
      ).rejects.toBeDefined();
    });
  });

  // ── Artifacts ──────────────────────────────────────────────────────────────

  describe("artifacts", () => {
    it("round-trips an artifact including its digest and size", async () => {
      await transactions.runForWorkspace(WS_A, (uow) => uow.artifacts.insert(artifact()));

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.artifacts.find("art_original" as ArtifactId));

      expect(found?.digest).toBe(HASH_A);
      expect(found?.digestAlgorithm).toBe("sha-256");
      // `bigint` arrives from the driver as a string. If the boundary forgot to
      // parse it, this would be "12345" and every arithmetic use would be wrong.
      expect(found?.sizeBytes).toBe(12_345);
      expect(typeof found?.sizeBytes).toBe("number");
    });

    it("records provenance as a relation", async () => {
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.artifacts.insert(artifact());
        await uow.artifacts.insert(artifact({
          artifactId: "art_sealed" as ArtifactId,
          artifactType: "sealed",
          digest: HASH_B,
          sourceArtifactId: "art_original" as ArtifactId,
        }));
      });

      const sealed = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.artifacts.find("art_sealed" as ArtifactId));

      expect(sealed?.sourceArtifactId).toBe("art_original");
    });

    it("refuses an artifact derived from itself", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({ sourceArtifactId: "art_original" as ArtifactId }))),
      ).rejects.toBeDefined();
    });

    it("permits two artifacts with the same digest", async () => {
      // Two identical PDFs legitimately share a SHA-256. A UNIQUE(digest) would
      // reject the second workspace to upload the same standard contract form.
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.artifacts.insert(artifact());
        await uow.artifacts.insert(artifact({
          artifactId: "art_copy" as ArtifactId,
          documentId: "doc_2" as DocumentId,
        }));
      });

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.artifacts.find("art_copy" as ArtifactId));
      expect(found?.digest).toBe(HASH_A);
    });

    it("rejects a malformed digest", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({ digest: "not-a-digest" as Sha256Digest }))),
      ).rejects.toBeDefined();
    });

    it("rejects an uppercase digest, which would break verification comparison", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({ digest: "A".repeat(64) as Sha256Digest }))),
      ).rejects.toBeDefined();
    });

    it("rejects an unknown artifact type", async () => {
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.artifacts.insert(artifact({
            artifactType: "prepared" as ArtifactRecord["artifactType"],
          }))),
      ).rejects.toBeDefined();
    });

    it("lists a document's artifacts in a stable order", async () => {
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.artifacts.insert(artifact());
        await uow.artifacts.insert(artifact({
          artifactId: "art_sealed" as ArtifactId, artifactType: "sealed", digest: HASH_B,
        }));
      });

      const all = await transactions.runForWorkspace(WS_A, (uow) => uow.artifacts.listForDocument(DOC));
      expect(all.map((a) => a.artifactId)).toEqual(["art_original", "art_sealed"]);
    });
  });

  // ── Finalization ───────────────────────────────────────────────────────────

  describe("finalization", () => {
    async function insertArtifacts(): Promise<void> {
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.artifacts.insert(artifact());
        await uow.artifacts.insert(artifact({
          artifactId: "art_sealed" as ArtifactId, artifactType: "sealed", digest: HASH_B,
          sourceArtifactId: "art_original" as ArtifactId,
        }));
      });
    }

    it("writes the seal and its verification record together", async () => {
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.recordFinalization({ seal: seal(), verification: verification() }));

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.findBySigningRequest(REQ));

      expect(found?.sealScheme).toBe("hash-evidence");
      expect(found?.sealVersion).toBe(1);
      expect(found?.digestAlgorithm).toBe("sha-256");
      expect(found?.originalDocumentHash).toBe(HASH_A);
      expect(found?.signedDocumentHash).toBe(HASH_B);
    });

    it("refuses a second finalization of the same signing request", async () => {
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.recordFinalization({ seal: seal(), verification: verification() }));

      // Resealing is not a product feature. A completion retry must converge on
      // the existing row, not create a competing verification identity.
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal({ sealId: "seal_2" as SealId }),
            verification: verification({
              verificationId: "LAGDA-WSA-20260809-999999" as VerificationId,
              sealId: "seal_2" as SealId,
            }),
          })),
      ).rejects.toBeDefined();
    });

    it("refuses a duplicate seal at the DATABASE, independently of the verification record", async () => {
      // Written as raw SQL on purpose. Going through the repository inserts BOTH
      // rows, so the verification table's own uniqueness fires first and the
      // seal constraint is never reached — a probe proved the higher-level test
      // above passes with `document_seals_one_per_request` dropped entirely.
      //
      // Both constraints are wanted: the pair is written atomically today, but
      // relying on that means the seal table's integrity depends on a caller
      // continuing to write the verification row.
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.recordFinalization({ seal: seal(), verification: verification() }));

      await expect(
        withRawTenantTransaction(database, WS_A, (trx) =>
          trx.insertInto("document_seals").values({
            seal_id: "seal_dup", workspace_id: WS_A, signing_request_id: REQ,
            sealed_artifact_id: "art_sealed", certificate_artifact_id: null,
            seal_scheme: "hash-evidence", seal_version: 1, digest_algorithm: "sha-256",
            original_document_hash: HASH_A, signed_document_hash: HASH_B,
            sealed_at: new Date(0),
          }).execute()),
      ).rejects.toBeDefined();
    });

    it("refuses a duplicate verification record for one signing request", async () => {
      // The other half of the pair, isolated the same way.
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.recordFinalization({ seal: seal(), verification: verification() }));

      await expect(
        withRawTenantTransaction(database, WS_A, (trx) =>
          trx.insertInto("verification_records").values({
            verification_id: "LAGDA-WSA-20260809-ABCDEF", workspace_id: WS_A,
            signing_request_id: REQ, document_id: DOC, seal_id: "seal_1",
            completed_at: new Date(0), participant_count: 1,
          }).execute()),
      ).rejects.toBeDefined();
    });

    it("refuses a seal version of zero", async () => {
      await insertArtifacts();
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal({ sealVersion: 0 }), verification: verification(),
          })),
      ).rejects.toBeDefined();
    });

    it("accepts a future seal version, so the schema does not block migration", async () => {
      // The constraint is `> 0`, not `= 1`. Pinning it to the current version
      // would make introducing seal version 2 a schema change under load.
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.recordFinalization({
          seal: seal({ sealVersion: 7 }), verification: verification(),
        }));

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.findBySigningRequest(REQ));
      expect(found?.sealVersion).toBe(7);
    });

    it("refuses an unknown seal scheme", async () => {
      // An unrecognised scheme must not be silently stored and later read back
      // as though it were hash-evidence.
      await insertArtifacts();
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal({ sealScheme: "pades-b-lt" as SealRecord["sealScheme"] }),
            verification: verification(),
          })),
      ).rejects.toBeDefined();
    });

    it("refuses a verification ID that is not in the canonical format", async () => {
      await insertArtifacts();
      await expect(
        transactions.runForWorkspace(WS_A, (uow) =>
          uow.finalizations.recordFinalization({
            seal: seal(),
            verification: verification({ verificationId: "12345" as VerificationId }),
          })),
      ).rejects.toBeDefined();
    });

    it("rolls back BOTH rows when the transaction fails", async () => {
      await insertArtifacts();

      await expect(
        transactions.runForWorkspace(WS_A, async (uow) => {
          await uow.finalizations.recordFinalization({
            seal: seal(), verification: verification(),
          });
          await uow.evidence.append(event({ eventType: "document-sealed" }));
          throw new Error("completion failed after sealing");
        }),
      ).rejects.toThrow("completion failed after sealing");

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.findBySigningRequest(REQ));
      const events = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.evidence.listForSigningRequest(REQ));

      expect(found).toBeNull();
      expect(events).toEqual([]);
    });

    it("commits state and evidence together on success", async () => {
      await insertArtifacts();
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.finalizations.recordFinalization({ seal: seal(), verification: verification() });
        await uow.evidence.append(event({ eventType: "document-sealed" }));
      });

      const found = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.finalizations.findBySigningRequest(REQ));
      const events = await transactions.runForWorkspace(WS_A, (uow) =>
        uow.evidence.listForSigningRequest(REQ));

      expect(found).not.toBeNull();
      expect(events).toHaveLength(1);
    });
  });

  // ── Public verification lookup ─────────────────────────────────────────────

  describe("public verification lookup", () => {
    const lookup = () =>
      createPublicVerificationLookup((operation) => database.db.transaction().execute(operation));

    async function finalize(): Promise<void> {
      await transactions.runForWorkspace(WS_A, async (uow) => {
        await uow.artifacts.insert(artifact());
        await uow.artifacts.insert(artifact({
          artifactId: "art_sealed" as ArtifactId, artifactType: "sealed", digest: HASH_B,
        }));
        await uow.finalizations.recordFinalization({ seal: seal(), verification: verification() });
      });
    }

    it("resolves a verification ID with no workspace context", async () => {
      await finalize();
      const found = await lookup().findByVerificationId(
        "LAGDA-WSA-20260809-7F3A2C" as VerificationId);

      expect(found?.verificationId).toBe("LAGDA-WSA-20260809-7F3A2C");
      expect(found?.participantCount).toBe(2);
      expect(found?.signedDocumentHash).toBe(HASH_B);
      expect(found?.sealScheme).toBe("hash-evidence");
    });

    it("returns null for an unknown verification ID", async () => {
      await finalize();
      const found = await lookup().findByVerificationId(
        "LAGDA-WSA-20260809-000000" as VerificationId);
      expect(found).toBeNull();
    });

    it("exposes ONLY public-safe fields", async () => {
      // The allowlist, checked as an exact set. A later command adding a column
      // to verification_records must not widen what an anonymous caller sees,
      // and this fails if it does.
      await finalize();
      const found = await lookup().findByVerificationId(
        "LAGDA-WSA-20260809-7F3A2C" as VerificationId);

      expect(Object.keys(found ?? {}).sort()).toEqual([
        "completedAt", "digestAlgorithm", "originalDocumentHash", "participantCount",
        "sealScheme", "sealVersion", "signedDocumentHash", "verificationId",
      ]);
    });

    it("leaks no workspace, document, signing request or storage identity", async () => {
      await finalize();
      const found = await lookup().findByVerificationId(
        "LAGDA-WSA-20260809-7F3A2C" as VerificationId);

      const serialized = JSON.stringify(found);
      // The storage key is included deliberately: it is INTERNAL infrastructure
      // identity and must never reach a public projection (INV-207). The old
      // placeholder scheme this line used to guard no longer exists anywhere,
      // which made the assertion trivially true.
      for (const secret of [
        WS_A, DOC, REQ, "seal_1", "art_sealed",
        "workspaces/", "artifacts/", ".pdf",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });
  });
});
