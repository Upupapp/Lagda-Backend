// 083. Verify Document access codes and grants, on PostgreSQL.
//
// Every method runs in ONE transaction and follows the same order:
//
//   1. 075's public-verification realm (`lagda.public_verification_active`,
//      local) to resolve the verification ID to a COMPLETED request — or, for
//      a grant, 083's grant realm (`lagda.verification_access_grant_digest`)
//      to find the one grant whose digest was presented;
//   2. then the RESOLVED workspace's tenant context (`lagda.workspace_id`,
//      local) for every read or write of a challenge, grant, participant or
//      evidence row.
//
// Every setting is `set_config(..., true)` — transaction-local, gone at
// commit or rollback, never left on a pooled connection.
//
// ── 087: the access list ──────────────────────────────────────────────────
//
// A code goes to — and a grant may name — any entry on the completed
// document's access list: a participant row, an ACCEPTED share or an
// APPROVED request, looked up in that order inside the resolved workspace. A
// signed-in grant may also rest on membership: the document's owner (the
// signing request's sender) or a holder of `document.share.manage`. Every
// grant is re-validated against its basis on every use, so removing a share
// or a membership ends access at once.

import { sql, type Kysely, type Transaction } from "kysely";
import type { WorkspaceId, WorkspaceRole } from "@lagda/contracts";
import { hasCapability } from "@lagda/core";
import type {
  VerificationAccessStore, VerificationParticipantTarget, NewVerificationAccessGrant,
  VerificationAccessBasis,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { createNotificationRepository } from "./notifications.js";

type Trx = Transaction<Database>;

const PUBLIC_VERIFICATION_SETTING = "lagda.public_verification_active";
const WORKSPACE_SETTING = "lagda.workspace_id";
const GRANT_DIGEST_SETTING = "lagda.verification_access_grant_digest";

interface ResolvedRequest {
  readonly workspaceId: string;
  readonly signingRequestId: string;
  readonly sealId: string;
  readonly documentTitle: string;
  readonly completedAt: Date;
  /** 087. The member who sent the signing request. */
  readonly ownerUserId: string;
}

/** The completed request a verification ID names, or null — one answer. */
async function completedRequest(
  trx: Trx, verificationId: string,
): Promise<ResolvedRequest | null> {
  await sql`select set_config(${PUBLIC_VERIFICATION_SETTING}, 'true', true)`.execute(trx);
  const row = await trx
    .selectFrom("verification_records")
    .innerJoin("signing_request_completions", join => join
      .onRef("signing_request_completions.signing_request_id", "=",
        "verification_records.signing_request_id")
      .onRef("signing_request_completions.workspace_id", "=",
        "verification_records.workspace_id"))
    .innerJoin("signing_requests", join => join
      .onRef("signing_requests.signing_request_id", "=",
        "verification_records.signing_request_id")
      .onRef("signing_requests.workspace_id", "=",
        "verification_records.workspace_id"))
    .where("signing_requests.state", "=", "completed")
    .where("verification_records.verification_id", "=", verificationId)
    .select([
      "verification_records.workspace_id", "verification_records.signing_request_id",
      "verification_records.seal_id", "verification_records.completed_at",
      "signing_requests.document_title", "signing_requests.created_by_user_id",
    ])
    .executeTakeFirst();
  if (!row) return null;
  // From here on, only the resolved tenant's rows.
  await sql`select set_config(${WORKSPACE_SETTING}, ${row.workspace_id}, true)`.execute(trx);
  return {
    workspaceId: row.workspace_id,
    signingRequestId: row.signing_request_id,
    sealId: row.seal_id,
    documentTitle: row.document_title,
    completedAt: row.completed_at,
    ownerUserId: row.created_by_user_id,
  };
}

const NO_REFERENCES = { requestRecipientId: null, shareId: null, accessRequestId: null, userId: null };

function toTarget(
  request: ResolvedRequest,
  recipient: { request_recipient_id: string; name: string; email: string; recipient_type: string },
): VerificationParticipantTarget {
  return {
    workspaceId: request.workspaceId as WorkspaceId,
    signingRequestId: request.signingRequestId,
    basis: "participant",
    ...NO_REFERENCES,
    requestRecipientId: recipient.request_recipient_id,
    recipientName: recipient.name,
    destination: recipient.email,
    recipientType: recipient.recipient_type,
    documentTitle: request.documentTitle,
  };
}

/** Display only, as `recipientType` always was: what the grant says the reader is. */
const SHARED_TYPE = "shared";

async function participantTarget(
  trx: Trx, request: ResolvedRequest, normalizedEmail: string,
): Promise<VerificationParticipantTarget | null> {
  const recipient = await trx
    .selectFrom("signing_request_recipients")
    .where("workspace_id", "=", request.workspaceId)
    .where("signing_request_id", "=", request.signingRequestId)
    .where("normalized_email", "=", normalizedEmail)
    .select(["request_recipient_id", "name", "email", "recipient_type"])
    .orderBy("order_index")
    .executeTakeFirst();
  return recipient ? toTarget(request, recipient) : null;
}

async function shareTarget(
  trx: Trx, request: ResolvedRequest, match: { normalizedEmail: string } | { shareId: string },
): Promise<VerificationParticipantTarget | null> {
  let query = trx.selectFrom("document_shares")
    .where("workspace_id", "=", request.workspaceId)
    .where("signing_request_id", "=", request.signingRequestId)
    .where("status", "=", "accepted")
    .where("recipient_user_id", "is not", null)
    .select(["share_id", "email", "full_name", "recipient_user_id"]);
  query = "shareId" in match
    ? query.where("share_id", "=", match.shareId)
    : query.where("normalized_email", "=", match.normalizedEmail);
  const share = await query.orderBy("created_at", "desc").executeTakeFirst();
  if (!share) return null;
  return {
    workspaceId: request.workspaceId as WorkspaceId,
    signingRequestId: request.signingRequestId,
    basis: "share",
    ...NO_REFERENCES,
    shareId: share.share_id,
    userId: share.recipient_user_id,
    recipientName: share.full_name ?? share.email,
    destination: share.email,
    recipientType: SHARED_TYPE,
    documentTitle: request.documentTitle,
  };
}

async function accessRequestTarget(
  trx: Trx, request: ResolvedRequest,
  match: { normalizedEmail: string } | { userId: string } | { accessRequestId: string },
): Promise<VerificationParticipantTarget | null> {
  let query = trx.selectFrom("document_access_requests")
    .where("workspace_id", "=", request.workspaceId)
    .where("signing_request_id", "=", request.signingRequestId)
    .where("status", "=", "approved")
    .select(["request_id", "requester_user_id", "requester_email", "requester_name"]);
  if ("accessRequestId" in match) query = query.where("request_id", "=", match.accessRequestId);
  else if ("userId" in match) query = query.where("requester_user_id", "=", match.userId);
  else query = query.where("requester_email", "=", match.normalizedEmail);
  const found = await query.orderBy("created_at", "desc").executeTakeFirst();
  if (!found) return null;
  return {
    workspaceId: request.workspaceId as WorkspaceId,
    signingRequestId: request.signingRequestId,
    basis: "access-request",
    ...NO_REFERENCES,
    accessRequestId: found.request_id,
    userId: found.requester_user_id,
    recipientName: found.requester_name,
    destination: found.requester_email,
    recipientType: SHARED_TYPE,
    documentTitle: request.documentTitle,
  };
}

/**
 * The document's owner or a `document.share.manage` holder, by CURRENT
 * membership in the resolved workspace. The policy decides, never a role name.
 */
async function memberTarget(
  trx: Trx, request: ResolvedRequest, userId: string,
  only?: "document-owner" | "workspace-administrator",
): Promise<VerificationParticipantTarget | null> {
  const member = await trx.selectFrom("workspace_memberships")
    .innerJoin("users", "users.user_id", "workspace_memberships.user_id")
    .where("workspace_memberships.workspace_id", "=", request.workspaceId)
    .where("workspace_memberships.user_id", "=", userId)
    .select(["workspace_memberships.role", "users.display_name", "users.email"])
    .executeTakeFirst();
  if (!member) return null;
  let basis: VerificationAccessBasis | null = null;
  if (request.ownerUserId === userId && only !== "workspace-administrator") basis = "document-owner";
  else if (only !== "document-owner"
    && hasCapability(member.role as WorkspaceRole, "document.share.manage")) basis = "workspace-administrator";
  if (basis === null) return null;
  return {
    workspaceId: request.workspaceId as WorkspaceId,
    signingRequestId: request.signingRequestId,
    basis,
    ...NO_REFERENCES,
    userId,
    recipientName: member.display_name,
    destination: member.email,
    recipientType: basis === "document-owner" ? "owner" : "administrator",
    documentTitle: request.documentTitle,
  };
}

/** Who a typed address is on the access list as — participant first. */
async function accessListByEmail(
  trx: Trx, verificationId: string, normalizedEmail: string,
): Promise<{ request: ResolvedRequest; target: VerificationParticipantTarget } | null> {
  const request = await completedRequest(trx, verificationId);
  if (request === null) return null;
  const target = await participantTarget(trx, request, normalizedEmail)
    ?? await shareTarget(trx, request, { normalizedEmail })
    ?? await accessRequestTarget(trx, request, { normalizedEmail });
  return target === null ? null : { request, target };
}

async function insertGrant(
  trx: Trx,
  verificationId: string,
  target: VerificationParticipantTarget,
  grant: NewVerificationAccessGrant,
  origin: { challengeId: string } | { userId: string },
  now: number,
): Promise<void> {
  await trx.insertInto("verification_access_grants").values({
    grant_id: grant.grantId,
    workspace_id: target.workspaceId,
    verification_id: verificationId,
    signing_request_id: target.signingRequestId,
    request_recipient_id: target.requestRecipientId,
    share_id: target.shareId,
    access_request_id: target.accessRequestId,
    access_basis: target.basis,
    token_digest: grant.tokenDigest,
    origin: "challengeId" in origin ? "code" : "member",
    challenge_id: "challengeId" in origin ? origin.challengeId : null,
    user_id: "userId" in origin ? origin.userId : null,
    expires_at: new Date(grant.expiresAt),
    created_at: new Date(now),
  }).execute();
}

/** The grant a token digest names, re-validated against a completed record. */
async function resolveGrant(
  trx: Trx, verificationId: string, tokenDigest: string, now: number,
): Promise<{ request: ResolvedRequest; target: VerificationParticipantTarget; expiresAt: number } | null> {
  await sql`select set_config(${GRANT_DIGEST_SETTING}, ${tokenDigest}, true)`.execute(trx);
  const grant = await trx
    .selectFrom("verification_access_grants")
    .where("token_digest", "=", tokenDigest)
    .select([
      "workspace_id", "verification_id", "signing_request_id",
      "request_recipient_id", "share_id", "access_request_id", "access_basis", "user_id",
      "expires_at",
    ])
    .executeTakeFirst();
  if (!grant) return null;
  // Another document's grant, or a dead one, is the same answer as none.
  if (grant.verification_id !== verificationId) return null;
  if (grant.expires_at.getTime() <= now) return null;

  const request = await completedRequest(trx, verificationId);
  if (request === null) return null;
  if (request.workspaceId !== grant.workspace_id
    || request.signingRequestId !== grant.signing_request_id) return null;

  // 087. The basis must STILL hold: a removed share, a withdrawn approval or
  // a lost membership ends the grant here, on its next use.
  let target: VerificationParticipantTarget | null = null;
  switch (grant.access_basis as VerificationAccessBasis) {
    case "participant": {
      if (grant.request_recipient_id === null) return null;
      const recipient = await trx
        .selectFrom("signing_request_recipients")
        .where("workspace_id", "=", request.workspaceId)
        .where("request_recipient_id", "=", grant.request_recipient_id)
        .select(["request_recipient_id", "name", "email", "recipient_type"])
        .executeTakeFirst();
      target = recipient ? toTarget(request, recipient) : null;
      break;
    }
    case "share":
      target = grant.share_id === null ? null
        : await shareTarget(trx, request, { shareId: grant.share_id });
      break;
    case "access-request":
      target = grant.access_request_id === null ? null
        : await accessRequestTarget(trx, request, { accessRequestId: grant.access_request_id });
      break;
    case "document-owner":
    case "workspace-administrator":
      target = grant.user_id === null ? null
        : await memberTarget(trx, request, grant.user_id, grant.access_basis as VerificationAccessBasis & (
          "document-owner" | "workspace-administrator"));
      break;
  }
  if (target === null) return null;
  return { request, target, expiresAt: grant.expires_at.getTime() };
}

export function createVerificationAccessStore(db: Kysely<Database>): VerificationAccessStore {
  const run = <T>(operation: (trx: Trx) => Promise<T>): Promise<T> =>
    db.transaction().execute(operation);

  return {
    issueChallenge(input, notify) {
      return run(async trx => {
        const found = await accessListByEmail(trx, input.verificationId, input.normalizedEmail);
        if (found === null) return false;

        // Serializes concurrent resends for one address on one document, so
        // the one-live-challenge index is never a race.
        await sql`select pg_advisory_xact_lock(hashtextextended(${
          `verification-access:${input.verificationId}:${input.normalizedEmail}`}, 0))`
          .execute(trx);

        await trx.updateTable("verification_access_challenges")
          .set({ superseded_at: new Date(input.now), sealed_code: null, sealed_key_version: null })
          .where("workspace_id", "=", found.request.workspaceId)
          .where("verification_id", "=", input.verificationId)
          .where("normalized_email", "=", input.normalizedEmail)
          .where("consumed_at", "is", null)
          .where("superseded_at", "is", null)
          .execute();

        await trx.insertInto("verification_access_challenges").values({
          challenge_id: input.challengeId,
          workspace_id: found.request.workspaceId,
          verification_id: input.verificationId,
          signing_request_id: found.request.signingRequestId,
          request_recipient_id: found.target.requestRecipientId,
          share_id: found.target.shareId,
          access_request_id: found.target.accessRequestId,
          normalized_email: input.normalizedEmail,
          code_digest: input.codeDigest,
          sealed_code: input.sealedCode,
          sealed_key_version: input.sealedKeyVersion,
          expires_at: new Date(input.expiresAt),
          consumed_at: null,
          superseded_at: null,
          created_at: new Date(input.now),
        }).execute();

        await notify(found.target, createNotificationRepository(trx), trx);
        return true;
      });
    },

    redeemChallenge(input) {
      return run(async trx => {
        const found = await accessListByEmail(trx, input.verificationId, input.normalizedEmail);
        if (found === null) return { outcome: "denied" as const };

        const challenge = await trx
          .selectFrom("verification_access_challenges")
          .where("workspace_id", "=", found.request.workspaceId)
          .where("verification_id", "=", input.verificationId)
          .where("normalized_email", "=", input.normalizedEmail)
          .where("consumed_at", "is", null)
          .where("superseded_at", "is", null)
          .select(["challenge_id", "code_digest", "attempts", "expires_at"])
          .forUpdate()
          .executeTakeFirst();
        if (!challenge) return { outcome: "denied" as const };
        if (challenge.expires_at.getTime() <= input.now) return { outcome: "denied" as const };
        if (challenge.attempts >= input.maxAttempts) return { outcome: "denied" as const };

        if (!input.matches(challenge.challenge_id, challenge.code_digest)) {
          const attempts = challenge.attempts + 1;
          await trx.updateTable("verification_access_challenges")
            .set({
              attempts,
              // Exhausted: the sealed copy goes too, so it can never be sent.
              ...(attempts >= input.maxAttempts
                ? { sealed_code: null, sealed_key_version: null } : {}),
            })
            .where("challenge_id", "=", challenge.challenge_id)
            .execute();
          return { outcome: "denied" as const };
        }

        await trx.updateTable("verification_access_challenges")
          .set({ consumed_at: new Date(input.now), sealed_code: null, sealed_key_version: null })
          .where("challenge_id", "=", challenge.challenge_id)
          .execute();
        await insertGrant(trx, input.verificationId, found.target, input.grant,
          { challengeId: challenge.challenge_id }, input.now);
        return { outcome: "granted" as const, target: found.target };
      });
    },

    issueMemberGrant(input) {
      return run(async trx => {
        const request = await completedRequest(trx, input.verificationId);
        if (request === null) return null;
        const email = input.normalizedEmail;
        const target = (email === null ? null : await participantTarget(trx, request, email))
          ?? await memberTarget(trx, request, input.userId)
          ?? (email === null ? null : await shareTarget(trx, request, { normalizedEmail: email }))
          ?? await accessRequestTarget(trx, request, { userId: input.userId });
        if (target === null) return null;
        // A share accepted by a different account than the one signed in is
        // still this address's share: the address is what was shared.
        await insertGrant(trx, input.verificationId, target, input.grant,
          { userId: input.userId }, input.now);
        return target;
      });
    },

    findDetails(input) {
      return run(async trx => {
        const resolved = await resolveGrant(trx, input.verificationId, input.tokenDigest, input.now);
        if (resolved === null) return null;
        const { request } = resolved;

        const seal = await trx.selectFrom("document_seals")
          .where("workspace_id", "=", request.workspaceId)
          .where("seal_id", "=", request.sealId)
          .select(["signed_document_hash"])
          .executeTakeFirst();
        if (!seal) return null;

        const participants = await trx.selectFrom("signing_request_recipients")
          .where("workspace_id", "=", request.workspaceId)
          .where("signing_request_id", "=", request.signingRequestId)
          .select(["request_recipient_id", "name", "email", "recipient_type",
            "routing_order", "order_index"])
          .orderBy("routing_order").orderBy("order_index")
          .execute();

        const events = await trx.selectFrom("evidence_events")
          .where("workspace_id", "=", request.workspaceId)
          .where("signing_request_id", "=", request.signingRequestId)
          .select(["event_type", "recipient_id", "occurred_at"])
          .orderBy("occurred_at").orderBy("evidence_event_id")
          .execute();

        return {
          target: resolved.target,
          expiresAt: resolved.expiresAt,
          documentTitle: request.documentTitle,
          completedAt: request.completedAt.getTime(),
          sealedDigest: seal.signed_document_hash,
          participants: participants.map(row => ({
            requestRecipientId: row.request_recipient_id,
            name: row.name,
            email: row.email,
            recipientType: row.recipient_type,
            routingOrder: row.routing_order,
            orderIndex: row.order_index,
          })),
          events: events.map(row => ({
            eventType: row.event_type,
            recipientId: row.recipient_id,
            occurredAt: row.occurred_at.getTime(),
          })),
        };
      });
    },

    findDocumentRef(input) {
      return run(async trx => {
        const resolved = await resolveGrant(trx, input.verificationId, input.tokenDigest, input.now);
        if (resolved === null) return null;
        const { request } = resolved;
        const seal = await trx.selectFrom("document_seals")
          .where("workspace_id", "=", request.workspaceId)
          .where("seal_id", "=", request.sealId)
          .select(["sealed_artifact_id"])
          .executeTakeFirst();
        if (!seal) return null;
        const artifact = await trx.selectFrom("document_artifacts")
          .where("workspace_id", "=", request.workspaceId)
          .where("artifact_id", "=", seal.sealed_artifact_id)
          .select(["storage_reference", "media_type", "size_bytes"])
          .executeTakeFirst();
        if (!artifact) return null;
        return {
          storageReference: artifact.storage_reference,
          mediaType: artifact.media_type,
          sizeBytes: Number(artifact.size_bytes),
        };
      });
    },
  };
}

/**
 * The notification worker's read of a live challenge's sealed code, inside
 * the delivery's own workspace. Null for consumed, superseded, expired and
 * exhausted alike — each suppresses the send.
 */
export async function findSealedVerificationAccessCode(
  db: Kysely<Database>,
  workspaceId: string,
  challengeId: string,
  now: number,
  maxAttempts: number,
): Promise<{ readonly sealed: string; readonly keyVersion: string } | null> {
  return db.transaction().execute(async trx => {
    await sql`select set_config(${WORKSPACE_SETTING}, ${workspaceId}, true)`.execute(trx);
    const row = await trx.selectFrom("verification_access_challenges")
      .where("challenge_id", "=", challengeId)
      .where("consumed_at", "is", null)
      .where("superseded_at", "is", null)
      .where("expires_at", ">", new Date(now))
      .where("attempts", "<", maxAttempts)
      .select(["sealed_code", "sealed_key_version"])
      .executeTakeFirst();
    if (!row || row.sealed_code === null || row.sealed_key_version === null) return null;
    return { sealed: row.sealed_code, keyVersion: row.sealed_key_version };
  });
}

