// The identity surface, built from real infrastructure.
//
// Seventeen use-case graphs plus the four functions the route layer needs to
// issue, read and end a session. Until now every one of them existed only in
// `infra/dev-server.ts`, against `InMemoryIdentity` -- so a deployment had 38
// published identity paths and no route that could issue a session.
//
// Kept out of `start-server.ts` deliberately. Composed inline it would be four
// times the length of everything else in that file, and the thing that file
// exists to make readable is WHICH groups a deployment serves.

import {
  createUserRepository, createVerificationChallengeRepository,
  createVerificationRepository, createVerifiableUserRepository,
  createPasswordResetRepository, createPasswordResettableUserRepository,
  createUserAdopter,
  createMfaFactorRepository, createRecoveryCodeRepository,
  createPendingAuthenticationRepository,
  createAccountProfileRepository, createAccountCredentialRepository,
  createAccountSessionRepository, createSessionRepository,
  type LagdaDatabase,
} from "@lagda/db";
import type {
  SessionService, UserId, PasswordHash, SessionId,
} from "@lagda/application";
import {
  createTemplateRegistry, ALL_TEMPLATES,
  createVerificationNotificationProducer, createResetNotificationProducer,
} from "@lagda/application";
import { createFirebaseVerificationAdmin } from "@lagda/firebase-admin";
import type { ApiConfig } from "../config/index.js";
import type { AppDependencies } from "../app/dependencies.js";
import type { RequestAuth } from "../security/session-plugin.js";
import { createArgon2PasswordHasher } from "../security/password-hasher.js";
import {
  createVerificationTokenFactory, digestSubmittedCode,
} from "../security/verification-token.js";
import {
  createResetTokenFactory, digestSubmittedResetToken,
} from "../security/reset-token.js";
import { createSecretBox } from "@lagda/security";
import { createPreAuthCredentialFactory } from "../security/pre-auth-token.js";
import { createDeliverySecretSealer } from "../security/signing-delivery.js";
import {
  generateTotpSecret, buildProvisioningUri, verifyTotp, isWellFormedTotpCode,
} from "../security/totp.js";
import {
  issueRecoveryCodes, digestSubmittedRecoveryCode,
} from "../security/recovery-codes.js";
import {
  nextUserId, nextVerificationChallengeId, nextPasswordResetChallengeId,
  nextMfaFactorId, nextRecoveryCodeId, nextPendingAuthenticationId,
  createNotificationIntentIdGenerator, createNotificationDeliveryIdGenerator,
  createRecipientSigningSessionIdGenerator,
} from "../security/identifiers.js";
import { createUserSignatureRepository, createNotificationFeedRepository } from "@lagda/db";
import { createSignatureImageValidator } from "../security/signature-image.js";
import { randomUUID } from "node:crypto";
import {
  claimSigningLink, normalizeEmail, beginInAppSigning,
  presentInboxItem, presentSignedDocument,
} from "@lagda/application";
import {
  createSigningAccountLinkRepository, createPreparedSignatureRepository,
  createUserSigningRecordsRepository, createSigningResumeIntentRepository,
} from "@lagda/db";
import { createHandoffCodeDigester } from "../security/crypto.js";

/**
 * The RLS setting a transaction sets to act as one user.
 *
 * Duplicated from `@lagda/db`'s private constant, which is the least bad of
 * three options: exporting it invites a caller to set it directly, and adding
 * an identity unit of work to `TransactionManager` would put the account tables
 * behind an interface whose entire documented purpose is TENANT scoping.
 *
 * The duplication is safe to the extent that it is pinned, so it is: see
 * `identity-composition.test.ts`, which reads the constant out of the db
 * package's source and fails if the two ever disagree.
 */
const USER_CONTEXT_SETTING = "lagda.user_id";

/**
 * How long a verification link and a reset link stay valid.
 *
 * Literals rather than config, matching `IDEMPOTENCY_RETENTION_MS`: both
 * numbers are quoted to the user in the message that carries the link, and an
 * environment variable lets one deployment quietly contradict its own email.
 */
const VERIFICATION_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 60 * 60 * 1000;
/** The window between a correct password and a second factor. */
const PENDING_AUTH_TTL_MS = 5 * 60 * 1000;
const PENDING_AUTH_MAX_ATTEMPTS = 5;

/**
 * The terms version a new account accepts.
 *
 * A literal, and the fact that it is one is the point: the column exists
 * because "accepted some terms" is worthless the day the documents change, and
 * a value read from the environment could not be trusted to name the document
 * the user was actually shown.
 */
const TERMS_VERSION = "2026-01-01";

/**
 * Identity, if this deployment can hold a TOTP secret.
 *
 * ── Why the MFA key gates the WHOLE surface ────────────────────────────────
 *
 * Three graphs -- completeMfa, beginEnrolment, confirmEnrolment -- seal and
 * unseal a TOTP secret, and none can be built without a key. `identity` is
 * all-or-nothing by design (see `dependencies.ts`: registration without
 * sessions is an account nobody can use), so the honest options are to wire
 * all seventeen or none.
 *
 * Absent therefore means the identity routes DO NOT EXIST, exactly as an
 * absent webhook credential means no callback route. The alternative -- mount
 * sign-in and let enrolment throw -- ships an account that can be created and
 * then locked out of, which is worse than an account that cannot be created.
 */
export function buildIdentity(
  database: LagdaDatabase,
  config: ApiConfig,
  sessions: SessionService,
  dummyPasswordHash: PasswordHash,
): Pick<AppDependencies, "identity"> {
  if (config.mfaSecretKey === null) return {};

  const db = database.db;
  const clock = { now: () => Date.now() };
  const hasher = createArgon2PasswordHasher();
  const verificationTokens = createVerificationTokenFactory();
  const resetTokens = createResetTokenFactory();
  const preAuthCredentials = createPreAuthCredentialFactory();

  /**
   * Absent means a verification/reset challenge rotates but nothing is ever
   * mailed — the same "absent capability, never a stub" shape as everything
   * else optional in this file. `signingDeliveryKey` is config-independent of
   * `mfaSecretKey`, so a deployment can hold one without the other.
   */
  const emailDelivery = config.signingDeliveryKey === null || config.appBaseUrl === null
    ? null
    : (() => {
      const notificationTemplates = createTemplateRegistry(ALL_TEMPLATES);
      const notificationIds = {
        ...createNotificationIntentIdGenerator(),
        ...createNotificationDeliveryIdGenerator(),
      };
      const sealer = createDeliverySecretSealer(
        config.signingDeliveryKey, config.signingDeliveryKeyVersion);
      return {
        sealer,
        verification: createVerificationNotificationProducer({
          templates: notificationTemplates, ids: notificationIds, clock,
        }),
        reset: createResetNotificationProducer({
          templates: notificationTemplates, ids: notificationIds, clock,
        }),
      };
    })();

  /**
   * Firebase-provider ACCOUNT EMAIL VERIFICATION (P2 migration). Mutually
   * exclusive with `emailDelivery`'s `verification` producer above for THIS
   * one notification type only — password reset and every other
   * notification stay on the default email provider regardless of this
   * setting (mission §2/§21). Null unless `EMAIL_VERIFICATION_PROVIDER=
   * firebase`, in which case a missing/invalid credential fails loud at
   * boot (config.firebaseAdmin's own loader throws — see config/index.ts,
   * the one place this package reads process.env), matching every other
   * optional-but-fail-loud capability in this file.
   */
  const firebaseVerification = config.emailVerificationProvider !== "firebase"
    || config.firebaseAdmin === null
    ? null
    : (() => {
      const admin = createFirebaseVerificationAdmin(config.firebaseAdmin);
      // LAGDA's own user id, used AS-IS as the Firebase UID (mission §5):
      // it already satisfies Firebase's UID constraints (<=128 chars,
      // alphanumeric+underscore), and reusing it — rather than inventing a
      // second identifier — is what makes the mapping deterministic and
      // trivially one-to-one, with nothing to persist or reconcile.
      const firebaseUid = (userId: string): string => userId;
      return {
        firebaseUid,
        issueHandoff: async (input: { userId: string; email: string }) => {
          try {
            await admin.ensureVerificationUser({ uid: firebaseUid(input.userId), email: input.email });
            const customToken = await admin.mintCustomToken(firebaseUid(input.userId));
            return { customToken };
          } catch {
            // Never thrown up to the route (mission §8): a Firebase outage
            // must not make registration/resend itself look failed. The
            // account already exists either way; Resend Verification is the
            // recovery path, same shape a email delivery failure always
            // had.
            return null;
          }
        },
        getVerificationState: (uid: string) => admin.getVerificationState(uid),
      };
    })();

  // OD-081 stands: one key, no KMS, no rotation, no escrow. The version column
  // is what makes rotation possible later without rewriting stored secrets.
  const mfaSecrets = createSecretBox({
    keyBase64: config.mfaSecretKey,
    keyVersion: config.mfaSecretKeyVersion,
  });

  const totp = {
    generateSecret: () => generateTotpSecret(),
    buildProvisioningUri: (secret: string, accountLabel: string) =>
      buildProvisioningUri(secret as never, accountLabel),
    verify: (input: {
      secret: string; code: string; nowMs: number; accountLabel: string;
    }) => verifyTotp({ ...input, secret: input.secret as never }),
    // A shape check before any crypto, so a malformed submission costs
    // nothing. Its absence surfaced only as a 500.
    isWellFormedCode: isWellFormedTotpCode,
  };

  const recoveryCodes = {
    issue: () => issueRecoveryCodes(),
    digestSubmitted: digestSubmittedRecoveryCode,
  };

  /** The email an authenticator app labels its entry with. */
  const accountLabelFor = async (userId: string): Promise<string | null> => {
    const row = await db.selectFrom("users").select("email")
      .where("user_id", "=", userId).executeTakeFirst();
    return row?.email ?? null;
  };

  // ── Units of work ──────────────────────────────────────────────────────────
  //
  // The account tables carry NO row-level security, and migration 008 says why:
  // a user exists before any workspace, so requiring a tenant to look one up
  // would make login impossible. These transactions therefore set no tenant
  // context, and `adoptUser` sets USER context only where a graph reaches the
  // notification tables, which are policed.

  const verificationCommit = <T>(
    operation: (uow: {
      challenges: ReturnType<typeof createVerificationRepository>;
      users: ReturnType<typeof createVerifiableUserRepository>;
      adoptUser: ReturnType<typeof createUserAdopter>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    challenges: createVerificationRepository(trx),
    users: createVerifiableUserRepository(trx),
    adoptUser: createUserAdopter(trx, USER_CONTEXT_SETTING),
  }));

  // TWO reset commits, not one, because the two halves of the flow need
  // different things and the port says so. Requesting a reset NOTIFIES, so it
  // adopts user context to reach the policed notification tables; performing
  // one REVOKES every session, in the same transaction as the credential
  // change, so there is no window in which the new password is live and the old
  // sessions still are.
  const requestResetCommit = <T>(
    operation: (uow: {
      challenges: ReturnType<typeof createPasswordResetRepository>;
      users: ReturnType<typeof createPasswordResettableUserRepository>;
      adoptUser: ReturnType<typeof createUserAdopter>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    challenges: createPasswordResetRepository(trx),
    users: createPasswordResettableUserRepository(trx),
    adoptUser: createUserAdopter(trx, USER_CONTEXT_SETTING),
  }));

  const resetPasswordCommit = <T>(
    operation: (uow: {
      challenges: ReturnType<typeof createPasswordResetRepository>;
      users: ReturnType<typeof createPasswordResettableUserRepository>;
      sessions: ReturnType<typeof createSessionRepository>;
      pendingAuth: ReturnType<typeof createPendingAuthenticationRepository>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    challenges: createPasswordResetRepository(trx),
    users: createPasswordResettableUserRepository(trx),
    // The SESSION repository, not the account one: only this carries
    // `revokeAllForUser`, and the account repository's lookalike
    // `revokeAllForUserExcept` deliberately spares the caller's own session --
    // which is the opposite of what a reset needs.
    sessions: createSessionRepository(trx),
    // Optional in the port and supplied anyway. Someone resetting a password
    // may be doing it because they are locked out mid-ceremony, and leaving a
    // pending second-factor record alive would let a half-finished
    // authentication outlive the credential it was started with.
    pendingAuth: createPendingAuthenticationRepository(trx),
  }));

  const mfaCommit = <T>(
    operation: (uow: {
      factors: ReturnType<typeof createMfaFactorRepository>;
      recovery: ReturnType<typeof createRecoveryCodeRepository>;
      pending: ReturnType<typeof createPendingAuthenticationRepository>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    factors: createMfaFactorRepository(trx),
    recovery: createRecoveryCodeRepository(trx),
    pending: createPendingAuthenticationRepository(trx),
  }));

  const accountCommit = <T>(
    operation: (uow: {
      accounts: ReturnType<typeof createAccountProfileRepository>;
      credentials: ReturnType<typeof createAccountCredentialRepository>;
      sessions: ReturnType<typeof createAccountSessionRepository>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    accounts: createAccountProfileRepository(trx),
    credentials: createAccountCredentialRepository(trx),
    sessions: createAccountSessionRepository(trx),
  }));

  const registrationCommit = <T>(
    operation: (uow: {
      users: ReturnType<typeof createUserRepository>;
      challenges: ReturnType<typeof createVerificationChallengeRepository>;
    }) => Promise<T>,
  ): Promise<T> => db.transaction().execute((trx) => operation({
    users: createUserRepository(trx),
    challenges: createVerificationChallengeRepository(trx),
  }));

  /** Whatever the repository factories accept: the pool or a transaction on it. */
  type RepositoryTransaction = Parameters<typeof createAccountCredentialRepository>[0];

  // ── Shared by the account link and by continuing from the app ─────────
  //
  // One password verifier, one identity lookup and one saved-signature
  // handoff, so "prove it is you" and "hand over my marks" each mean one
  // thing wherever they happen.

  const verifyPasswordIn = (trx: RepositoryTransaction) =>
    async (id: string, password: string): Promise<boolean> => {
      const stored = await createAccountCredentialRepository(trx)
        .findPasswordHash(id as UserId);
      if (stored === null) return false;
      // (plaintext, hash) — not the other way round.
      return hasher.verify(password, stored);
    };

  const findAccountIdentity = async (id: string) => {
    const row = await createAccountProfileRepository(db).findCurrentUser(id as UserId);
    if (row === null) return null;
    const normalized = normalizeEmail(row.email);
    if (normalized.outcome !== "ok") return null;
    return { normalizedEmail: normalized.normalized, emailVerified: row.emailVerified };
  };

  // Workspace -> ceremony, pushed once. A COPY, so editing or deleting the
  // library entry afterwards cannot change or empty what the signer is about
  // to be shown and approve.
  const handOverSavedSignaturesIn = (trx: RepositoryTransaction) =>
    async (input: {
      readonly userId: string; readonly signingRequestId: string;
      readonly recipientId: string; readonly recipientSessionId: string; readonly at: Date;
    }): Promise<number> => {
      const saved = await createUserSignatureRepository(trx).list(input.userId);
      const usable = saved.filter(entry => entry.validatedAt !== null);
      const prepared = createPreparedSignatureRepository(trx);
      for (const entry of usable) {
        await prepared.prepare({
          signingRequestId: input.signingRequestId,
          recipientId: input.recipientId,
          purpose: entry.purpose,
          representationType: entry.representationType,
          typedText: entry.typedText,
          typedStyleIndex: entry.typedStyleIndex,
          rasterBytes: entry.rasterBytes,
          rasterMediaType: entry.rasterMediaType,
          rasterWidth: entry.rasterWidth,
          rasterHeight: entry.rasterHeight,
          // This row's digest describes this row. Recomputed rather than
          // carried over, so a copy cannot inherit a digest that describes
          // bytes it does not hold.
          digest: entry.digest,
          sourceDigest: entry.digest,
          preparedByUserId: input.userId,
          preparedForSessionId: input.recipientSessionId,
          preparedAt: input.at,
        });
      }
      return usable.length;
    };

  return {
    identity: () => ({
      register: () => ({
        users: createUserRepository(db),
        challenges: createVerificationChallengeRepository(db),
        hasher, clock,
        tokens: verificationTokens,
        newUserId: () => nextUserId(),
        newChallengeId: () => nextVerificationChallengeId(),
        commit: registrationCommit,
        termsVersion: TERMS_VERSION,
        verificationTtlMs: VERIFICATION_TTL_MS,
      }),

      login: () => ({
        users: createUserRepository(db),
        hasher, sessions, clock, dummyPasswordHash,
        // WITHOUT this, enrolling a second factor changes nothing at sign-in:
        // the password alone still issues a full session. `mfa` is optional, so
        // omitting it is indistinguishable from having no MFA at all.
        mfa: {
          isRequired: async (userId: UserId) => {
            const factor = await createMfaFactorRepository(db)
              .findActiveForUser(userId, "TOTP");
            // Enrolled but UNCONFIRMED must not challenge: the user could not
            // answer it and would be locked out of their own account.
            return factor !== null && factor.verifiedAt !== null;
          },
          beginCeremony: async (userId: UserId) => {
            const issued = preAuthCredentials.issue();
            const now = clock.now();
            const expiresAt = now + PENDING_AUTH_TTL_MS;
            await createPendingAuthenticationRepository(db).create({
              pendingId: nextPendingAuthenticationId(),
              userId,
              credentialDigest: issued.digest,
              createdAt: now,
              expiresAt,
              maxAttempts: PENDING_AUTH_MAX_ATTEMPTS,
              authenticationMethod: "PASSWORD_PLUS_TOTP",
            } as never);
            return { raw: issued.raw, expiresAt };
          },
        },
      }),

      verifyEmail: () => ({
        // Canonicalises before digesting, so a code typed with spaces or in the
        // wrong case still redeems.
        digestSubmitted: digestSubmittedCode,
        clock,
        commit: verificationCommit,
      }),

      resendVerification: () => ({
        clock,
        tokens: verificationTokens,
        newChallengeId: () => nextVerificationChallengeId(),
        verificationTtlMs: VERIFICATION_TTL_MS,
        commit: verificationCommit,
        // The worker delivers. This hands the row to the queue and returns --
        // the raw token is never in scope here, because the renderer recovers
        // it from the sealed secret on the challenge row.
        //
        // FIREBASE MODE: this whole default-provider scheduling path is skipped —
        // ACCOUNT EMAIL VERIFICATION delivery is Firebase's job in that mode
        // (see issueFirebaseVerificationHandoff below, wired at the route
        // layer instead, since minting a Firebase custom token is an
        // external call and must not run inside this DB transaction — same
        // "nothing external inside commit" rule this file already follows).
        ...(emailDelivery === null || firebaseVerification !== null ? {} : {
          sealer: emailDelivery.sealer,
          scheduleDelivery: (input, context) => emailDelivery.verification(
            input, context.notifications, context.transaction),
        }),
      }),

      requestPasswordReset: () => ({
        clock,
        tokens: resetTokens,
        newChallengeId: () => nextPasswordResetChallengeId(),
        resetTtlMs: RESET_TTL_MS,
        ...(emailDelivery === null ? {} : {
          sealer: emailDelivery.sealer,
          scheduleDelivery: (input, context) => emailDelivery.reset(
            input, context.notifications, context.transaction),
        }),
        commit: requestResetCommit,
      }),

      resetPassword: () => ({
        digestSubmitted: digestSubmittedResetToken,
        hasher, clock,
        peek: (digest) => createPasswordResetRepository(db).findByTokenDigest(digest),
        commit: resetPasswordCommit,
      }),

      completeMfa: () => ({
        clock, totp,
        sealer: mfaSecrets,
        recoveryCodes,
        pendingCredentials: preAuthCredentials,
        accountLabelFor,
        commit: mfaCommit,
      }),

      beginEnrolment: () => ({
        clock, totp,
        sealer: mfaSecrets,
        newFactorId: () => nextMfaFactorId(),
        accountLabelFor,
        commit: mfaCommit,
      }),

      confirmEnrolment: () => ({
        clock, totp,
        sealer: mfaSecrets,
        recoveryCodes,
        newRecoveryCodeId: () => nextRecoveryCodeId(),
        accountLabelFor,
        commit: mfaCommit,
      }),

      disableMfa: () => ({
        clock, hasher,
        passwordHashFor: (userId: UserId) =>
          createAccountCredentialRepository(db).findPasswordHash(userId),
        commit: mfaCommit,
      }),

      signatures: () => createUserSignatureRepository(db),
      notificationFeed: () => createNotificationFeedRepository(db),

      // The workspace half of the account binding. Runs in GLOBAL scope: the
      // handoff tables belong to no tenant, which is what lets a message pass
      // between two realms that cannot see each other's scope.
      claimSigningLink: async (userId: UserId, code: string, currentPassword: string) =>
        // A transaction directly on `db`, not a TransactionManager scope:
        // this module deliberately has no unit of work (see the header), and
        // the handoff tables carry no row-level security, so there is no
        // tenant context to establish. The transaction is here for atomicity
        // alone — consuming the code and writing the link must not come apart.
        db.transaction().execute(async trx => claimSigningLink(userId, code, currentPassword, {
          clock: { now: () => clock.now() },
          // Its OWN transaction, on `db` rather than `trx`, so the burn
          // commits whatever happens to the claim that follows. Inside `trx`
          // a refusal would roll the burn back and leave the code usable —
          // which is what production was doing.
          consumeIntent: (intentDigest, at) =>
            db.transaction().execute(inner =>
              createSigningAccountLinkRepository(inner).claimIntent(intentDigest, at)),
          codes: createHandoffCodeDigester(),
          links: createSigningAccountLinkRepository(trx),
          ids: () => `sal_${randomUUID().replace(/-/g, "")}`,
          // The step-up. Same verifier the password-change route uses, so
          // "prove it is you" means one thing across the account surface.
          verifyPassword: verifyPasswordIn(trx),
          handOverSavedSignatures: handOverSavedSignaturesIn(trx),
          accounts: {
            findIdentity: async (id: string) => {
              const identity = await findAccountIdentity(id);
              if (identity === null) return null;
              return {
                normalizedEmail: identity.normalizedEmail,
                // Derived, because the projection exposes a boolean rather
                // than the timestamp. Either way the question is the same:
                // has this address been proved?
                emailVerifiedAt: identity.emailVerified ? new Date(clock.now()) : null,
              };
            },
          },
        })),

      // ── "Documents I must sign" / "Signed by me" (migrations 055, 056) ──
      //
      // Read by the authenticated user id and nothing else. Global scope, on
      // plain transactions, for the same reason the claim above is: these
      // rows belong to no tenant.
      listDocumentsToSign: async (userId: UserId) => {
        const entries = await createUserSigningRecordsRepository(db)
          .listOpenInboxForUser(userId, clock.now(), 100);
        return entries.map(presentInboxItem);
      },
      listSignedDocuments: async (userId: UserId) => {
        const records = await createUserSigningRecordsRepository(db)
          .listSignedForUser(userId, 100);
        return records.map(presentSignedDocument);
      },
      // "Continue signing": the second verification, then a single-use code.
      // One transaction, so the link, the handed-over marks and the code
      // commit together or not at all.
      beginInAppSigning: async (
        userId: UserId,
        input: { signingRequestId: string; recipientId: string; password: string },
      ) =>
        db.transaction().execute(async trx => beginInAppSigning(userId, input, {
          clock: { now: () => clock.now() },
          codes: createHandoffCodeDigester(),
          findOpenEntry: (id, request, recipient, now) =>
            createUserSigningRecordsRepository(trx).findOpenInboxEntry(id, request, recipient, now),
          verifyPassword: verifyPasswordIn(trx),
          findIdentity: findAccountIdentity,
          links: createSigningAccountLinkRepository(trx),
          handOverSavedSignatures: handOverSavedSignaturesIn(trx),
          resumeIntents: createSigningResumeIntentRepository(trx),
          newSessionId: () => createRecipientSigningSessionIdGenerator().nextRecipientSigningSessionId(),
          newLinkId: () => `sal_${randomUUID().replace(/-/g, "")}`,
        })),
      signatureImages: () => createSignatureImageValidator(),
      // `clock` here yields epoch millis; the repository stores timestamptz.
      now: () => new Date(clock.now()),

      currentUser: () => ({ accounts: createAccountProfileRepository(db) }),
      updateProfile: () => ({ clock, commit: accountCommit }),
      updatePreferences: () => ({
        clock,
        // The platform's own IANA list, so a made-up zone is rejected rather
        // than stored.
        isKnownTimezone: (value: string) =>
          Intl.supportedValuesOf("timeZone").includes(value),
        commit: accountCommit,
      }),
      changePassword: () => ({
        clock, hasher,
        credentials: createAccountCredentialRepository(db),
        commit: accountCommit,
      }),

      listSessions: () => ({ sessions: createAccountSessionRepository(db) }),
      revokeSession: () => ({ clock, sessions: createAccountSessionRepository(db) }),
      revokeOtherSessions: () => ({
        clock, sessions: createAccountSessionRepository(db),
      }),

      // Firebase-provider ACCOUNT EMAIL VERIFICATION only (P2 migration) —
      // both absent together in the default mode (the default). See
      // identity-routes.ts's IdentityDependencies for the full contract.
      ...(firebaseVerification === null ? {} : {
        issueFirebaseVerificationHandoff: firebaseVerification.issueHandoff,
        firebaseFinalizeVerification: () => ({
          clock,
          externalUid: firebaseVerification.firebaseUid,
          verifier: { getVerificationState: firebaseVerification.getVerificationState },
          commit: verificationCommit,
        }),
      }),

      // "logout", from REVOCATION_REASONS. NOT "signed_out": that value is not
      // in the vocabulary, so the CHECK constraint added by migration 004
      // rejects the update, the repository throws, and the route answers 503
      // SESSION_REVOCATION_FAILED -- while the session stays valid and the
      // browser is told it signed out.
      //
      // The `as never` that used to sit on this argument is what stopped the
      // compiler saying so: the parameter is typed `RevocationReason`, and
      // "signed_out" would never have compiled without it.
      endSession: (sessionId: string) =>
        sessions.revoke(sessionId as SessionId, "logout"),
      issueSession: (userId: UserId) => sessions.issue(userId),

      // The same double-submit check `requireSession` installs, applied to the
      // one identity route that mutates state with a session in hand.
      validateCsrf: (request) => {
        const auth: RequestAuth = request.auth;
        if (auth.status !== "authenticated") return false;
        const header = request.headers["x-csrf-token"];
        if (typeof header !== "string") return false;
        try {
          sessions.validateCsrf(auth.session, header);
          return true;
        } catch {
          return false;
        }
      },

      // Reads what the session plugin already resolved. `sessions.resolve()` is
      // wrong twice over here: it takes a RAW TOKEN and returns
      // { outcome, actor, session } rather than { userId, sessionId }.
      authenticatedUser: (request) => {
        const auth: RequestAuth = request.auth;
        if (auth.status !== "authenticated") return Promise.resolve(null);
        return Promise.resolve({
          userId: auth.actor.userId,
          sessionId: auth.session.sessionId,
        });
      },
    }),
  };
}
