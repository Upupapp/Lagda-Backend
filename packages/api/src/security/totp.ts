// TOTP — RFC 6238, via a maintained library.
//
// The cryptography is NOT implemented here. `otpauth` is standards-compliant
// and maintained, and a hand-rolled HMAC-based OTP is exactly the kind of code
// that appears to work — it produces six digits, and the phone agrees most of
// the time — while being subtly wrong about counter endianness or truncation in
// a way no test written by its own author would catch (§192).
//
// What this module owns is the POLICY around it: parameters, the skew window,
// and the replay rule. Those are security decisions, not arithmetic.

import { TOTP, Secret } from "otpauth";
import { randomBytes } from "node:crypto";

/**
 * Standard parameters. Not configurable, deliberately.
 *
 * Every authenticator app — Google Authenticator, 1Password, Authy, Aegis —
 * assumes SHA-1 / 6 digits / 30 seconds when a provisioning URI omits them.
 * "Upgrading" to SHA-256 here would silently break enrolment in the apps that
 * ignore the algorithm parameter, and buys nothing: the security of TOTP rests
 * on the secret's entropy and on the attempt limit, not on the hash.
 */
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ISSUER = "LAGDA";

/**
 * 20 bytes — 160 bits, the RFC 4226 recommendation.
 *
 * Generated with a CSPRNG. A secret derived from an email, a user id or a
 * timestamp would let anyone who knows those values generate the user's codes
 * (§184).
 */
const SECRET_BYTES = 20;

/**
 * ±1 time step, so a window of about 90 seconds in total.
 *
 * Narrow on purpose (§190). Each additional step multiplies the number of
 * simultaneously-valid codes, and a generous window is how "a code I saw a few
 * minutes ago" stays useful. One step each way absorbs ordinary phone clock
 * drift and a slow typist; anything wider is convenience bought with the
 * credential's lifetime.
 */
const SKEW_STEPS = 1;

/** The provisioning secret, base32 — what the QR code and setup key encode. */
export type TotpSecret = string & { readonly __brand: "TotpSecret" };

export function generateTotpSecret(): TotpSecret {
  return new Secret({ buffer: randomBytes(SECRET_BYTES).buffer }).base32 as TotpSecret;
}

function build(secret: TotpSecret, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

/**
 * The `otpauth://` provisioning URI, for the QR code.
 *
 * SECRET — it contains the enrolment secret in full. Never logged, never sent
 * to analytics, never stored beyond the enrolment response (§187).
 */
export function buildProvisioningUri(secret: TotpSecret, accountLabel: string): string {
  return build(secret, accountLabel).toString();
}

/** The time step a timestamp falls in. The replay watermark's unit. */
export function timeStepFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * Which time step the code belonged to, when valid.
   *
   * Returned so the caller can compare it against the stored watermark and
   * REFUSE a step that has already been used. Without this, a code remains
   * usable for its whole window and can simply be replayed (§191).
   */
  readonly timeStep: number | null;
}

/**
 * Verifies a submitted code against the secret.
 *
 * The library's `validate` returns the delta in time steps, or null. Note it is
 * given the code as a STRING: `"004218"` is a valid code and converting it to a
 * number would make it `4218`, which matches nothing (§11, §35).
 */
export function verifyTotp(input: {
  readonly secret: TotpSecret;
  readonly code: string;
  readonly nowMs: number;
  readonly accountLabel: string;
}): TotpVerification {
  const delta = build(input.secret, input.accountLabel).validate({
    token: input.code,
    timestamp: input.nowMs,
    window: SKEW_STEPS,
  });
  if (delta === null) return { valid: false, timeStep: null };
  return { valid: true, timeStep: timeStepFor(input.nowMs) + delta };
}

/**
 * Exactly six digits, and nothing else.
 *
 * No trimming of internal characters, no stripping of leading zeroes, no
 * `parseInt`. The code is a fixed-width string of digits and every
 * transformation of it is a way to accept something that is not the code.
 */
const CODE_PATTERN = /^[0-9]{6}$/;

export function isWellFormedTotpCode(raw: string): boolean {
  return CODE_PATTERN.test(raw);
}

export const TOTP_PARAMETERS = {
  algorithm: ALGORITHM,
  digits: DIGITS,
  periodSeconds: PERIOD_SECONDS,
  skewSteps: SKEW_STEPS,
  issuer: ISSUER,
} as const;
