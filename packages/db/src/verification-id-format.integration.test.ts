// The public verification identifier, checked against the LIVE constraint.
//
// ── The defect this exists to catch ────────────────────────────────────────
//
// Three places define this identifier's shape, and until migration 045 only
// two of them agreed:
//
//   * Both generators mint `LAGDA-VER-{4-digit year}-{10 random chars}`.
//   * The product's public verify page parses
//     `/^LAGDA-VER-\d{4}-\w{4,10}$/i` — what a human may type.
//   * `verification_records_format_check` still enforced handoff §15's
//     original `^LAGDA-[A-Za-z0-9]+-[0-9]{8}-[A-Za-z0-9]{6,}$`, whose
//     eight-digit date segment cannot match a four-digit year.
//
// So every verification record insert was refused, which failed the
// `final-seal` step on every attempt and left completed signing requests
// stuck at `completion-ready` forever. The step reports any throw in its
// persistence transaction as `database-unavailable`, so a deterministic
// schema disagreement presented as a transient outage and retried.
//
// `packages/api/src/security/verification-id.test.ts` already binds the
// generator to the FRONTEND's regex, and passed throughout — the untested
// edge was generator-to-DATABASE. This closes it the only way that cannot
// drift: by handing the database a real generated identifier and requiring
// it to land.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createVerificationIdGenerator } from "@lagda/security";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawTenantTransaction,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-18T07:00:00.000Z");
const USER = "usr_verid" as UserId;
const WS = "ws_verid" as WorkspaceId;

/** The product's own parser, copied verbatim from `services/public/index.ts`. */
const VER_ID_RE = /^LAGDA-VER-\d{4}-\w{4,10}$/i;

const CHECK_VIOLATION = "23514";

const suite = hasIntegrationDatabase() ? describe : describe.skip;

function sqlstateOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

suite("verification_id format, against the live constraint", () => {
  let owner: LagdaDatabase;
  // The WORKER's generator specifically — the one on the completion path.
  const ids = createVerificationIdGenerator();

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
      await uow.workspaces.insert({ workspaceId: WS, name: "Ver Id", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_verid" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
    });
  });

  /** Raw SQL, so an invalid identifier can be expressed at all. */
  async function insertVerification(verificationId: string): Promise<void> {
    await withRawTenantTransaction(owner, WS, async trx => {
      await sql`
        insert into verification_records (
          verification_id, workspace_id, signing_request_id, document_id,
          seal_id, completed_at, participant_count, created_at
        ) values (
          ${verificationId}, ${WS}, 'sr_verid', 'doc_verid',
          'seal_verid', ${new Date(AT)}, 1, ${new Date(AT)}
        )
      `.execute(trx);
    });
  }

  it("accepts an identifier the WORKER actually mints", async () => {
    // The assertion the pipeline needed and nobody made. A generator whose
    // output the database refuses is a completion that can never finish.
    const verificationId = ids.nextVerificationId(WS, AT);
    await expect(insertVerification(verificationId)).resolves.toBeUndefined();

    const found = await withRawTenantTransaction(owner, WS, trx =>
      sql<{ verification_id: string }>`
        select verification_id from verification_records
         where verification_id = ${verificationId}
      `.execute(trx));
    expect(found.rows[0]?.verification_id).toBe(verificationId);
  });

  it("mints identifiers the public verify page also accepts", async () => {
    // Binds all three definitions in one place: minted here, accepted by the
    // database above, and parseable by the frontend's regex. Previously the
    // first and third agreed while the second silently disagreed.
    for (let i = 0; i < 25; i += 1) {
      expect(ids.nextVerificationId(WS, AT)).toMatch(VER_ID_RE);
    }
  });

  it("still REFUSES a serial or guessable value — the constraint's purpose", async () => {
    // Migration 003 gave this constraint a reason: "so a database serial or a
    // guessable value cannot be stored as one". Migration 045 corrected the
    // pattern's date segment and must not have cost that property.
    for (const rejected of ["12345", "1", "LAGDA-VER-2026-abc", "verification-1"]) {
      let sqlstate: string | undefined;
      try {
        await insertVerification(rejected);
        expect.unreachable(`the database accepted ${rejected} as a verification id`);
      } catch (error) {
        sqlstate = sqlstateOf(error);
      }
      expect(sqlstate, `${rejected} should violate the CHECK`).toBe(CHECK_VIOLATION);
    }
  });
});
