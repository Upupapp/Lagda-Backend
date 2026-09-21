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

import { randomBytes } from "node:crypto";
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

/**
 * Digesting a handoff code is a CREDENTIAL digest, and credential digests are
 * domain-separated in one place — `api/security/crypto` — so that two token
 * types which happen to be the same string cannot produce the same digest.
 *
 * Taken as a port rather than computed here. An architecture test asserts
 * `createHash` appears in a small allowlist of files with stated domains, and
 * the honest way past it is to use the module that owns the domain, not to
 * lengthen the list.
 */
export interface HandoffCodeDigester {
  digestHandoffCode: (code: string) => string;
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
  readonly codes: HandoffCodeDigester;
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
    /** Whatever the claim produces is bound back to this session. */
    readonly recipientSessionId: string;
  },
  deps: MintSigningLinkIntentDependencies,
): Promise<MintedSigningLinkIntent> {
  const now = new Date(deps.clock.now());
  const expiresAt = new Date(now.getTime() + INTENT_TTL_MS);
  const code = mintCode();

  await deps.links.createIntent({
    intentDigest: deps.codes.digestHandoffCode(code),
    workspaceId: context.workspaceId,
    signingRequestId: context.signingRequestId,
    recipientId: context.recipientId,
    recipientNormalizedEmail: context.recipientNormalizedEmail,
    recipientSessionId: context.recipientSessionId,
    createdAt: now,
    expiresAt,
  });

  return { code, expiresAt: expiresAt.getTime() };
}

export interface ClaimSigningLinkDependencies {
  readonly clock: Clock;
  readonly codes: HandoffCodeDigester;
  readonly links: SigningAccountLinkRepository;
  readonly accounts: {
    /** The caller's own canonical address and whether it is proved. */
    findIdentity: (userId: string) => Promise<{
      readonly normalizedEmail: string;
      readonly emailVerifiedAt: Date | null;
    } | null>;
  };
  /**
   * Re-proves the password, for the step-up.
   *
   * A session alone is not enough here. Claiming hands a stored signature to
   * a ceremony, and from that moment one confirmation applies someone's
   * handwriting to a binding document. That turns a stolen session from "read
   * my documents" into "sign as me", which is a different category of loss,
   * and the control that matches it is re-proving the password at the moment
   * the capability is granted — not at every use, which would train people to
   * type it without reading.
   */
  readonly verifyPassword: (
    userId: string, password: string,
  ) => Promise<boolean>;
  /**
   * Hands the account's saved marks to this one ceremony.
   *
   * Optional: an account with nothing saved still binds, and still gets
   * "Signed in as ..." in the ceremony. It simply has nothing to apply.
   */
  readonly handOverSavedSignatures: (input: {
    readonly userId: string;
    readonly signingRequestId: string;
    readonly recipientId: string;
    /** Bound to the session that asked, never to the recipient at large. */
    readonly recipientSessionId: string;
    readonly at: Date;
  }) => Promise<number>;
  readonly ids: () => string;
}

export interface ClaimedSigningLink {
  readonly signingRequestId: string;
  readonly recipientId: string;
  /** How many saved marks were handed over. Zero is an ordinary outcome. */
  readonly preparedCount: number;
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
  password: string,
  deps: ClaimSigningLinkDependencies,
): Promise<ClaimedSigningLink> {
  const now = new Date(deps.clock.now());

  const intent = await deps.links.claimIntent(deps.codes.digestHandoffCode(code), now);
  if (intent === null) throw new SigningLinkNotClaimableError();

  // The step-up, AFTER the code is claimed and therefore burned.
  //
  // Deliberately in that order. If a wrong password left the code usable, a
  // stolen code could be retried against one account after another until one
  // of the guesses landed — the burn is what makes each code exactly one
  // attempt, and moving this check earlier would give that back.
  if (!await deps.verifyPassword(userId, password)) {
    throw new SigningLinkNotClaimableError();
  }

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

  // The handoff: workspace -> ceremony, pushed once, at a moment the account
  // holder chose and just re-authenticated for. The ceremony never reaches
  // back the other way.
  const preparedCount = await deps.handOverSavedSignatures({
    userId,
    signingRequestId: intent.signingRequestId,
    recipientId: intent.recipientId,
    recipientSessionId: intent.recipientSessionId,
    at: now,
  });

  return {
    signingRequestId: intent.signingRequestId,
    recipientId: intent.recipientId,
    preparedCount,
  };
}

// ── The route-facing halves ────────────────────────────────────────────────

/**
 * Mints an intent for the recipient whose session this is.
 *
 * Takes the RAW session token and resolves it here, so the ceremony's own
 * identity is the only source of the workspace, request, recipient and
 * address. There is no parameter a request body could steer — the caller
 * supplies a credential and nothing else.
 */
export async function requestSigningLinkIntent(
  rawSessionToken: string,
  deps: MintSigningLinkIntentDependencies & {
    readonly resolveSession: (raw: string) => Promise<{
      readonly workspaceId: string;
      readonly signingRequestId: string;
      readonly recipientId: string;
      readonly signingSessionId: string;
    }>;
    /** The recipient's delivery address, from the immutable snapshot. */
    readonly readRecipientEmail: (raw: string) => Promise<string>;
    readonly normalize: (raw: string) => string | null;
  },
): Promise<MintedSigningLinkIntent> {
  const context = await deps.resolveSession(rawSessionToken);
  const email = await deps.readRecipientEmail(rawSessionToken);

  const normalized = deps.normalize(email);
  // A snapshot address that will not normalize cannot be compared with an
  // account's, so there is nothing to offer. Refused rather than bound to a
  // value nobody could match.
  if (normalized === null) throw new SigningLinkNotClaimableError();

  return mintSigningLinkIntent({
    workspaceId: context.workspaceId,
    signingRequestId: context.signingRequestId,
    recipientId: context.recipientId,
    recipientNormalizedEmail: normalized,
    recipientSessionId: context.signingSessionId,
  }, deps);
}

/** Whether this recipient is bound, for the ceremony view. */
export async function readSigningAccountLink(
  signingRequestId: string,
  recipientId: string,
  deps: { readonly links: SigningAccountLinkRepository },
): Promise<{ readonly linked: true; readonly maskedEmail: string } | { readonly linked: false }> {
  const link = await deps.links.findLinkForRecipient(signingRequestId, recipientId);
  if (link === null) return { linked: false };
  // MASKED on the way out. The ceremony already showed this recipient their
  // own address, but a view that echoes a full address is one refactor away
  // from echoing it somewhere it was not already known.
  return { linked: true, maskedEmail: maskEmail(link.matchedNormalizedEmail) };
}

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "•••";
  const first = value.slice(0, 1);
  return `${first}${"•".repeat(Math.max(1, at - 1))}${value.slice(at)}`;
}
