// `artifact_type` — proved by INSERTING, not by reading a constraint.
//
// ── The defect this exists to catch, and why the existing guard missed it ──
//
// Migration 003 created `document_artifacts` with an inline CHECK named
// `document_artifacts_type_check` admitting three kinds. Migration 026
// widened the vocabulary to four (`merged-candidate`) with a drop-then-add
// pair — but dropped `document_artifacts_artifact_type_check`, a name that
// had never existed. `if exists` made that a silent no-op, so 026 added a
// second, wider CHECK BESIDE 003's narrower one instead of replacing it.
//
// A row must satisfy EVERY check constraint on its table, so the surviving
// three-kind CHECK rejected every `merged-candidate` insert — the only
// artifact the `field-merge` completion step writes. No signing request
// could complete. Confirmed against production: both constraints present,
// and the one run that reached the merge step parked in `waiting-retry`.
//
// `completion-vocabulary.integration.test.ts` already had a guard for this
// very value:
//
//     it("admits the merged-candidate artifact kind", async () => {
//       const definitions = await checkDefinitions("document_artifacts");
//       expect(definitions).toContain("'merged-candidate'");
//     });
//
// It passed throughout. `checkDefinitions` CONCATENATES every CHECK on the
// table, so "the text appears somewhere" was true — 026's constraint did
// mention the value. What the assertion could not see is that a SECOND
// constraint forbade it. Text-matching a schema answers "is this kind
// spelled anywhere", and the question that matters is "will the database
// accept this row".
//
// So this suite asks the database the real question: it inserts one row per
// application `ARTIFACT_TYPES` member and requires every one to land, and
// inserts a kind outside the vocabulary and requires it to be refused. That
// is true regardless of how many constraints exist, what they are named, or
// which migration wrote them — none of which a future drift can hide behind.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import { ARTIFACT_TYPES } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawTenantTransaction,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-18T07:00:00.000Z");
const USER = "usr_artifact_vocab" as UserId;
const WS = "ws_artifact_vocab" as WorkspaceId;
const DOC = "doc_artifact_vocab" as DocumentId;
const DIGEST = "c".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

/** PostgreSQL's class for a violated CHECK constraint. */
const CHECK_VIOLATION = "23514";

function sqlstateOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

suite("document_artifacts artifact_type vocabulary", () => {
  let owner: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
  });

  afterAll(async () => {
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "Artifact Vocab", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_av" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Vocabulary probe",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
    });
  });

  /**
   * Inserts one artifact of the given kind, in the tenant context.
   *
   * Written with raw SQL rather than through the artifact repository on
   * purpose: the repository's parameter type is `ArtifactType`, so the
   * invalid-kind case below could not be expressed through it at all — and
   * that type is exactly one half of the pair this suite is comparing.
   * Going around it is what makes the database the arbiter.
   */
  async function insertArtifact(artifactType: string): Promise<void> {
    await withRawTenantTransaction(owner, WS, async trx => {
      await sql`
        insert into document_artifacts (
          artifact_id, workspace_id, document_id, artifact_type,
          storage_reference, media_type, size_bytes,
          digest_algorithm, digest, created_at, page_count, rotated_page_count
        ) values (
          ${`art_${artifactType}`}, ${WS}, ${DOC}, ${artifactType},
          ${`workspaces/${WS}/documents/${DOC}/artifacts/probe`},
          'application/pdf', 1024, 'sha-256', ${DIGEST}, ${new Date(AT)}, 1, 0
        )
      `.execute(trx);
    });
  }

  // One case per member, generated from the constant — so adding a kind to
  // `ARTIFACT_TYPES` without a migration produces a NEW FAILING TEST rather
  // than a silently unexercised value.
  for (const artifactType of ARTIFACT_TYPES) {
    it(`accepts a real ${artifactType} artifact`, async () => {
      await expect(insertArtifact(artifactType)).resolves.toBeUndefined();

      const found = await withRawTenantTransaction(owner, WS, trx =>
        sql<{ artifact_type: string }>`
          select artifact_type from document_artifacts
           where artifact_id = ${`art_${artifactType}`}
        `.execute(trx));
      expect(found.rows[0]?.artifact_type).toBe(artifactType);
    });
  }

  it("REFUSES a kind outside the vocabulary — the negative control", async () => {
    // Without this, every assertion above would pass just as happily against
    // a table carrying no CHECK at all.
    let sqlstate: string | undefined;
    try {
      await insertArtifact("prepared");
      // `prepared` is deliberately chosen: ports/evidence.ts documents it as
      // a name `merged-candidate` must NOT be confused with, so it is the
      // kind a future reader is most likely to reintroduce by mistake.
      expect.unreachable("the database accepted an artifact kind outside ARTIFACT_TYPES");
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate).toBe(CHECK_VIOLATION);
  });

  it("carries exactly ONE artifact_type CHECK, so no stale one can shadow it", async () => {
    // The structural companion to the behavioural cases above. They prove the
    // table accepts the right kinds TODAY; this pins the shape of the schema
    // that makes that true, and names the failure directly if a second
    // constraint ever reappears — which is the precise form the original
    // defect took, and the form a concatenating text check cannot report.
    const constraints = await sql<{ conname: string; definition: string }>`
      select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'document_artifacts'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%artifact_type%'
    `.execute(owner.db);

    expect(constraints.rows.map(row => row.conname)).toEqual([
      "document_artifacts_artifact_type_check",
    ]);
  });
});
