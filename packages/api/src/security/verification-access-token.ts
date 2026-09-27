// 083. Verify Document access credentials.
//
//   * The CODE: six uniformly random digits. Stored as SHA-256 over
//     `lagda.verification-access-code:<challengeId>:<code>` — domain-separated
//     and salted by its own challenge, so one digest never matches another
//     challenge's code — and sealed (never stored raw) for the worker.
//   * The GRANT: 32 random bytes, base64url. Stored as SHA-256 over
//     `lagda.verification-access-grant:<token>`, a separate domain so a code
//     digest can never resolve a grant, and the reverse.

import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { VerificationAccessCrypto } from "@lagda/application";
import { createDeliverySecretSealer } from "./signing-delivery.js";

const CODE_DOMAIN = "lagda.verification-access-code";
const GRANT_DOMAIN = "lagda.verification-access-grant";
const THROTTLE_PAIR_DOMAIN = "lagda.verification-throttle.pair";
const THROTTLE_VERIFICATION_DOMAIN = "lagda.verification-throttle.verification";
const TOKEN_BYTES = 32;
const ENCODED_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createVerificationAccessCrypto(
  key: string | null,
  keyVersion: string,
): VerificationAccessCrypto {
  const sealer = createDeliverySecretSealer(key, keyVersion);
  return {
    newCode: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    digestCode: (challengeId, code) => sha256Hex(`${CODE_DOMAIN}:${challengeId}:${code}`),
    digestsEqual(left, right) {
      const a = Buffer.from(left, "utf8");
      const b = Buffer.from(right, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    },
    sealCode: code => ({ sealed: sealer.seal(code), keyVersion: sealer.keyVersion }),
    issueGrantToken() {
      const raw = randomBytes(TOKEN_BYTES).toString("base64url");
      return { raw, digest: sha256Hex(`${GRANT_DOMAIN}:${raw}`) };
    },
    // Refused by SHAPE before any lookup, so a malformed value costs nothing.
    digestGrantToken(raw) {
      if (raw.length !== ENCODED_LENGTH || !TOKEN_PATTERN.test(raw)) return null;
      return sha256Hex(`${GRANT_DOMAIN}:${raw}`);
    },
    // 085. Irreversible throttle keys: an email is personal data, and a
    // throttle only ever compares.
    throttleKeys: (verificationId, normalizedEmail) => ({
      pairKey: sha256Hex(`${THROTTLE_PAIR_DOMAIN}:${verificationId}|${normalizedEmail}`),
      verificationKey: sha256Hex(`${THROTTLE_VERIFICATION_DOMAIN}:${verificationId}`),
    }),
    nextChallengeId: () => `vac_${randomUUID()}`,
    nextGrantId: () => `vag_${randomUUID()}`,
  };
}
