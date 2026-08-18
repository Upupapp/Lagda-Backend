// Resolving the one-time secret a notification carries.
//
// ── Two kinds, because the domains never agreed and should not ─────────────
//
// `SEALED` is a credential encrypted with the established `SecretBox`, carried
// on the intent because a signing link cannot be recovered from a digest — the
// renderer runs long after the transaction that minted it.
//
// `CHALLENGE` is a pointer and nothing else. Verification, reset and OTP flows
// persist a digest and drop the raw value, and forcing them to seal instead
// would start storing secrets that today are not stored at all.
//
// This module resolves the first. The second is deliberately left unimplemented
// here and is described below, because implementing it would mean inventing
// how each auth flow decides its own credential is still usable — a decision
// that belongs to those flows, not to transport.

import type {
  NotificationSecretResolver, NotificationSecretResolution, NotificationSecretRef,
  NotificationSource,
} from "@lagda/application";
import { createSecretBox, SecretBoxError } from "./secret-box.js";

/**
 * Whether the credential behind a reference is still usable.
 *
 * Supplied by the domain that owns it. Returning false must mean "do not send
 * this", never "try again later" — a revoked signing grant does not become
 * valid on a retry, and a message carrying it should be suppressed rather than
 * retried into the same refusal.
 */
export interface CredentialValidityCheck {
  isStillUsable(sourceId: string): Promise<boolean>;
}

/**
 * Which source kinds this resolver is willing to answer for.
 *
 * `SEALED` credentials are minted by the signing-access domain, so a sealed
 * reference arriving under any other source is a composition error rather than
 * a runtime condition — and answering it would mean asking the wrong domain
 * whether its credential is still good.
 */
const SEALED_SOURCE_KIND = "SIGNING_ACCESS_GRANT";

/**
 * Resolves SEALED references by decrypting them.
 *
 * ── The order matters ──────────────────────────────────────────────────────
 *
 * Validity is checked BEFORE decryption. Decrypting first would put a live
 * credential in memory in order to discover it must not be used — a strictly
 * worse outcome than not touching it, and one that shows up in a heap dump.
 *
 * ── Why a failure to open is UNUSABLE rather than an error ─────────────────
 *
 * A ciphertext that will not open means the key rotated without re-sealing, or
 * the row is corrupt. Neither is recoverable by retrying, and both should stop
 * the send rather than crash a worker into a retry loop against a row that will
 * never open.
 */
export function createSealedSecretResolver(
  key: string | null,
  keyVersion: string,
  validity: CredentialValidityCheck,
): NotificationSecretResolver {
  const box = key === null ? null : createSecretBox({ keyBase64: key, keyVersion });

  return {
    async resolve(
      secretRef: NotificationSecretRef,
      source: NotificationSource,
    ): Promise<NotificationSecretResolution> {
      if (secretRef.kind !== "SEALED") {
        // CHALLENGE references are resolved by the auth domain. Reaching here
        // with one is a composition error, not a runtime condition, so it is
        // reported as unusable rather than guessed at.
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }

      if (box === null) {
        // Unavailable rather than silently degraded, matching how the sealer
        // behaves with no key: a deployment that cannot open credentials must
        // not quietly deliver messages without them.
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }

      if (source.kind !== SEALED_SOURCE_KIND) {
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }

      // The SOURCE id, not the ciphertext. "Is this credential still usable" is
      // a question about the grant that issued it; the sealed blob is only how
      // transport carries the value, and a domain asked to look one up by
      // ciphertext can only answer no.
      if (!(await validity.isStillUsable(source.sourceId))) {
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }

      try {
        return { status: "AVAILABLE", secret: box.open(secretRef.sealed) };
      } catch (error) {
        if (error instanceof SecretBoxError) {
          return { status: "UNUSABLE", reason: "SECRET_EXPIRED" };
        }
        throw error;
      }
    },
  };
}

// ── CHALLENGE, resolved (OD-184) ────────────────────────────────────────────

/**
 * Reads back a credential the owning auth domain sealed when it minted it.
 *
 * One method, returning null for unknown, consumed, superseded and expired
 * alike. The four collapse deliberately: the caller suppresses the message in
 * every case, and distinguishing them would hand a renderer a challenge's
 * lifecycle it has no use for.
 */
export interface ChallengeCredentialLookup {
  findSealedIfActive(
    sourceId: string,
    now: number,
  ): Promise<{ readonly sealed: string; readonly keyVersion: string } | null>;
}

/**
 * Resolves CHALLENGE references by asking the domain that owns the credential.
 *
 * ── Why the lookup is a port and not a branch ──────────────────────────────
 *
 * Verification, reset, OTP and invitation each know what expiry, consumption
 * and supersession mean for their own credential, and each stores its
 * ciphertext in its own table beside its own lifecycle columns. A resolver that
 * knew all four would be a resolver that had to be edited whenever any of them
 * changed.
 *
 * ── Why an unopenable ciphertext is UNUSABLE, not an error ─────────────────
 *
 * It means the key rotated without re-sealing, or the row is corrupt. Neither
 * is fixed by retrying, and both should stop the send rather than crash a
 * worker into a retry loop against a row that will never open.
 */
export function createChallengeSecretResolver(
  key: string | null,
  keyVersion: string,
  lookup: ChallengeCredentialLookup,
  clock: { now(): number },
): NotificationSecretResolver {
  const box = key === null ? null : createSecretBox({ keyBase64: key, keyVersion });

  return {
    async resolve(
      secretRef: NotificationSecretRef,
    ): Promise<NotificationSecretResolution> {
      if (secretRef.kind !== "CHALLENGE") {
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }
      if (box === null) {
        // Unavailable rather than silently degraded, matching the sealer: a
        // deployment that cannot open credentials must not quietly deliver
        // messages without them.
        return { status: "UNUSABLE", reason: "SECRET_REVOKED" };
      }

      const found = await lookup.findSealedIfActive(
        secretRef.challengeId, clock.now());
      if (found === null) {
        // Expired is the likely case and the one worth naming: a reset link
        // that died while the message sat in a queue must not be delivered.
        return { status: "UNUSABLE", reason: "SECRET_EXPIRED" };
      }

      try {
        return { status: "AVAILABLE", secret: box.open(found.sealed) };
      } catch (error) {
        if (error instanceof SecretBoxError) {
          return { status: "UNUSABLE", reason: "SECRET_EXPIRED" };
        }
        throw error;
      }
    },
  };
}

/**
 * Dispatches on how the credential is referenced.
 *
 * The composition root holds both resolvers because a worker delivers both
 * kinds of message, and neither resolver should learn that the other exists.
 * Written as a table lookup rather than an if-chain for the usual reason: a
 * third reference kind becomes a compile error here instead of a silent fall
 * through to "unusable".
 */
export function createNotificationSecretResolver(
  bySealed: NotificationSecretResolver,
  byChallenge: NotificationSecretResolver,
): NotificationSecretResolver {
  const RESOLVERS: Record<NotificationSecretRef["kind"], NotificationSecretResolver> = {
    SEALED: bySealed,
    CHALLENGE: byChallenge,
  };
  return {
    resolve: (secretRef, source, transaction) =>
      RESOLVERS[secretRef.kind].resolve(secretRef, source, transaction),
  };
}
