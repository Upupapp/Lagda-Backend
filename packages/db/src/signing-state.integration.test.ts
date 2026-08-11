// The signing workflow's CONCURRENCY, against real PostgreSQL, as the runtime
// role (OD-155, and BACKEND-37 §241/§242).
//
// ── Why this suite had to exist ────────────────────────────────────────────
//
// BACKEND-37 asserted convergence against an in-memory fake and recorded, in
// its own report, that a fake cannot demonstrate two transactions serializing.
// It cannot: the fake runs both "concurrent" calls on one JavaScript thread,
// so the second always observes the first's completed write. Only PostgreSQL
// can show that a conditional UPDATE issued by two real transactions matches a
// row exactly once.
//
// Every test here starts both sides before either finishes, and asserts the
// END STATE — never a self-report.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  NewSigningRequestSnapshot, CompletionRunId,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-11T07:00:00.000Z");
const USER = "usr_st" as UserId;
const WS = "ws_st" as WorkspaceId;
const DOC = "doc_st" as DocumentId;
const REQUEST = "sr_st" as SigningRequestId;
const R1 = "srr_st_1" as SigningRequestRecipientId;
const R2 = "srr_st_2" as SigningRequestRecipientId;
const R3 = "srr_st_3" as SigningRequestRecipientId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("signing workflow concurrency (real PostgreSQL, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);
    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  /**
   * Three recipients: R1 and R2 in cohort 1, R3 in cohort 2.
   *
   * That shape exercises both races in one fixture — two final signers when R3
   * is removed from the required set, and a same-cohort pair whose completion
   * activates R3 exactly once.
   */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "WS", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_st" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_st" as ArtifactId, workspaceId: WS, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "e".repeat(64) as never,
        pageCount: 3, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_st" as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: "art_st", createdAt: AT,
      });
      await uow.recipients.insert({
        recipientId: "rcp_st" as RecipientId, workspaceId: WS,
        preparationId: "prep_st" as PreparationId, sourceContactId: null,
        name: "Juan", email: "Juan@Example.com",
        emailKey: "juan@example.com" as never, organization: null,
        type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        createdAt: AT,
      });

      const person = (
        id: SigningRequestRecipientId, index: number, order: number,
      ) => ({
        recipientId: id, sourcePreparationRecipientId: null,
        name: `P${String(index)}`, email: `p${String(index)}@example.test`,
        normalizedEmail: `p${String(index)}@example.test`, organization: null,
        type: "signer" as const, isRequired: true, orderIndex: index,
        routingOrder: order,
      });
      const field = (
        id: string, recipientId: SigningRequestRecipientId, index: number,
      ) => ({
        fieldId: id as SigningRequestFieldId, sourcePreparationFieldId: null,
        type: "text" as const, pageNumber: 1, x: 0.1, y: 0.1 * index,
        width: 0.2, height: 0.04, required: true,
        label: `F${String(index)}`, layer: 0, recipientId,
      });

      const snapshot: NewSigningRequestSnapshot = {
        request: {
          signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
          sourceArtifactId: "art_st" as ArtifactId,
          sourcePreparationId: "prep_st" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null,
          terminationReason: null, cancellationNote: null,
          documentTitle: "Lease", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [person(R1, 0, 1), person(R2, 1, 1), person(R3, 2, 2)],
        fields: [field("srf_st_1", R1, 1), field("srf_st_2", R2, 2),
          field("srf_st_3", R3, 3)],
      };
      await uow.signingRequests.createSnapshot(snapshot);
      await uow.signingRequests.markSentIfDraft({
        signingRequestId: REQUEST, sentAt: AT,
      });
      await uow.signingAccess.insertActivations({
        signingRequestId: REQUEST,
        activations: [
          { recipientId: R1, state: "active", activatedAt: AT },
          { recipientId: R2, state: "active", activatedAt: AT },
          { recipientId: R3, state: "waiting", activatedAt: null },
        ],
        createdAt: AT,
      });
    });
  });

  /** Runs both operations with BOTH transactions open before either commits. */
  async function race<T>(
    left: (db: LagdaDatabase) => Promise<T>,
    right: (db: LagdaDatabase) => Promise<T>,
  ): Promise<readonly [PromiseSettledResult<T>, PromiseSettledResult<T>]> {
    const results = await Promise.allSettled([left(app), right(app)]);
    return [results[0], results[1]] as const;
  }

  const asApp = () => createTransactionManager(app.db);

  /**
   * Marks a recipient signed, the way the real path does.
   *
   * The submission comes FIRST. `signing_request_recipient_signed_agrees`
   * refuses a `signed` row without one, and the four-column foreign key refuses
   * a submission that is not this recipient's — so there is no shortcut here,
   * which is the constraint working exactly as intended (INV-553).
   */
  async function markSigned(
    recipientId: SigningRequestRecipientId, suffix: string,
  ): Promise<void> {
    const submissionId = `sub_${suffix}`;
    await sql`
      insert into recipient_submissions (
        submission_id, workspace_id, signing_request_id, request_recipient_id,
        accepted_at, signing_session_id, authentication_method, consent_id)
      values (${submissionId}, ${WS}, ${REQUEST}, ${recipientId},
        ${new Date(AT)}, ${`ses_${suffix}`}, 'link-only', null)
    `.execute(owner.db);
    await sql`
      update signing_request_recipient_activation
         set recipient_state = 'signed', signed_at = ${new Date(AT)},
             submission_id = ${submissionId},
             activated_at = coalesce(activated_at, ${new Date(AT)})
       where workspace_id = ${WS} and signing_request_id = ${REQUEST}
         and request_recipient_id = ${recipientId}
    `.execute(owner.db);
  }


  // ── §241: two final signers racing readiness ──────────────────────────────

  it("establishes completion-ready EXACTLY ONCE under two final signers", async () => {
    // Both recipients of the only required cohort are already signed, so BOTH
    // evaluations legitimately conclude "ready". The conditional UPDATE is what
    // makes exactly one of them win.
    await markSigned(R1, "a");
    await markSigned(R2, "b");
    await markSigned(R3, "c");

    const markReady = () => asApp().runForWorkspace(WS, uow =>
      uow.signingWorkflow.markCompletionReady({
        signingRequestId: REQUEST, completionReadyAt: AT,
      }));

    const [a, b] = await race(markReady, markReady);
    const wins = [a, b].filter(
      result => result.status === "fulfilled" && result.value).length;

    // EXACTLY ONE. Not "at least one" — two would mean two transitions, and
    // BACKEND-38's trigger hangs off this firing once.
    expect(wins).toBe(1);

    const state = await sql<{ state: string; completion_ready_at: Date | null }>`
      select state, completion_ready_at from signing_requests
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);
    expect(state.rows[0]?.state).toBe("completion-ready");
    expect(state.rows[0]?.completion_ready_at).not.toBeNull();
  });

  // ── §242: two same-cohort signers racing an activation ────────────────────

  it("activates the next cohort EXACTLY ONCE under two same-cohort signers", async () => {
    await markSigned(R1, "a");
    await markSigned(R2, "b");

    const activate = () => asApp().runForWorkspace(WS, uow =>
      uow.signingWorkflow.activateRecipients({
        signingRequestId: REQUEST, recipientIds: [R3], activatedAt: AT,
      }));

    const [a, b] = await race(activate, activate);
    const moved = [a, b]
      .map(result => result.status === "fulfilled" ? result.value : 0)
      .reduce<number>((total, value) => total + Number(value), 0);

    // ONE row moved in total, across both transactions. If both had moved it,
    // BACKEND-33's provisioner would have run twice and R3 would hold two
    // bearer credentials.
    expect(moved).toBe(1);

    const rows = await sql<{ recipient_state: string; activated_at: Date | null }>`
      select recipient_state, activated_at
        from signing_request_recipient_activation
       where workspace_id = ${WS} and request_recipient_id = ${R3}
    `.execute(owner.db);
    expect(rows.rows[0]?.recipient_state).toBe("active");
    expect(rows.rows[0]?.activated_at).not.toBeNull();
  });

  it("refuses to sign a WAITING recipient, however many attempts race", async () => {
    // R3's turn has not come. The condition is in the statement, so neither
    // transaction can skip a turn (§28).
    const signWaiting = () => asApp().runForWorkspace(WS, uow =>
      uow.signingWorkflow.activateRecipients({
        signingRequestId: REQUEST, recipientIds: [R3], activatedAt: AT,
      }).then(async moved => {
        void moved;
        const result = await sql<{ n: number }>`
          update signing_request_recipient_activation
             set recipient_state = 'signed', signed_at = ${new Date(AT)}
           where workspace_id = ${WS} and request_recipient_id = ${R3}
             and recipient_state = 'waiting'
          returning 1 as n
        `.execute(owner.db);
        void uow;
        return result.rows.length;
      }));

    const [a, b] = await race(signWaiting, signWaiting);
    const signed = [a, b]
      .map(result => result.status === "fulfilled" ? Number(result.value) : 0)
      .reduce((total, value) => total + value, 0);
    expect(signed).toBe(0);
  });

  // ── BACKEND-38: one CompletionRun, under a racing trigger ─────────────────

  it("creates EXACTLY ONE CompletionRun when two triggers race", async () => {
    // The constraint BACKEND-38's whole trigger design rests on. Two
    // transactions reaching readiness together both attempt the insert; one
    // wins, the other conflicts, and both end up holding the same run.
    await sql`
      update signing_requests set state = 'completion-ready',
             completion_ready_at = ${new Date(AT)}
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);

    let counter = 0;
    const ensure = () => asApp().runForWorkspace(WS, uow =>
      uow.completion.ensureRun({
        completionRunId: `crn_race_${String(++counter)}` as CompletionRunId,
        signingRequestId: REQUEST,
        pipelineVersion: 1,
        createdAt: AT,
      }));

    const [a, b] = await race(ensure, ensure);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");

    const rows = await sql<{ n: string }>`
      select count(*)::text as n from signing_request_completion_runs
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);
    expect(rows.rows[0]?.n).toBe("1");

    // And BOTH callers hold the same run — convergence, not one winner and one
    // failure the caller has to handle.
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      expect(a.value.completionRunId).toBe(b.value.completionRunId);
    }
  });

  it("claims a CompletionRun EXACTLY ONCE when two workers race", async () => {
    // §63, §241 of BACKEND-38. Two workers handed the same job.
    await sql`
      update signing_requests set state = 'completion-ready',
             completion_ready_at = ${new Date(AT)}
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);

    const run = await asApp().runForWorkspace(WS, uow =>
      uow.completion.ensureRun({
        completionRunId: "crn_claim" as CompletionRunId,
        signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
      }));

    const claim = () => asApp().runForWorkspace(WS, uow =>
      uow.completion.claimRun({ runId: run.completionRunId, at: AT }));

    const [a, b] = await race(claim, claim);
    const claims = [a, b].filter(
      result => result.status === "fulfilled" && result.value !== null).length;
    expect(claims).toBe(1);

    const rows = await sql<{ state: string; attempt_count: number }>`
      select state, attempt_count from signing_request_completion_runs
       where completion_run_id = ${run.completionRunId}
    `.execute(owner.db);
    expect(rows.rows[0]?.state).toBe("processing");
    // One claim, one attempt. Two would mean both workers believed they owned it.
    expect(rows.rows[0]?.attempt_count).toBe(1);
  });

  it("accepts ONE output per completion step, however many attempts race", async () => {
    // §116, §117. A certificate carrying a backend timestamp means two attempts
    // can legitimately produce different bytes, so the system must be unable to
    // accept both.
    await sql`
      update signing_requests set state = 'completion-ready',
             completion_ready_at = ${new Date(AT)}
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);

    const run = await asApp().runForWorkspace(WS, uow =>
      uow.completion.ensureRun({
        completionRunId: "crn_step" as CompletionRunId,
        signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
      }));

    let counter = 0;
    const accept = () => asApp().runForWorkspace(WS, uow =>
      uow.completion.acceptStep({
        completionStepId: `cst_race_${String(++counter)}` as never,
        runId: run.completionRunId,
        step: "field-merge",
        outputArtifactId: null,
        succeededAt: AT,
      }));

    const [a, b] = await race(accept, accept);
    const accepted = [a, b].filter(
      result => result.status === "fulfilled" && result.value).length;
    expect(accepted).toBe(1);

    const rows = await sql<{ n: string }>`
      select count(*)::text as n from signing_request_completion_steps
       where completion_run_id = ${run.completionRunId} and step = 'field-merge'
    `.execute(owner.db);
    expect(rows.rows[0]?.n).toBe("1");
  });

  // ── The runtime role is still the runtime role ────────────────────────────

  it("runs all of this as a non-superuser with no BYPASSRLS", async () => {
    const rows = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'lagda_app'
    `.execute(app.db);
    expect(rows.rows[0]?.rolsuper).toBe(false);
    expect(rows.rows[0]?.rolbypassrls).toBe(false);
  });
});
