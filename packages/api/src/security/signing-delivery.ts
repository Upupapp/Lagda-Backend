// Sealing a signing credential for asynchronous delivery, and building the link.
//
// ── The problem these solve ────────────────────────────────────────────────
//
// Every other LAGDA credential is stored as a one-way digest and its raw value
// dropped at the end of the transaction that made it. That works because the
// server only ever COMPARES a submitted value.
//
// A signing link cannot work that way. The email carrying it is rendered after
// the transaction commits, by a process that was not there when the credential
// was generated. OD-098 recorded exactly this as the reason invitation
// delivery is blocked, and named the resolution: encrypt it the way BACKEND-23
// encrypts TOTP secrets.
//
// So there are two pieces: a sealer that makes the raw credential recoverable,
// and a link builder that turns it back into a URL from CONFIGURED base only.

import type {
  DeliverySecretSealer, SealedDeliverySecret, SigningLinkBuilder,
} from "@lagda/application";
import { createSecretBox } from "./secret-box.js";

/**
 * Seals a raw signing credential with AES-256-GCM.
 *
 * ── Fails loudly with no key ───────────────────────────────────────────────
 *
 * `key === null` produces a sealer whose `seal` throws. It does NOT produce a
 * sealer that stores plaintext, and it does not produce `undefined` that a
 * caller might skip past: Send calls `seal` before its state transition, so an
 * unconfigured deployment cannot mark a request sent with an unrecoverable
 * credential.
 *
 * That is the same shape MFA enrolment takes when its key is missing —
 * unavailable rather than silently degraded.
 */
export function createDeliverySecretSealer(
  key: string | null,
  keyVersion: string,
): DeliverySecretSealer {
  if (key === null) {
    return {
      keyVersion,
      seal: () => {
        throw new DeliverySecretUnavailableError();
      },
    };
  }

  const box = createSecretBox({ keyBase64: key, keyVersion });
  return {
    keyVersion: box.keyVersion,
    seal: (plaintext: string) => box.seal(plaintext) as unknown as SealedDeliverySecret,
  };
}

/**
 * No key is configured, so a signing credential cannot be made recoverable.
 *
 * Deliberately vague to a caller and specific in the message an operator sees:
 * this is a deployment fault, not a user error, and the user-facing outcome is
 * that the request stays unsent.
 */
export class DeliverySecretUnavailableError extends Error {
  constructor() {
    super("Signing delivery is not configured on this deployment.");
    this.name = "DeliverySecretUnavailableError";
  }
}

/**
 * Builds the recipient-facing signing URL from CONFIGURED base only.
 *
 * ── Never from a request header ────────────────────────────────────────────
 *
 * Not `Host`, not `X-Forwarded-Host`, not `request.hostname`. A link built
 * from an inbound header is a link an attacker chose, sent by LAGDA, over
 * LAGDA's reputation, carrying a real bearer credential to a real
 * counterparty. This function takes no request and cannot see one.
 *
 * ── The URL is never stored ────────────────────────────────────────────────
 *
 * Only the raw token is sealed into the delivery intent; the renderer calls
 * this to rebuild the URL at send time. So a stored row can never carry a host
 * at all, and rotating the canonical domain fixes every unsent invitation
 * without a migration.
 */
export function createSigningLinkBuilder(appBaseUrl: string): SigningLinkBuilder {
  // Parsed once, at construction. A malformed base is a configuration error
  // that should surface at boot rather than on the first send.
  const base = new URL(appBaseUrl);

  return {
    build: (rawCredential: string) => {
      // A path segment, not a query parameter. A query string is more likely
      // to survive into a referrer, an access log or an analytics payload, and
      // BACKEND-34 will strip the segment from the address bar as soon as it
      // has exchanged it.
      const url = new URL(base);
      url.pathname = `${base.pathname.replace(/\/+$/, "")}/sign/`
        + encodeURIComponent(rawCredential);
      return url.toString();
    },
  };
}
