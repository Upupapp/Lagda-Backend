// Argon2id password hashing.
//
// The ONLY file in LAGDA permitted to import a password-hashing library.
// Everything above it works with the `PasswordHasher` port (INV-242).
//
// ── Why Argon2id ───────────────────────────────────────────────────────────
//
// It is memory-hard, which is what makes offline cracking expensive on the
// hardware attackers actually use. A GPU or ASIC can compute SHA-256 billions
// of times per second; it cannot cheaply allocate 19 MiB per guess.
//
// The `id` variant specifically: Argon2i resists side-channel attacks but is
// weaker against time-memory trade-offs, Argon2d is the reverse, and `id`
// combines both and is what RFC 9106 recommends for password storage.
//
// Not bcrypt (not memory-hard, and silently truncates at 72 bytes — two
// different passwords would authenticate one account). Not PBKDF2 (cheap to
// parallelise). Not a bare SHA family, which is not a password hash at all.

import argon2 from "argon2";
import type { PasswordHash, PasswordHasher } from "@lagda/application";

/**
 * Explicit parameters, from RFC 9106's second recommended configuration.
 *
 * Never the library's defaults: a default is a value that changes underneath a
 * deployment without anyone deciding to change it, and password parameters are
 * exactly the thing that must be deliberate.
 *
 *   memoryCost 19 MiB  — the memory-hardness. The number that actually costs an
 *                        attacker; raising it is the most effective single
 *                        change.
 *   timeCost   2       — iterations over that memory.
 *   parallelism 1      — one lane. Node hashes on a libuv thread, so extra
 *                        lanes compete with the request that is waiting.
 *
 * The cost is real and intentional: roughly tens of milliseconds per hash, and
 * 19 MiB held for the duration. That is why the registration rate limit must
 * run first (INV-234), and why BACKEND-61 should measure before raising these.
 */
export const ARGON2_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Floors, so a deployment cannot quietly weaken hashing.
 *
 * Configuration that could set `memoryCost: 8` would look like it was hashing
 * passwords while providing almost no protection — the failure mode where a
 * control exists and does nothing.
 */
const MINIMUM_MEMORY_COST = 19_456;
const MINIMUM_TIME_COST = 2;

export class PasswordHasherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordHasherConfigError";
  }
}

export interface PasswordHasherOptions {
  readonly memoryCost?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
}

export function createArgon2PasswordHasher(
  options: PasswordHasherOptions = {},
): PasswordHasher {
  const memoryCost = options.memoryCost ?? ARGON2_PARAMETERS.memoryCost;
  const timeCost = options.timeCost ?? ARGON2_PARAMETERS.timeCost;
  const parallelism = options.parallelism ?? ARGON2_PARAMETERS.parallelism;

  if (memoryCost < MINIMUM_MEMORY_COST) {
    throw new PasswordHasherConfigError(
      `Argon2 memoryCost must be at least ${String(MINIMUM_MEMORY_COST)} KiB.`,
    );
  }
  if (timeCost < MINIMUM_TIME_COST) {
    throw new PasswordHasherConfigError(
      `Argon2 timeCost must be at least ${String(MINIMUM_TIME_COST)}.`,
    );
  }

  const settings = { type: argon2.argon2id, memoryCost, timeCost, parallelism } as const;

  return {
    async hash(plaintext: string): Promise<PasswordHash> {
      // The library's async API, which runs on a libuv thread rather than
      // blocking the event loop. A synchronous hash would stall every other
      // in-flight request for the duration (§215).
      //
      // No salt parameter: argon2 generates a cryptographically random salt per
      // hash and encodes it in the output string. Supplying one would be a way
      // to get it wrong.
      const encoded = await argon2.hash(plaintext, settings);
      return encoded as PasswordHash;
    },

    async verify(plaintext: string, hash: PasswordHash): Promise<boolean> {
      try {
        // Parameters come from the ENCODED HASH, not from current settings, so
        // a password hashed under older parameters still verifies. That is what
        // makes raising the parameters later a safe, non-breaking change.
        return await argon2.verify(hash, plaintext);
      } catch {
        // A malformed or unreadable hash is not a match. Returning false rather
        // than throwing keeps a corrupt row from becoming a 500 that
        // distinguishes it from a wrong password.
        return false;
      }
    },

    needsRehash(hash: PasswordHash): boolean {
      try {
        return argon2.needsRehash(hash, settings);
      } catch {
        // Unparseable means it was not produced by these settings.
        return true;
      }
    },
  };
}

/**
 * The parameters encoded in a hash string.
 *
 * Parsed from the standard PHC format rather than by asking the library, so a
 * test can assert what was actually stored:
 *
 *   $argon2id$v=19$m=19456,p=1,t=2$<salt>$<hash>
 */
export function describeHash(hash: string): {
  readonly algorithm: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
} | null {
  // Parameters are parsed as an unordered key=value list, not by fixed
  // position. The first version of this assumed `m,t,p` because that is the
  // order the PHC examples use; the library actually emits `m,p,t`, so the
  // parser returned null for every real hash - a check that silently examined
  // nothing.
  const match = /^\$(argon2(?:id|i|d))\$v=(\d+)\$([^$]+)\$/.exec(hash);
  if (match === null) return null;

  const parameters = new Map<string, number>();
  for (const pair of (match[3] ?? "").split(",")) {
    const [key, value] = pair.split("=");
    if (key !== undefined && value !== undefined && /^\d+$/.test(value)) {
      parameters.set(key, Number(value));
    }
  }

  const memoryCost = parameters.get("m");
  const timeCost = parameters.get("t");
  const parallelism = parameters.get("p");
  if (memoryCost === undefined || timeCost === undefined || parallelism === undefined) {
    return null;
  }
  return { algorithm: match[1] ?? "", memoryCost, timeCost, parallelism };
}
