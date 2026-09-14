// Firebase Admin configuration, validated once at startup.
//
// Same rationale as packages/email/src/config.ts: a missing credential
// discovered on the first registration is an outage that looks like a user
// problem; discovered at boot, it is a deployment that refuses to start.
//
// This module is ONLY loaded/required when EMAIL_VERIFICATION_PROVIDER is
// "firebase" (see packages/api/src/config/index.ts's parseEmailVerification
// Provider) — a Postmark-mode deployment need not hold any Firebase
// credential at all, and this file is never called in that mode.

export interface FirebaseAdminConfig {
  readonly projectId: string;
  /**
   * Explicit service-account credentials, OR undefined to use Application
   * Default Credentials (the environment's own workload identity — the
   * preferred production strategy where the host supports it, e.g. Cloud
   * Run/GKE with a bound service account). Never a file path read by this
   * module directly — ADC resolution is the SDK's own job.
   */
  readonly serviceAccount?: {
    readonly clientEmail: string;
    /** PEM-encoded. Never logged, never in an error message. */
    readonly privateKey: string;
  };
}

export class FirebaseAdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirebaseAdminConfigError";
  }
}

/**
 * Builds the configuration or refuses to. Takes a plain record rather than
 * reading `process.env` directly — same reasoning as loadPostmarkConfig.
 *
 * Local development: set FIREBASE_SERVICE_ACCOUNT_JSON to the CONTENTS
 * (never commit the file itself) of a downloaded service-account JSON key,
 * one line, e.g. via a local-only .env that is gitignored. Production:
 * prefer leaving it unset and running on a host that provides Application
 * Default Credentials, or inject the same JSON content via a secret
 * manager at deploy time.
 */
export function loadFirebaseAdminConfig(
  env: Readonly<Record<string, string | undefined>>,
): FirebaseAdminConfig {
  const projectId = (env["FIREBASE_PROJECT_ID"] ?? "").trim();
  if (projectId === "") {
    throw new FirebaseAdminConfigError("FIREBASE_PROJECT_ID is required when EMAIL_VERIFICATION_PROVIDER=firebase");
  }

  const serviceAccountJson = env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (serviceAccountJson === undefined || serviceAccountJson.trim() === "") {
    // No explicit credential — Application Default Credentials.
    return { projectId };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    throw new FirebaseAdminConfigError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FirebaseAdminConfigError("FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record["client_email"];
  const privateKey = record["private_key"];
  if (typeof clientEmail !== "string" || clientEmail.trim() === "") {
    throw new FirebaseAdminConfigError("FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email");
  }
  if (typeof privateKey !== "string" || privateKey.trim() === "") {
    throw new FirebaseAdminConfigError("FIREBASE_SERVICE_ACCOUNT_JSON is missing private_key");
  }

  return {
    projectId,
    serviceAccount: { clientEmail, privateKey },
  };
}
