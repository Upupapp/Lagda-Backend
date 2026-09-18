// ID generators the completion pipeline needs, shared by both process roles.
//
// `packages/api/src/security/identifiers.ts` already implements every one of
// these (and many more) for the API's own composition — but that file lives
// in `@lagda/api`, which the worker does not and must not depend on (see this
// package's own header comment for why: pulling in Fastify, helmet, cookies
// etc. for a process that never listens on a port). The completion pipeline
// is the first thing the WORKER itself needs to mint new domain ids for, so
// exactly the generators it needs are mirrored here — same `mint()` shape,
// same prefixes, so an id minted by the worker is indistinguishable in
// storage from one minted by the API. The API's own file is intentionally
// left untouched: duplicating a handful of one-line factories here is lower
// risk than re-pointing an already-working, already-deployed composition
// root at a new import.

import { randomUUID, randomBytes } from "node:crypto";
import type { WorkspaceId, VerificationId } from "@lagda/contracts";
import type {
  ArtifactIdGenerator, ArtifactId,
  SealIdGenerator, SealId,
  CompletionIdGenerator, CompletionRunId, CompletionStepId,
  EvidenceEventIdGenerator, EvidenceEventId,
  VerificationIdGenerator,
  NotificationIntentIdGenerator, NotificationIntentId,
  NotificationDeliveryIdGenerator, NotificationDeliveryId,
} from "@lagda/application";

function mint(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function createArtifactIdGenerator(): ArtifactIdGenerator {
  return { nextArtifactId: () => mint("art") as ArtifactId };
}

export function createSealIdGenerator(): SealIdGenerator {
  return { nextSealId: () => mint("seal") as SealId };
}

export function createCompletionIdGenerator(): CompletionIdGenerator {
  return {
    nextCompletionRunId: () => mint("crun") as CompletionRunId,
    nextCompletionStepId: () => mint("cstp") as CompletionStepId,
  };
}

export function createEvidenceEventIdGenerator(): EvidenceEventIdGenerator {
  return { nextEvidenceEventId: () => mint("ev") as EvidenceEventId };
}

// ── Notification ids ────────────────────────────────────────────────────────
//
// Mirrored here for the same reason as the rest of this file, and needed for
// the same new reason: BACKEND-38's completion notification is produced INSIDE
// the finalization transaction, which runs in the worker. Until now the worker
// only ever DELIVERED notifications the API had created, so it needed no way
// to mint one.
//
// Same prefixes as `packages/api/src/security/identifiers.ts`, so an intent
// minted by the worker is indistinguishable in storage from one minted by the
// API — which matters here more than elsewhere, because `SIGNING_INVITATION`
// intents come from the API and `SIGNING_COMPLETED` intents come from the
// worker, and both live in one table that operators read by eye.

export function createNotificationIntentIdGenerator(): NotificationIntentIdGenerator {
  return { nextNotificationIntentId: () => mint("nint") as NotificationIntentId };
}

export function createNotificationDeliveryIdGenerator(): NotificationDeliveryIdGenerator {
  return {
    nextNotificationDeliveryId: () => mint("ndel") as NotificationDeliveryId,
  };
}

// ── Verification id — mirrors packages/api/src/security/verification-id.ts ──
//
// Published (a completed document's own certificate carries it), so it must
// be unguessable rather than merely unique — see that file's own comment for
// the full reasoning. The alphabet, length and rejection-sampling approach are
// copied exactly so a reference minted by either process role parses
// identically against the product's `VER_ID_RE`.

const VERIFICATION_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const VERIFICATION_SUFFIX_LENGTH = 10;

function randomVerificationSuffix(length: number): string {
  const limit = Math.floor(256 / VERIFICATION_ALPHABET.length) * VERIFICATION_ALPHABET.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += VERIFICATION_ALPHABET[byte % VERIFICATION_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function createVerificationIdGenerator(): VerificationIdGenerator {
  return {
    nextVerificationId(_workspaceId: WorkspaceId, at: number): VerificationId {
      const year = new Date(at).getUTCFullYear();
      return `LAGDA-VER-${String(year)}-${randomVerificationSuffix(VERIFICATION_SUFFIX_LENGTH)}` as VerificationId;
    },
  };
}
