// Recipient signing access (BACKEND-34).
//
// ── What this turns into what ──────────────────────────────────────────────
//
//   raw bootstrap credential (from an email link)
//        -> digest
//        -> the ONE access grant that matches
//        -> its request, its recipient, its activation row
//        -> validate all five conditions
//        -> a fresh RecipientSigningSession
//
// ── The authentication policy ──────────────────────────────────────────────
//
// LINK_ONLY. Possession of the bootstrap credential IS the ceremony, which is
// the product's own default (`DEFAULT_AUTH_CONFIG.defaultMethod = "none"`,
// labelled "Secure Invitation Link").
//
// What that establishes, precisely: the caller holds a credential that was
// emailed to a specific address. It does NOT establish that they control that
// mailbox, that they are the named person, or anything a court would call
// identity verification. RECIPIENT_AUTHENTICATION_POLICY.md says so in those
// words, and the session records `link-only` rather than a stronger claim.
//
// ── The second realm ───────────────────────────────────────────────────────
//
// A recipient signing session is not a LAGDA user session. It confers no
// membership, no role, no capability, and reaches no workspace surface. The
// two cookies coexist and neither implies the other.

import type { WorkspaceId } from "@lagda/contracts";
import type {
  Clock, TransactionManager,
  SigningRequestId, SigningRequestRecipientId,
  SigningAccessTokenFactory, SigningAccessGrantId,
  RecipientSessionTokenFactory, RecipientSigningSessionIdGenerator,
  RecipientSigningSessionId, RecipientAuthenticationMethod,
  ResolvedSigningAccess,
} from "../common/ports/index.js";
import { ApplicationError } from "../common/errors/index.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The link cannot be used, and the caller learns nothing about why.
 *
 * ── One error for six causes, deliberately ─────────────────────────────────
 *
 * Unknown credential, expired grant, revoked grant, a request that is not
 * sent, a recipient/request mismatch — all of them collapse here. Separate
 * errors would turn a public endpoint into an oracle: "expired" tells an
 * attacker the credential was real, and "not sent" tells them a request
 * exists.
 *
 * Routing is the ONE exception, below, and only because a recipient who
 * legitimately holds a link and is genuinely waiting deserves an answer they
 * can act on.
 */
export class SigningLinkInvalidOrExpiredError extends ApplicationError {
  readonly category = "authentication" as const;
  readonly code = "invalid_or_expired_signing_link";
  constructor() {
    super("This signing link is no longer valid.");
  }
}

/**
 * The recipient's turn has not come.
 *
 * Distinct from the collapsed error because it is actionable and reveals
 * nothing an attacker could not already infer from holding a valid credential.
 * It names no other recipient and no position in the sequence.
 *
 * Defence in depth: BACKEND-33 does not mint credentials for waiting
 * recipients, so reaching this means a grant outlived a routing change.
 */
export class SigningAccessNotActiveError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_access_not_active";
  constructor() {
    super("This document is not ready for you yet.");
  }
}

/** An established session that has expired or been revoked. */
export class RecipientSessionInvalidError extends ApplicationError {
  readonly category = "authentication" as const;
  readonly code = "recipient_session_invalid";
  constructor() {
    super("Your signing session has ended. Open your email link again.");
  }
}

// ── The trusted context ──────────────────────────────────────────────────────

/**
 * Who is asking, resolved entirely from server state.
 *
 * ── Read what is NOT here ──────────────────────────────────────────────────
 *
 * No `WorkspaceRole`, no `WorkspaceMembershipId`, no `UserId`. A recipient has
 * none of those, and a context that carried an empty one would invite a
 * `hasCapability` call that always returned false — which looks like
 * authorization and is not.
 *
 * `workspaceId` IS here, because a recipient's reads are tenant rows and the
 * transaction needs a scope. It is not authority: nothing consults it to
 * decide what the recipient may do.
 */
export interface RecipientSigningContext {
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly workspaceId: WorkspaceId;
  readonly signingSessionId: RecipientSigningSessionId;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly sourceGrantId: SigningAccessGrantId;
}

/** What a landing page may show once a session exists. */
export interface RecipientSigningView {
  readonly signingRequestId: string;
  readonly documentTitle: string;
  /** The recipient's own name, from the immutable snapshot. */
  readonly recipientName: string;
  /** MASKED. `m***@example.com` — enough to confirm, not enough to harvest. */
  readonly maskedEmail: string;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly authenticatedAt: number;
}

/** What bootstrap returns, alongside the cookie the route sets. */
export interface BootstrappedSigningAccess {
  readonly context: RecipientSigningContext;
  readonly view: RecipientSigningView;
  /**
   * The RAW credentials, for the route to put in cookies and nowhere else.
   *
   * Returned rather than set here because the application layer must not know
   * what a cookie is. The route sets them and drops them; neither is logged,
   * echoed in a body, or persisted anywhere but as a digest.
   */
  readonly credentials: {
    readonly rawSessionToken: string;
    readonly rawCsrfToken: string;
    readonly expiresAt: number;
  };
}

export interface RecipientSessionPolicy {
  /**
   * How long an authenticated signing session lasts.
   *
   * Absolute only. No idle timeout: a signing session is short by
   * construction, and touching a row on every request buys nothing against a
   * lifetime already measured in hours.
   */
  readonly sessionLifetimeMs: number;
}

export interface SigningAccessDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  /** BACKEND-33's factory. The same digest domain, so the same credentials. */
  readonly bootstrapTokens: SigningAccessTokenFactory;
  readonly sessionTokens: RecipientSessionTokenFactory;
  readonly ids: RecipientSigningSessionIdGenerator;
  readonly policy: RecipientSessionPolicy;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Exchanges an emailed bootstrap credential for a recipient signing session.
 *
 * ── Why this is a POST and never a GET ─────────────────────────────────────
 *
 * Email security gateways, link previews and corporate scanners fetch links
 * before a human ever sees them. If a GET performed this exchange, a scanner
 * would authenticate the recipient — and under a one-time credential model,
 * would consume the only link the recipient had.
 *
 * So the emailed link targets a FRONTEND route that renders. Nothing changes
 * until an explicit POST arrives. SIGNING_LINK_SCANNER_SAFETY.md states the
 * whole flow.
 *
 * ── The credential is reusable ─────────────────────────────────────────────
 *
 * Not consumed here. The product's recipient flow loses its state on every
 * page reload, and there is no resend operation — a one-time credential would
 * lock a signer out of their own document permanently. Each exchange mints an
 * INDEPENDENT session, so the session surface stays small even though the link
 * stays usable. OD-141 records it so a product decision can reverse it.
 */
export async function bootstrapSigningAccess(
  rawCredential: string,
  deps: SigningAccessDependencies,
): Promise<BootstrappedSigningAccess> {
  // Structural rejection BEFORE any database work. A signing surface is public
  // and will be sprayed; a wrong-shaped value costs a regex.
  const digest = deps.bootstrapTokens.digest(rawCredential);
  if (digest === null) throw new SigningLinkInvalidOrExpiredError();

  const now = deps.clock.now();

  return deps.transactions.runForSigningCredential(digest, async credential => {
    const resolved = await credential.access.findByCredentialDigest(digest);
    // Unknown credential. Indistinguishable from every other failure below.
    if (resolved === null) throw new SigningLinkInvalidOrExpiredError();

    assertUsable(resolved, now);

    // The tenant transition, on the SAME transaction, using the workspace the
    // GRANT resolved. No parameter a request body could reach.
    return credential.enterWorkspace(resolved.workspaceId, async uow => {
      // A FRESH credential pair. Never the bootstrap token promoted, never
      // derived from it — a session token that was a function of the emailed
      // link would inherit the link's exposure.
      const issued = deps.sessionTokens.issue();
      const signingSessionId = deps.ids.nextRecipientSigningSessionId();
      const expiresAt = now + deps.policy.sessionLifetimeMs;

      await uow.recipientSessions.insert({
        signingSessionId,
        workspaceId: resolved.workspaceId,
        signingRequestId: resolved.signingRequestId,
        recipientId: resolved.recipientId,
        sourceGrantId: resolved.grantId,
        // Digests only.
        tokenDigest: issued.tokenDigest,
        csrfTokenDigest: issued.csrfDigest,
        // The exact method. Not "verified", not "identity confirmed".
        authenticationMethod: "link-only",
        authenticatedAt: now,
        createdAt: now,
        expiresAt,
      });

      return {
        context: {
          signingRequestId: resolved.signingRequestId,
          recipientId: resolved.recipientId,
          workspaceId: resolved.workspaceId,
          signingSessionId,
          authenticationMethod: "link-only" as const,
          sourceGrantId: resolved.grantId,
        },
        view: {
          signingRequestId: resolved.signingRequestId,
          documentTitle: resolved.documentTitle,
          recipientName: resolved.recipientName,
          maskedEmail: maskEmail(resolved.recipientEmail),
          authenticationMethod: "link-only" as const,
          authenticatedAt: now,
        },
        credentials: {
          rawSessionToken: issued.rawToken,
          rawCsrfToken: issued.rawCsrfToken,
          expiresAt,
        },
      };
    });
  });
}

/**
 * Every condition a credential must satisfy, in one place.
 *
 * Order matters only for which error surfaces: routing is checked LAST, so a
 * caller holding a revoked credential for a waiting recipient gets the
 * collapsed error rather than the informative one.
 */
function assertUsable(resolved: ResolvedSigningAccess, now: number): void {
  if (resolved.grantRevokedAt !== null) throw new SigningLinkInvalidOrExpiredError();
  // Derived from the clock, never a stored `is_expired` column — a status
  // someone has to remember to update is a status that will be wrong.
  if (resolved.grantExpiresAt <= now) throw new SigningLinkInvalidOrExpiredError();

  // A DRAFT request must never be reachable from a link. BACKEND-33 does not
  // mint credentials before sending, so this is defence in depth — and it is
  // also what will refuse `cancelled`, `completed` and `expired` the day those
  // states exist, without another edit here.
  if (resolved.requestState !== "sent") throw new SigningLinkInvalidOrExpiredError();

  // Routing. NULL means send never wrote an activation row, which is not a
  // state the system produces — treated as ineligible rather than as
  // permission.
  if (resolved.activationState !== "active") throw new SigningAccessNotActiveError();
}

/**
 * `maria.santos@example.com` becomes `m***@example.com`.
 *
 * Enough for a recipient to confirm the link reached the right inbox, not
 * enough for someone holding a forwarded link to harvest an address. The
 * domain is kept because it is the part that makes the confirmation useful and
 * the part least likely to identify an individual.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}

// ── Session resolution ───────────────────────────────────────────────────────

/**
 * Resolves a recipient session cookie into a trusted context.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not re-check request state. A session says who is asking; whether
 * the request is still signable is a question each sensitive operation must
 * ask for itself, because the answer changes while a session lives.
 * §129/§130 — the eligibility must not be cached in a cookie.
 */
export async function resolveRecipientSession(
  rawSessionToken: string,
  deps: SigningAccessDependencies,
): Promise<RecipientSigningContext> {
  const digest = deps.sessionTokens.digestToken(rawSessionToken);
  if (digest === null) throw new RecipientSessionInvalidError();

  const now = deps.clock.now();

  return deps.transactions.runForRecipientSession(digest, async uow => {
    const session = await uow.session.findByTokenDigest(digest);
    if (session === null) throw new RecipientSessionInvalidError();
    if (session.revokedAt !== null) throw new RecipientSessionInvalidError();
    if (session.expiresAt <= now) throw new RecipientSessionInvalidError();

    return {
      signingRequestId: session.signingRequestId,
      recipientId: session.recipientId,
      workspaceId: session.workspaceId,
      signingSessionId: session.signingSessionId,
      authenticationMethod: session.authenticationMethod,
      sourceGrantId: session.sourceGrantId,
    };
  });
}

/**
 * Validates a submitted recipient CSRF token against its own session.
 *
 * ── Realm-bound by construction ────────────────────────────────────────────
 *
 * The comparison is against `session.csrfTokenDigest`, and the digest domain
 * is the recipient CSRF domain. So a normal user-session CSRF token cannot
 * satisfy this: it digests under a different domain and would not match even
 * if it were the same string.
 */
export async function validateRecipientCsrf(
  rawSessionToken: string,
  submittedCsrfToken: string,
  deps: SigningAccessDependencies,
): Promise<boolean> {
  const sessionDigest = deps.sessionTokens.digestToken(rawSessionToken);
  const csrfDigest = deps.sessionTokens.digestCsrf(submittedCsrfToken);
  if (sessionDigest === null || csrfDigest === null) return false;

  return deps.transactions.runForRecipientSession(sessionDigest, async uow => {
    const session = await uow.session.findByTokenDigest(sessionDigest);
    if (session === null) return false;
    return session.csrfTokenDigest === csrfDigest;
  });
}

/**
 * Deliberately absent from this module.
 *
 * **Any OTP.** LINK_ONLY is the implemented policy and the product's default;
 * SIGNING_ACCESS_PRODUCT_INVENTORY.md gives the three reasons a code cannot be
 * built today, the decisive one being that nothing could deliver it.
 *
 * **Anything a recipient DOES.** No viewed, no consent, no field value, no
 * signature, no decline, no completion, no sealing. Authenticating is not
 * viewing, viewing is not consenting, and neither is signing. BACKEND-35+.
 *
 * **Account matching.** A recipient email that matches a LAGDA account is not
 * that account, and nothing here looks.
 *
 * **Revocation operations.** The columns, the reasons and the index exist;
 * nothing calls them until BACKEND-46 expires a request.
 */
export type SigningAccessOperationsDeferred = never;
