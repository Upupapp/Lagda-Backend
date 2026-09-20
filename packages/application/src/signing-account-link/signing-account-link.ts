// Binding a signed-in account to a recipient of a signing request.
//
// ── The account AUGMENTS the token; it never replaces it ──────────────────
//
// Access to a ceremony is still, and only, the 43-character credential from
// the emailed link. Signing in adds an identity to a recipient session that
// already exists. It cannot create one.
//
// That ordering is the whole safety property. If an account could open a
// ceremony on its own, a forwarded link plus a stranger's account would
// produce a signature carrying an authenticated identity. Keeping the token
// primary means an account can only ever strengthen attribution.
//
// ── Why two requests ──────────────────────────────────────────────────────
//
// The binding spans two credential realms and no transaction scope carries
// both identities. It is not merely awkward — it is not representable: there
// is one CSRF header name, read by both realms, and a closed CORS allowlist,
// so a single request cannot prove possession of two CSRF secrets.
//
//   mint     recipient realm  → a short-lived code, digested at rest
//   claim    workspace realm  → compares the account's VERIFIED address with
//                               the address the code carries, then binds
//
// ── Why the account's address must be verified ────────────────────────────
//
// `users.email_verified_at` is nullable. Without this check, someone could
// register an account with a victim's address, never verify it, and later
// satisfy the comparison with a forwarded link. Equality of addresses is only
// an identity claim if one of them was proved.
//
// Checked at BIND time rather than trusted from registration, because
// verification state can change and the binding is what it justifies.

import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../common/ports/index.js";
import type {
  SigningAccountLinkRepository,
} from "../common/ports/signing-account-link.js";

/**
 * Two minutes. Long enough to sign in, short enough that a code glimpsed on a
 * screen share is useless by the time anyone reads it back.
 */
const INTENT_TTL_MS = 120_000;

/** 128 bits, base64url. The same shape the other opaque credentials use. */
function mintCode(): string {
  return randomBytes(16).toString("base64url");
}

function digest(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export class SigningLinkNotClaimableError extends Error {
  constructor() {
    // ONE error for every failure: unknown code, expired code, already
    // claimed, wrong account, unverified address. A caller holding a code
    // must not be able to learn which of those is true — "wrong account" in
    // particular would confirm that some other account owns that address.
    super("This sign-in link could not be used. Open the signing link again and retry.");
    this.name = "SigningLinkNotClaimableError";
  }
}

export interface MintSigningLinkIntentDependencies {
  readonly clock: Clock;
  readonly links: SigningAccountLinkRepository;
  readonly ids: () => string;
}

export interface MintedSigningLinkIntent {
  /** Returned once, never stored. The caller hands it to the other realm. */
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * Called in the RECIPIENT realm, from an established ceremony session.
 *
 * Every field comes from the resolved session, not from the request body —
 * there is no parameter here a caller could steer.
 */
export async function mintSigningLinkIntent(
  context: {
    readonly workspaceId: string;
    readonly signingRequestId: string;
    readonly recipientId: string;
    readonly recipientNormalizedEmail: string;
  },
  deps: MintSigningLinkIntentDependencies,
): Promise<MintedSigningLinkIntent> {
  const now = new Date(deps.clock.now());
  const expiresAt = new Date(now.getTime() + INTENT_TTL_MS);
  const code = mintCode();

  await deps.links.createIntent({
    intentDigest: digest(code),
    workspaceId: context.workspaceId,
    signingRequestId: context.signingRequestId,
    recipientId: context.recipientId,
    recipientNormalizedEmail: context.recipientNormalizedEmail,
    createdAt: now,
    expiresAt,
  });

  return { code, expiresAt: expiresAt.getTime() };
}

export interface ClaimSigningLinkDependencies {
  readonly clock: Clock;
  readonly links: SigningAccountLinkRepository;
  readonly accounts: {
    /** The caller's own canonical address and whether it is proved. */
    findIdentity: (userId: string) => Promise<{
      readonly normalizedEmail: string;
      readonly emailVerifiedAt: Date | null;
    } | null>;
  };
  readonly ids: () => string;
}

export interface ClaimedSigningLink {
  readonly signingRequestId: string;
  readonly recipientId: string;
}

/**
 * Called in the WORKSPACE realm, by an authenticated account.
 *
 * The code is claimed first — a conditional UPDATE, so two requests racing the
 * same code produce exactly one winner. A code that fails the comparison
 * afterwards is NOT returned to the pool: a wrong guess burns it, which is
 * what stops a stolen code being tried against account after account.
 */
export async function claimSigningLink(
  userId: string,
  code: string,
  deps: ClaimSigningLinkDependencies,
): Promise<ClaimedSigningLink> {
  const now = new Date(deps.clock.now());

  const intent = await deps.links.claimIntent(digest(code), now);
  if (intent === null) throw new SigningLinkNotClaimableError();

  const identity = await deps.accounts.findIdentity(userId);
  if (identity === null) throw new SigningLinkNotClaimableError();
  if (identity.emailVerifiedAt === null) throw new SigningLinkNotClaimableError();
  if (identity.normalizedEmail !== intent.recipientNormalizedEmail) {
    throw new SigningLinkNotClaimableError();
  }

  await deps.links.createLink({
    signingAccountLinkId: deps.ids(),
    userId,
    workspaceId: intent.workspaceId,
    signingRequestId: intent.signingRequestId,
    recipientId: intent.recipientId,
    matchedNormalizedEmail: intent.recipientNormalizedEmail,
    linkedAt: now,
  });

  return {
    signingRequestId: intent.signingRequestId,
    recipientId: intent.recipientId,
  };
}
