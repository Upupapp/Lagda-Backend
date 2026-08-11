// `listRenderableFieldValues` against real PostgreSQL (BACKEND-39, OD-164).
//
// The step's unit tests run against a fake, so they prove the PROJECTION and
// nothing about the QUERY. This is a three-table join with a deliberate LEFT
// join and a four-column geometry join; every way it can be wrong — dropping
// text values, picking another request's geometry, returning the wrong
// representation — produces a plausible result rather than an error.
//
// The LEFT join in particular: an INNER join here would silently drop every
// text and checkbox value, because only signatures have a representation row.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId, SigningRequestId,
  SigningRequestRecipientId, SigningRequestFieldId,
  NewSigningRequestSnapshot,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-11T07:00:00.000Z");
const USER = "usr_rv" as UserId;
const WS = "ws_rv" as WorkspaceId;
const DOC = "doc_rv" as DocumentId;
const REQUEST = "sr_rv" as SigningRequestId;
const OTHER_REQUEST = "sr_rv_other" as SigningRequestId;
const R1 = "srr_rv_1" as SigningRequestRecipientId;

const F_TEXT = "srf_rv_text" as SigningRequestFieldId;
const F_CHECK = "srf_rv_check" as SigningRequestFieldId;
const F_TYPED = "srf_rv_typed" as SigningRequestFieldId;
const F_DRAWN = "srf_rv_drawn" as SigningRequestFieldId;

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("listRenderableFieldValues (real PostgreSQL)", () => {
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
        memberId: "mem_rv" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_rv" as ArtifactId, workspaceId: WS, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
        pageCount: 3, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_rv" as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: "art_rv", createdAt: AT,
      });
      await uow.recipients.insert({
        recipientId: "rcp_rv" as RecipientId, workspaceId: WS,
        preparationId: "prep_rv" as PreparationId, sourceContactId: null,
        name: "Juan", email: "Juan@Example.com",
        emailKey: "juan@example.com" as never, organization: null,
        type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        createdAt: AT,
      });

      const snapshot = (id: SigningRequestId): NewSigningRequestSnapshot => ({
        request: {
          signingRequestId: id, workspaceId: WS, documentId: DOC,
          sourceArtifactId: "art_rv" as ArtifactId,
          sourcePreparationId: "prep_rv" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null,
          completedAt: null,
          terminationReason: null, cancellationNote: null,
          documentTitle: "Lease", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [{
          recipientId: id === REQUEST ? R1 : ("srr_rv_o" as SigningRequestRecipientId),
          sourcePreparationRecipientId: null,
          name: "Juan", email: "Juan@Example.com",
          normalizedEmail: "juan@example.com", organization: null,
          type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        }],
        // Deliberately out of page order, so an assertion on ordering means
        // something.
        fields: id === REQUEST ? [
          {
            fieldId: F_DRAWN, sourcePreparationFieldId: null, type: "signature",
            pageNumber: 3, x: 0.4, y: 0.5, width: 0.2, height: 0.06,
            required: true, label: "Sign", layer: 0, recipientId: R1,
          },
          {
            fieldId: F_TEXT, sourcePreparationFieldId: null, type: "text",
            pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05,
            required: true, label: "Notes", layer: 0, recipientId: R1,
          },
          {
            fieldId: F_CHECK, sourcePreparationFieldId: null, type: "checkbox",
            pageNumber: 1, x: 0.6, y: 0.2, width: 0.03, height: 0.03,
            required: true, label: "Agree", layer: 0, recipientId: R1,
          },
          {
            fieldId: F_TYPED, sourcePreparationFieldId: null, type: "signature",
            pageNumber: 2, x: 0.2, y: 0.7, width: 0.25, height: 0.06,
            required: true, label: "Initial", layer: 0, recipientId: R1,
          },
        ] : [{
          // Another request's field, at DIFFERENT coordinates. If the geometry
          // join is under-constrained this is what leaks in.
          fieldId: "srf_rv_other" as SigningRequestFieldId,
          sourcePreparationFieldId: null, type: "text",
          pageNumber: 9, x: 0.99, y: 0.99, width: 0.005, height: 0.005,
          required: true, label: "Other", layer: 0,
          recipientId: "srr_rv_o" as SigningRequestRecipientId,
        }],
      });

      await uow.signingRequests.createSnapshot(snapshot(REQUEST));
      await uow.signingRequests.createSnapshot(snapshot(OTHER_REQUEST));
    });

    // Submission, representations and values by raw SQL: this suite is about
    // the READ, and driving the write path would couple it to BACKEND-36's
    // session machinery for no extra coverage.
    //
    // TWO representations, and they must have DIFFERENT purposes:
    // `signing_representations_one_per_purpose` allows one per
    // (submission, purpose), because the ceremony adopts ONE signature and
    // applies it to every signature field rather than storing the raster per
    // field. So a submission carries at most a signature and an initials, and
    // several fields share each — which is exactly what the join has to get
    // right.
    await sql`
      insert into recipient_submissions (
        submission_id, workspace_id, signing_request_id, request_recipient_id,
        signing_session_id, authentication_method, consent_id, accepted_at)
      values ('sub_rv', ${WS}, ${REQUEST}, ${R1}, 'rss_rv', 'link-only', null,
              to_timestamp(${AT / 1000}))
    `.execute(owner.db);

    await sql`
      insert into signing_representations (
        representation_id, workspace_id, signing_request_id, request_recipient_id,
        submission_id, purpose, representation_type,
        typed_text, typed_style_index,
        raster_bytes, raster_media_type, raster_width, raster_height, digest)
      values
        ('rep_typed', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', 'initials',
         'TYPED_SIGNATURE_V1', 'Juan dela Cruz', 2, null, null, null, null,
         ${"a".repeat(64)}),
        ('rep_drawn', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', 'signature',
         'RASTER_SIGNATURE_V1', null, null, ${PNG}, 'image/png', 8, 4,
         ${"b".repeat(64)})
    `.execute(owner.db);

    await sql`
      insert into signing_field_values (
        value_id, workspace_id, signing_request_id, request_recipient_id,
        submission_id, request_field_id, field_type, value_kind, value_source,
        text_value, boolean_value, instant_value, representation_id)
      values
        ('v_text', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', ${F_TEXT}, 'text',
         'text', 'RECIPIENT_PROVIDED', 'Peñaflor — ₱50,000.00', null, null, null),
        ('v_check', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', ${F_CHECK}, 'checkbox',
         'boolean', 'RECIPIENT_PROVIDED', null, true, null, null),
        ('v_typed', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', ${F_TYPED}, 'signature',
         'representation', 'RECIPIENT_PROVIDED', null, null, null, 'rep_typed'),
        ('v_drawn', ${WS}, ${REQUEST}, ${R1}, 'sub_rv', ${F_DRAWN}, 'signature',
         'representation', 'RECIPIENT_PROVIDED', null, null, null, 'rep_drawn')
    `.execute(owner.db);
  });

  const read = () => createTransactionManager(owner.db).runForWorkspace(WS, uow =>
    uow.completionInputs.listRenderableFieldValues(REQUEST));

  it("returns EVERY accepted value, including the ones with no representation", async () => {
    // The LEFT-join assertion. An inner join returns 2 instead of 4, and the
    // document would come out missing its text and its checkbox.
    const rows = await read();
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.fieldId).sort()).toEqual(
      [F_CHECK, F_DRAWN, F_TEXT, F_TYPED].map(String).sort());
  });

  it("carries the request's own frozen geometry", async () => {
    const rows = await read();
    const text = rows.find(row => row.fieldId === String(F_TEXT));
    expect(text).toMatchObject({
      pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05,
    });
    // Nothing from the other request leaked in through an under-constrained
    // join: its field sits on page 9 at 0.99.
    expect(rows.some(row => row.pageNumber === 9)).toBe(false);
  });

  it("projects a text value, diacritics and peso sign intact", async () => {
    const rows = await read();
    expect(rows.find(row => row.fieldId === String(F_TEXT))?.value)
      .toEqual({ kind: "text", text: "Peñaflor — ₱50,000.00" });
  });

  it("projects a checkbox as a boolean", async () => {
    const rows = await read();
    expect(rows.find(row => row.fieldId === String(F_CHECK))?.value)
      .toEqual({ kind: "checkbox", checked: true });
  });

  it("projects a typed signature with its style index", async () => {
    const rows = await read();
    expect(rows.find(row => row.fieldId === String(F_TYPED))?.value)
      .toEqual({ kind: "typed-signature", text: "Juan dela Cruz", styleIndex: 2 });
  });

  it("projects a drawn signature as DECODED bytes, not base64", async () => {
    const rows = await read();
    const value = rows.find(row => row.fieldId === String(F_DRAWN))?.value;
    expect(value).toMatchObject({
      kind: "raster-signature", mediaType: "image/png", width: 8, height: 4,
    });
    // The exact bytes, and a Uint8Array rather than a Buffer aliasing the
    // driver's pool.
    const bytes = (value as { bytes: Uint8Array }).bytes;
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("returns the RIGHT representation per field, not the first one found", async () => {
    // Two representations exist on one submission. A join that matched on the
    // submission rather than on `representation_id` would give both fields the
    // same signature, and it would look correct on a document with one signer.
    const rows = await read();
    const typed = rows.find(row => row.fieldId === String(F_TYPED))?.value;
    const drawn = rows.find(row => row.fieldId === String(F_DRAWN))?.value;
    expect(typed?.kind).toBe("typed-signature");
    expect(drawn?.kind).toBe("raster-signature");
  });

  it("orders by page then field, so the caller sees a stable sequence", async () => {
    const rows = await read();
    expect(rows.map(row => row.pageNumber)).toEqual([1, 1, 2, 3]);
  });

  it("returns nothing for a request with no accepted values", async () => {
    const rows = await createTransactionManager(owner.db).runForWorkspace(WS, uow =>
      uow.completionInputs.listRenderableFieldValues(OTHER_REQUEST));
    expect(rows).toEqual([]);
  });
});
