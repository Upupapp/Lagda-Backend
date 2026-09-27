// 085. An in-memory model of the PostgreSQL verification throttle.
//
// The same rules, in the same order, as `repositories/verification-throttle.ts`
// in @lagda/db; the integration suite proves the adapter holds them.

import type {
  VerificationAccessThrottle, VerificationCodeReservation,
} from "../common/ports/verification-access.js";

export interface MemoryVerificationThrottle extends VerificationAccessThrottle {
  /** Accepted code requests, oldest first, by pair key and verification key. */
  readonly requests: { readonly pair: string; readonly verificationId: string; readonly at: number }[];
  readonly pairs: Map<string, { attempts: number; streak: number; lockedUntil: number | null }>;
  /** Makes every call throw, to exercise fail-closed. */
  failing: boolean;
}

export function createMemoryVerificationThrottle(): MemoryVerificationThrottle {
  const requests: { pair: string; verificationId: string; at: number }[] = [];
  const pairs = new Map<string, { attempts: number; streak: number; lockedUntil: number | null }>();

  const throttle: MemoryVerificationThrottle = {
    requests,
    pairs,
    failing: false,

    reserveCodeRequest({ keys, now, rules }) {
      if (throttle.failing) return Promise.reject(new Error("throttle unavailable"));
      const pair = keys.pairKey;
      const verificationId = keys.verificationKey;
      const limited = (
        reason: "lockout" | "cooldown" | "pair-daily" | "verification-hourly", retryAt: number,
      ): Promise<VerificationCodeReservation> =>
        Promise.resolve({ outcome: "limited", reason, retryAt });

      const state = pairs.get(pair);
      if (state !== undefined && state.lockedUntil !== null && state.lockedUntil > now) {
        return limited("lockout", state.lockedUntil);
      }
      const forPair = requests.filter(r => r.pair === pair && r.at > now - rules.pairDailyWindowMs);
      const latest = forPair.at(-1);
      if (latest !== undefined && latest.at > now - rules.cooldownMs) {
        return limited("cooldown", latest.at + rules.cooldownMs);
      }
      if (forPair.length >= rules.pairDailyLimit) {
        const oldest = forPair[forPair.length - rules.pairDailyLimit];
        return limited("pair-daily", (oldest?.at ?? now) + rules.pairDailyWindowMs);
      }
      const forVerification = requests.filter(r =>
        r.verificationId === verificationId && r.at > now - rules.verificationHourlyWindowMs);
      if (forVerification.length >= rules.verificationHourlyLimit) {
        const oldest = forVerification[forVerification.length - rules.verificationHourlyLimit];
        return limited("verification-hourly", (oldest?.at ?? now) + rules.verificationHourlyWindowMs);
      }
      requests.push({ pair, verificationId, at: now });
      pairs.set(pair, { attempts: 0, streak: state?.streak ?? 0, lockedUntil: state?.lockedUntil ?? null });
      return Promise.resolve({ outcome: "allowed" });
    },

    recordRedemption({ keys, now, success, rules }) {
      if (throttle.failing) return Promise.reject(new Error("throttle unavailable"));
      const pair = keys.pairKey;
      const state = pairs.get(pair) ?? { attempts: 0, streak: 0, lockedUntil: null };
      if (success) {
        pairs.set(pair, { ...state, attempts: 0, streak: 0 });
        return Promise.resolve();
      }
      if (state.attempts >= rules.maxAttempts) {
        pairs.set(pair, state);
        return Promise.resolve();
      }
      const attempts = state.attempts + 1;
      let streak = state.streak;
      let lockedUntil = state.lockedUntil;
      if (attempts >= rules.maxAttempts) {
        streak += 1;
        if (streak >= rules.lockoutAfterExhausted) {
          lockedUntil = now + rules.lockoutMs;
          streak = 0;
        }
      }
      pairs.set(pair, { attempts, streak, lockedUntil });
      return Promise.resolve();
    },
  };
  return throttle;
}
