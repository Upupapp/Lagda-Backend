// Final-copy download credentials (073).
//
// When a request completes, each participant who took part — and each copy
// recipient — may be emailed a personal link to the FINAL signed PDF. The
// link is its own credential: its own digest domain, its own table, its own
// transaction realm. It can do exactly one thing, and that thing is not
// signing: signing links are revoked at completion and must stay revoked.

import type { WorkspaceId } from "@lagda/contracts";
import type { SigningRequestId, SigningRequestRecipientId } from "./signing-requests.js";
import type { ScopedArtifactRepository, ScopedFinalizationRepository } from "./evidence.js";
import type { WorkspaceUnitOfWork } from "./index.js";

export type FinalCopyDigest = string & { readonly __brand: "FinalCopyDigest" };
export type FinalCopyGrantId = string & { readonly __brand: "FinalCopyGrantId" };

/** Same shape as the signing factory; a DIFFERENT digest domain. */
export interface FinalCopyTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: FinalCopyDigest };
  /** Null for anything that cannot be a credential. */
  readonly digest: (submitted: string) => FinalCopyDigest | null;
}

export interface FinalCopyGrantIdGenerator {
  nextFinalCopyGrantId(): FinalCopyGrantId;
}

export interface NewFinalCopyGrant {
  readonly grantId: FinalCopyGrantId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly credentialDigest: FinalCopyDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Workspace-scoped, beside the finalization that mints the grants. */
export interface ScopedFinalCopyRepository {
  /**
   * Returns false when this recipient already holds one — a re-driven
   * completion converges instead of minting a second key.
   */
  insertGrant(grant: NewFinalCopyGrant): Promise<boolean>;
  /** For the delivery worker: is the credential this email carries alive? */
  isGrantUsable(grantId: string, now: number): Promise<boolean>;
}

/** What a presented credential resolves to, before any tenant context. */
export interface ResolvedFinalCopyGrant {
  readonly grantId: FinalCopyGrantId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface FinalCopyCredentialLookupRepository {
  findByCredentialDigest(digest: FinalCopyDigest): Promise<ResolvedFinalCopyGrant | null>;
}

/**
 * The realm's unit of work. After the grant resolves, the workspace it names
 * is entered — and handed only what a download reads: the request, its
 * finalization, the artifact. Nothing that writes.
 */
export interface FinalCopyCredentialUnitOfWork {
  readonly lookup: FinalCopyCredentialLookupRepository;
  enterWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: FinalCopyWorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export interface FinalCopyWorkspaceUnitOfWork {
  readonly signingRequests: Pick<WorkspaceUnitOfWork["signingRequests"], "find">;
  readonly finalizations: Pick<ScopedFinalizationRepository, "findBySigningRequest">;
  readonly artifacts: Pick<ScopedArtifactRepository, "find">;
}
