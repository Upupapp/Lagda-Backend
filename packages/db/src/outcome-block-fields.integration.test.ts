// 081, against the LIVE schema: every table that closes `field_type` over the
// vocabulary now admits `review-block` and `approval-block`, a row of each is
// storable, and the down migration refuses — deliberately — while one exists,
// then round-trips cleanly once none does.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql, type Kysely } from "kysely";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { PREPARATION_FIELD_TYPES } from "@lagda/contracts";
import type { ArtifactId, PreparationId } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, hasIntegrationDatabase, seedUser, truncateAll,
} from "./testing/harness.js";
import * as m081 from "./migrations/081_outcome_block_fields.js";

const suite = hasIntegrationDatabase() ? describe : describe.skip;

const AT = Date.parse("2026-09-26T07:00:00.000Z");
const USER = "usr_outcome" as UserId;
const WS = "ws_outcome" as WorkspaceId;
const DOC = "doc_outcome" as DocumentId;
const ART = "art_outcome" as ArtifactId;
const PREP = "prep_outcome";

const CONSTRAINTS = [
  "preparation_fields_type_check",
  "signing_request_fields_type_check",
  "workflow_template_fields_type_check",
];

suite("outcome-block field types (081)", () => {
  let db: LagdaDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedUser(db, USER);
    await createTransactionManager(db.db).runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "Outcome", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_outcome" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: ART, workspaceId: WS, documentId: DOC, artifactType: "original",
        storageReference: `${WS}/${DOC}/${ART}` as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "d".repeat(64) as never,
        pageCount: 1, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: PREP as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: ART, createdAt: AT,
      });
    });
  });

  const definition = async (executor: Kysely<unknown>, name: string): Promise<string> => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}
    `.execute(executor);
    expect(rows).toHaveLength(1);
    return rows[0]!.def;
  };

  const insertField = (fieldId: string, type: string) =>
    db.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS}, true)`.execute(trx);
      await sql`
        insert into preparation_fields (field_id, workspace_id, preparation_id,
          field_type, page_number, x, y, width, height, required, label, layer)
        values (${fieldId}, ${WS}, ${PREP}, ${type}, 1, 0.1, 0.1, 0.3, 0.08, true, 'x', 0)
      `.execute(trx);
    });

  it.each(CONSTRAINTS)("%s admits exactly the contract's field types", async name => {
    const def = await definition(db.db as Kysely<unknown>, name);
    for (const type of PREPARATION_FIELD_TYPES) expect(def).toContain(`'${type}'`);
    expect(def).toContain("'review-block'");
    expect(def).toContain("'approval-block'");
    expect(def).not.toContain("'radio-group'");
  });

  it("stores a field of each new type, and still refuses an unknown one", async () => {
    await expect(insertField("pf_review", "review-block")).resolves.toBeUndefined();
    await expect(insertField("pf_approval", "approval-block")).resolves.toBeUndefined();
    await expect(insertField("pf_bogus", "notary-block")).rejects.toThrow(/check constraint/i);
  });

  it("refuses the down migration while a review block exists", async () => {
    await insertField("pf_review", "review-block");
    await expect(db.db.transaction().execute(trx => m081.down(trx as unknown as Kysely<unknown>)))
      .rejects.toThrow(/check constraint|violated/i);
    // Still widened: the failed down rolled back whole.
    expect(await definition(db.db as Kysely<unknown>, "preparation_fields_type_check"))
      .toContain("'review-block'");
  });

  it("round-trips down and up once no such field exists", async () => {
    await db.db.transaction().execute(async trx => {
      const executor = trx as unknown as Kysely<unknown>;
      await m081.down(executor);
      for (const name of CONSTRAINTS) {
        const def = await definition(executor, name);
        expect(def).not.toContain("'review-block'");
        expect(def).not.toContain("'approval-block'");
        expect(def).toContain("'signature-block'");
      }
      await m081.up(executor);
      for (const name of CONSTRAINTS) {
        const def = await definition(executor, name);
        expect(def).toContain("'review-block'");
        expect(def).toContain("'approval-block'");
      }
    });
  });
});
