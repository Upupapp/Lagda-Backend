// `listCertifiedParticipants` against real PostgreSQL (BACKEND-40).
//
// A four-table join whose failure modes ALL produce plausible-looking results
// rather than errors — which is precisely what a fake cannot catch:
//
//   - a LEFT join written as INNER drops every signer with no consent, so the
//     certificate is missing participants and still renders
//   - consent joined on the recipient instead of `consent_id` attaches whatever
//     consent that person ever gave, not the one bound to this signature
//   - authentication read from a SESSION rather than the SUBMISSION certifies
//     the recipient's strongest authentication instead of the one they signed
//     under — an assurance overclaim arriving through a join
//   - an under-constrained request scope pulls another request's signer onto
//     the certificate
//
// Every one of those renders a certificate that looks right.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId, SigningRequestId,
  SigningRequestRecipientId, NewSigningRequestSnapshot,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-11T07:00:00.000Z");
const USER = "usr_cp" as UserId;
const WS = "ws_cp" as WorkspaceId;
const DOC = "doc_cp" as DocumentId;
const REQUEST = "sr_cp" as SigningRequestId;
const OTHER = "sr_cp_other" as SigningRequestId;

/** Signs, with consent and a recorded ceremony entry. */
const R1 = "srr_cp_1" as SigningRequestRecipientId;
/** Signs, with NEITHER consent nor ceremony entry — the LEFT-join case. */
const R2 = "srr_cp_2" as SigningRequestRecipientId;
/** Does NOT sign. Must never be certified. */
const R3 = "srr_cp_3" as SigningRequestRecipientId;
/** Another request's signer. Must never leak in. */
const R_OTHER = "srr_cp_o" as SigningRequestRecipientId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("listCertifiedParticipants (real PostgreSQL)", () => {
  let owner: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "WS", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_cp" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_cp" as ArtifactId, workspaceId: WS, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
        pageCount: 2, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_cp" as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: "art_cp", createdAt: AT,
      });
      await uow.recipients.insert({
        recipientId: "rcp_cp" as RecipientId, workspaceId: WS,
        preparationId: "prep_cp" as PreparationId, sourceContactId: null,
        name: "Seed", email: "Seed@Example.com",
        emailKey: "seed@example.com" as never, organization: null,
        type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        createdAt: AT,
      });

      const snapshot = (id: SigningRequestId): NewSigningRequestSnapshot => ({
        request: {
          signingRequestId: id, workspaceId: WS, documentId: DOC,
          sourceArtifactId: "art_cp" as ArtifactId,
          sourcePreparationId: "prep_cp" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null,
          completedAt: null,
          terminationReason: null, cancellationNote: null,
          documentTitle: "Lease", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: id === REQUEST
          ? [
            // Deliberately declared OUT of routing order, so an assertion on
            // ordering means something.
            {
              recipientId: R3, sourcePreparationRecipientId: null,
              name: "Never Signed", email: "never@example.com",
              normalizedEmail: "never@example.com", organization: null,
              type: "signer", isRequired: true, orderIndex: 2, routingOrder: 3,
            },
            {
              recipientId: R2, sourcePreparationRecipientId: null,
              name: "Maria Santos", email: "maria.santos@example.com",
              normalizedEmail: "maria.santos@example.com", organization: null,
              type: "signer", isRequired: true, orderIndex: 1, routingOrder: 2,
            },
            {
              recipientId: R1, sourcePreparationRecipientId: null,
              name: "Peñaflor Ubaldo", email: "juan@example.com",
              normalizedEmail: "juan@example.com", organization: null,
              type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
            },
          ]
          : [{
            recipientId: R_OTHER, sourcePreparationRecipientId: null,
            name: "Other Request Signer", email: "other@example.com",
            normalizedEmail: "other@example.com", organization: null,
            type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
          }],
        fields: [],
      });

      await uow.signingRequests.createSnapshot(snapshot(REQUEST));
      await uow.signingRequests.createSnapshot(snapshot(OTHER));
    });

    // Consents. `con_1` belongs to R1's signature. `con_stray` belongs to R1
    // too but is NOT the one bound to the submission — if the join uses the
    // recipient rather than `consent_id`, one of these wins arbitrarily.
    //
    // They differ by VERSION, not type: `signing_recipient_consents_type_check`
    // admits exactly one type, `electronic-records-and-signature`. So the
    // certificate's consent TYPE is effectively constant today and the VERSION
    // is the part that carries information — which is why the model keeps both
    // and the builder refuses a version without a type.
    await sql`
      insert into signing_recipient_consents (
        consent_id, workspace_id, signing_request_id, request_recipient_id,
        consent_type, consent_version, accepted_at, signing_session_id,
        authentication_method, created_at)
      values
        ('con_1', ${WS}, ${REQUEST}, ${R1},
         'electronic-records-and-signature', '1.2',
         to_timestamp(${(AT - 110_000) / 1000}), 'rss_1', 'email-otp',
         to_timestamp(${AT / 1000})),
        ('con_stray', ${WS}, ${REQUEST}, ${R1},
         'electronic-records-and-signature', '9.9',
         to_timestamp(${(AT - 500_000) / 1000}), 'rss_old', 'link-only',
         to_timestamp(${AT / 1000}))
    `.execute(owner.db);

    // R1 signed under LINK-ONLY, and consented via con_1.
    // R2 signed under email-otp, with no consent and no ceremony entry.
    // R3 has no submission at all.
    await sql`
      insert into recipient_submissions (
        submission_id, workspace_id, signing_request_id, request_recipient_id,
        signing_session_id, authentication_method, consent_id, accepted_at)
      values
        ('sub_1', ${WS}, ${REQUEST}, ${R1}, 'rss_1', 'link-only', 'con_1',
         to_timestamp(${(AT - 60_000) / 1000})),
        ('sub_2', ${WS}, ${REQUEST}, ${R2}, 'rss_2', 'email-otp', null,
         to_timestamp(${(AT - 30_000) / 1000})),
        ('sub_o', ${WS}, ${OTHER}, ${R_OTHER}, 'rss_o', 'link-only', null,
         to_timestamp(${(AT - 10_000) / 1000}))
    `.execute(owner.db);

    await sql`
      insert into signing_recipient_progress (
        workspace_id, signing_request_id, request_recipient_id,
        first_entered_at, created_at)
      values (${WS}, ${REQUEST}, ${R1},
              to_timestamp(${(AT - 120_000) / 1000}), to_timestamp(${AT / 1000}))
    `.execute(owner.db);
  });

  const read = (id: SigningRequestId = REQUEST) =>
    createTransactionManager(owner.db).runForWorkspace(WS, uow =>
      uow.completionInputs.listCertifiedParticipants(id));

  it("certifies ONLY recipients who actually signed", async () => {
    // §49. R3 exists on the request and never signed; an outer join here would
    // put an unsigned participant on a completion certificate.
    const rows = await read();
    expect(rows.map(r => r.recipientId)).toEqual([String(R1), String(R2)]);
  });

  it("includes a signer with NO consent and NO ceremony entry", async () => {
    // The LEFT-join assertion. An inner join returns only R1, and the
    // certificate silently loses a signer while still rendering.
    const rows = await read();
    const maria = rows.find(r => r.recipientId === String(R2));
    expect(maria).toBeDefined();
    expect(maria?.consentType).toBeNull();
    expect(maria?.firstEnteredAt).toBeNull();
  });

  it("reads authentication from the SUBMISSION, not from the consent row", async () => {
    // The binding that matters, and the fixture discriminates it precisely:
    // R1's SUBMISSION records `link-only`, while R1's bound CONSENT row records
    // `email-otp`. Both tables are in this join and both carry a column of that
    // name, so reading the wrong one is an easy mistake with no visible
    // symptom — it would certify a stronger mechanism than the signature was
    // actually made under.
    //
    // Scope note: this does NOT exercise a `recipient_signing_sessions` row,
    // which would need an access-grant FK chain to seed. Resolving auth from a
    // session would still fail here (it would find none), but that is a
    // weaker demonstration than the consent discriminator above, so the test
    // is named for what it actually proves.
    const rows = await read();
    expect(rows.find(r => r.recipientId === String(R1))?.authenticationMethod)
      .toBe("link-only");
  });

  it("binds consent through consent_id, not through the recipient", async () => {
    // R1 has TWO consent rows. Only `con_1` is bound to the submission; joining
    // on the recipient would attach whichever row the planner reached first —
    // and 'marketing 9.9' onto a signing certificate is the visible symptom.
    const rows = await read();
    const juan = rows.find(r => r.recipientId === String(R1));
    expect(juan?.consentType).toBe("electronic-records-and-signature");
    // The VERSION is what distinguishes the bound consent from the stray one.
    expect(juan?.consentVersion).toBe("1.2");
    expect(juan?.consentAcceptedAt).toBe(AT - 110_000);
  });

  it("returns exactly one row per signer despite two consent rows", async () => {
    // The same defect seen from the other side: a recipient-keyed join
    // MULTIPLIES rows, and the signer would appear twice on the certificate.
    const rows = await read();
    expect(rows.filter(r => r.recipientId === String(R1))).toHaveLength(1);
  });

  it("carries the immutable snapshot identity, including diacritics", async () => {
    const rows = await read();
    const juan = rows.find(r => r.recipientId === String(R1));
    expect(juan?.name).toBe("Peñaflor Ubaldo");
    // FULL email here; masking is the builder's job, not the query's.
    expect(juan?.email).toBe("juan@example.com");
  });

  it("uses the submission's accepted_at as the signing time", async () => {
    const rows = await read();
    expect(rows.find(r => r.recipientId === String(R1))?.signedAt).toBe(AT - 60_000);
    expect(rows.find(r => r.recipientId === String(R2))?.signedAt).toBe(AT - 30_000);
  });

  it("binds ceremony entry per recipient", async () => {
    const rows = await read();
    expect(rows.find(r => r.recipientId === String(R1))?.firstEnteredAt)
      .toBe(AT - 120_000);
  });

  it("never leaks another request's signer", async () => {
    const rows = await read();
    expect(rows.some(r => r.recipientId === String(R_OTHER))).toBe(false);
    expect(rows.some(r => r.name === "Other Request Signer")).toBe(false);
  });

  it("orders by routing order, then index, then id", async () => {
    // §50. Declared out of order in the fixture, so this cannot pass by
    // accident of insertion order.
    const rows = await read();
    expect(rows.map(r => r.routingOrder)).toEqual([1, 2]);
    expect(rows.map(r => r.name)).toEqual(["Peñaflor Ubaldo", "Maria Santos"]);
  });

  it("returns the other request's own signer when asked for it", async () => {
    // The negative control for the scoping test above: the row EXISTS and is
    // reachable, so its absence from REQUEST is scoping rather than an empty
    // table.
    const rows = await read(OTHER);
    expect(rows.map(r => r.name)).toEqual(["Other Request Signer"]);
  });
});
