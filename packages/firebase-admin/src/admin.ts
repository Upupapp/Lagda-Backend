// Firebase Admin — backend-only. Never imported by anything reachable from
// a frontend bundle; the credentials this module holds must never leave the
// server process (P2 migration mission §6/§23).
//
// Scope, deliberately narrow: this is a VERIFICATION-ONLY identity bridge.
// It never touches Firestore, Storage, Analytics, or Hosting, and it never
// becomes LAGDA's session/authorization authority — see verify-email.ts's
// finalizeFirebaseEmailVerification, which re-checks everything this module
// reports before LAGDA's own database is ever written to.

import {
  initializeApp, getApps, cert, applicationDefault, type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import type { FirebaseAdminConfig } from "./config.js";

export interface FirebaseVerificationAdmin {
  /**
   * Ensures a Firebase Auth user exists for this UID with this email, and
   * with `emailVerified` reset to false — creating it on first use,
   * correcting the email on a stale row from a previous email-change
   * attempt, and NEVER touching an unrelated Firebase user (the UID is the
   * whole match; a mismatched existing UID with a DIFFERENT purpose is not
   * something this function can create by construction, since the UID is
   * always LAGDA's own deterministic derivation — see firebaseUid()).
   */
  readonly ensureVerificationUser: (input: {
    readonly uid: string;
    readonly email: string;
  }) => Promise<void>;
  /**
   * Short-lived (Firebase-fixed ~1 hour), single-purpose: signing into
   * Firebase Web Auth as this UID so the CLIENT can call
   * `sendEmailVerification()`. Grants no other capability — this Firebase
   * user has no password, no other provider linked, and is never used for
   * anything but sending/checking its own verification-email state.
   */
  readonly mintCustomToken: (uid: string) => Promise<string>;
  /**
   * Server-side read of Firebase's own verification state. Never trust the
   * browser's copy of this — always re-read it here at finalization time.
   * Returns null if no such Firebase user exists.
   */
  readonly getVerificationState: (
    uid: string,
  ) => Promise<{ readonly email: string; readonly emailVerified: boolean } | null>;
}

let cachedApp: App | null = null;

function getFirebaseApp(config: FirebaseAdminConfig): App {
  if (cachedApp !== null) return cachedApp;
  const existing = getApps().find((app) => app.name === "lagda-verification");
  if (existing !== undefined) {
    cachedApp = existing;
    return existing;
  }
  cachedApp = initializeApp({
    projectId: config.projectId,
    credential: config.serviceAccount === undefined
      ? applicationDefault()
      : cert({
        projectId: config.projectId,
        clientEmail: config.serviceAccount.clientEmail,
        privateKey: config.serviceAccount.privateKey,
      }),
  }, "lagda-verification");
  return cachedApp;
}

export function createFirebaseVerificationAdmin(
  config: FirebaseAdminConfig,
): FirebaseVerificationAdmin {
  const auth: Auth = getAuth(getFirebaseApp(config));

  return {
    async ensureVerificationUser(input) {
      try {
        const existing = await auth.getUser(input.uid);
        if (existing.email !== input.email) {
          // A LAGDA account's email cannot actually change today (no such
          // route exists), but fail SAFE rather than assume: correct the
          // Firebase side to match LAGDA's own canonical record and reset
          // emailVerified, rather than silently trust a stale Firebase row.
          await auth.updateUser(input.uid, { email: input.email, emailVerified: false });
        }
      } catch (error) {
        if (isUserNotFoundError(error)) {
          await auth.createUser({ uid: input.uid, email: input.email, emailVerified: false });
          return;
        }
        throw error;
      }
    },

    async mintCustomToken(uid) {
      return auth.createCustomToken(uid);
    },

    async getVerificationState(uid) {
      try {
        const user = await auth.getUser(uid);
        if (user.email === undefined) return null;
        return { email: user.email, emailVerified: user.emailVerified };
      } catch (error) {
        if (isUserNotFoundError(error)) return null;
        throw error;
      }
    },
  };
}

function isUserNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "auth/user-not-found"
  );
}
