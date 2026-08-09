// The session security service.
//
// Everything a route needs, with no transport in it: resolution, creation,
// rotation, revocation and CSRF validation. Fastify never reaches past this.

import type { UserId } from "@lagda/contracts";
import type {
  AuthenticatedActor, CsrfToken, RevocationReason, SessionId, SessionRecord,
  SessionRejection, SessionRepository, SessionResolution, SessionToken,
  SecurityTokenDigester, SecurityTokenGenerator,
} from "../common/ports/session.js";
import type { Clock } from "../common/ports/index.js";
import { ApplicationError } from "../common/errors/index.js";

/**
 * No session, or one that no longer authenticates.
 *
 * ONE public error for every rejection reason. A client that could distinguish
 * "expired" from "never existed" has an oracle for which tokens are real.
 */
export class AuthenticationRequiredError extends ApplicationError {
  readonly category = "authentication" as const;
  readonly code = "auth_required";

  constructor() {
    super("Authentication is required.");
  }
}

/** A valid session, but the CSRF token did not match. */
export class CsrfValidationError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "csrf_validation_failed";

  constructor() {
    super("The request could not be verified. Please retry from the application.");
  }
}

export interface SessionPolicy {
  /** The ceiling. A session dies at this point however active it has been. */
  readonly absoluteLifetimeMs: number;
  /** Sliding window. Handoff §3: "default 8 hours idle". */
  readonly idleTimeoutMs: number;
  /**
   * Minimum gap between `last_seen_at` writes.
   *
   * Without this, every authenticated request writes a row — turning a read
   * path into a write path and putting the database on the critical path of
   * every page load for no security gain. Precision of minutes is enough for an
   * 8-hour window.
   */
  readonly touchIntervalMs: number;
}

/**
 * The raw secrets, returned exactly ONCE at creation.
 *
 * Never stored, never re-derivable, never returned by a lookup. The caller puts
 * the session token in an httpOnly cookie and the CSRF token in a readable one,
 * and then both are gone from the server.
 */
export interface IssuedSession {
  readonly sessionId: SessionId;
  readonly sessionToken: SessionToken;
  readonly csrfToken: CsrfToken;
  readonly expiresAt: number;
}

export interface SessionServiceDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: SecurityTokenGenerator;
  readonly digester: SecurityTokenDigester;
  readonly clock: Clock;
  readonly policy: SessionPolicy;
}

/**
 * Bounds before any work happens.
 *
 * A megabyte cookie must be rejected before it reaches a digest and a database
 * lookup — otherwise an unauthenticated caller can spend server resources at
 * will. Generous enough for the real 43-character token.
 */
const MAX_TOKEN_LENGTH = 512;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function createSessionService(deps: SessionServiceDependencies) {
  const { sessions, tokens, digester, clock, policy } = deps;

  /** Structural rejection, before any I/O. */
  function malformed(token: string): boolean {
    return token.length === 0
      || token.length > MAX_TOKEN_LENGTH
      || !TOKEN_PATTERN.test(token);
  }

  return {
    /**
     * Resolves a raw credential to an actor.
     *
     * Returns a REJECTION rather than throwing for invalid credentials — an
     * anonymous request to a public route is not exceptional. A repository
     * failure, by contrast, propagates: the database being down must not be
     * reported as "you are not logged in" (INV-153).
     */
    async resolve(rawToken: string): Promise<SessionResolution> {
      if (malformed(rawToken)) {
        return { outcome: "rejected", reason: "malformed" };
      }

      const tokenHash = digester.digestSessionToken(rawToken as SessionToken);
      // Deliberately NOT wrapped in try/catch. A thrown repository error means
      // the database is unavailable, and swallowing it here would log every
      // user out during an outage.
      const session = await sessions.findByTokenHash(tokenHash);

      if (session === null) return { outcome: "rejected", reason: "unknown" };

      const rejection = invalidReason(session, clock.now(), policy.idleTimeoutMs);
      if (rejection !== null) return { outcome: "rejected", reason: rejection };

      const actor: AuthenticatedActor = {
        actorType: "user",
        userId: session.userId,
        sessionId: session.sessionId,
      };
      return { outcome: "authenticated", actor, session };
    },

    /**
     * Slides the idle window, at most once per `touchIntervalMs`.
     *
     * Failure is swallowed here and ONLY here: a missed `last_seen_at` write
     * shortens a session by minutes, while failing the request would turn a
     * bookkeeping problem into an outage. The caller is told nothing because
     * there is nothing it could usefully do.
     */
    async touchIfDue(session: SessionRecord): Promise<void> {
      const now = clock.now();
      if (now - session.lastSeenAt < policy.touchIntervalMs) return;
      try {
        await sessions.touch(session.sessionId, now);
      } catch {
        // Intentionally ignored — see above.
      }
    },

    /**
     * Creates a session and returns its secrets once.
     *
     * The record is durably written BEFORE the secrets are handed back, so a
     * cookie can never be issued for a session that does not exist (§143).
     */
    async issue(userId: UserId): Promise<IssuedSession> {
      const now = clock.now();
      const sessionToken = tokens.nextSessionToken();
      const csrfToken = tokens.nextCsrfToken();
      const sessionId = tokens.nextSessionId();
      const expiresAt = now + policy.absoluteLifetimeMs;

      await sessions.create({
        sessionId,
        userId,
        tokenHash: digester.digestSessionToken(sessionToken),
        csrfTokenHash: digester.digestCsrfToken(csrfToken),
        createdAt: now,
        expiresAt,
      });

      return { sessionId, sessionToken, csrfToken, expiresAt };
    },

    /**
     * Replaces a session's credential — the defence against session fixation.
     *
     * A NEW session is created and the old one revoked, rather than the old row
     * being updated in place. That keeps the revocation visible in security
     * history and means the two credentials are never simultaneously valid
     * through some intermediate state.
     *
     * BACKEND-20 calls this on login; a pre-auth credential is never simply
     * marked authenticated (§23).
     */
    async rotate(current: SessionRecord): Promise<IssuedSession> {
      const issued = await this.issue(current.userId);
      await sessions.revoke(current.sessionId, clock.now(), "rotation");
      return issued;
    },

    async revoke(sessionId: SessionId, reason: RevocationReason): Promise<void> {
      await sessions.revoke(sessionId, clock.now(), reason);
    },

    /** For password reset and security actions. */
    async revokeAllForUser(userId: UserId, reason: RevocationReason): Promise<number> {
      return sessions.revokeAllForUser(userId, clock.now(), reason);
    },

    /**
     * Validates a submitted CSRF token against the session that must own it.
     *
     * Session-bound, so a token minted for session A cannot validate session B —
     * which a bare double-submit cookie scheme permits, because it only checks
     * that a cookie and a header agree and an attacker able to set a cookie
     * controls both.
     *
     * Compared as DIGESTS, timing-safely.
     */
    validateCsrf(session: SessionRecord, submitted: string | undefined): void {
      if (submitted === undefined || malformed(submitted)) {
        throw new CsrfValidationError();
      }
      const submittedHash = digester.digestCsrfToken(submitted as CsrfToken);
      if (!digester.matches(submittedHash, session.csrfTokenHash)) {
        throw new CsrfValidationError();
      }
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

/**
 * Why a stored session no longer authenticates, or `null` if it still does.
 *
 * Expiry is DERIVED from timestamps rather than written to a status column, so
 * nothing has to run to make a session expire. A background job that failed
 * would otherwise leave sessions valid past their expiry.
 */
function invalidReason(
  session: SessionRecord,
  now: number,
  idleTimeoutMs: number,
): SessionRejection | null {
  if (session.revokedAt !== undefined) return "revoked";
  if (now >= session.expiresAt) return "expired";
  // Idle expiry is checked HERE, in the resolution path, not exposed as a
  // helper a caller might forget to apply. Handoff §3 makes it a product
  // requirement ("default 8 hours idle"), so a session that passes the absolute
  // check can still be dead.
  if (now - session.lastSeenAt >= idleTimeoutMs) return "idle-expired";
  return null;
}
