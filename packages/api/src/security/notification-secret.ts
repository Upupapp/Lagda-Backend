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

      if (!(await validity.isStillUsable(secretRef.sealed))) {
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
