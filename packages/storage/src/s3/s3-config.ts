// Object-storage configuration.
//
// Validated at construction. A storage adapter built from a half-configured
// environment fails on the first upload, which in practice means it fails on a
// customer's document rather than at boot.

import type { StorageZone } from "@lagda/application";

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

export interface S3StorageConfig {
  /**
   * Provider endpoint. Absent means AWS's own regional endpoint.
   *
   * No provider host is hard-coded anywhere in this codebase — not
   * `amazonaws.com`, not `linodeobjects.com`. The deployment decides, which is
   * the whole point of an S3-compatible adapter (§7).
   */
  readonly endpoint?: string;
  readonly region: string;
  /** One bucket per zone. The application never sees these strings (INV-208). */
  readonly buckets: Readonly<Record<StorageZone, string>>;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-host
   * (`bucket.endpoint/key`). Required by MinIO and by several S3-compatible
   * providers that do not offer per-bucket DNS.
   */
  readonly forcePathStyle: boolean;
  readonly requestTimeoutMs: number;
  /**
   * Bounded SDK retries. The SDK retries transport failures; the worker retries
   * jobs. Two layers is deliberate and documented; a third would multiply
   * (§70-72).
   */
  readonly maxAttempts: number;
  /**
   * Set only by tests against a local service. Production configuration cannot
   * reach this: `loadStorageConfig` refuses a plaintext endpoint outside
   * development, so there is no environment variable that turns TLS off in
   * production (INV-211).
   */
  readonly allowInsecureEndpoint: boolean;
}

const REQUIRED = [
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET_ARTIFACTS",
  "OBJECT_STORAGE_BUCKET_QUARANTINE",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
] as const;

function readInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Rejected rather than defaulted. A typo silently becoming the default is
    // how a 30-second timeout turns into whatever the author last assumed.
    throw new StorageConfigError(`${name} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

export function loadStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): S3StorageConfig {
  const missing = REQUIRED.filter(name => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    // Names only. Never the values — this function reads two secrets.
    throw new StorageConfigError(
      `Object storage is not configured. Missing: ${missing.join(", ")}.`,
    );
  }

  const endpoint = env["OBJECT_STORAGE_ENDPOINT"];
  const isProduction = env["NODE_ENV"] === "production";
  const allowInsecure = env["OBJECT_STORAGE_ALLOW_INSECURE"] === "true";

  if (endpoint !== undefined && endpoint !== "" && !endpoint.startsWith("https://")) {
    if (isProduction || !allowInsecure) {
      throw new StorageConfigError(
        "Object storage endpoint must use https. Documents and signing evidence "
        + "travel over this connection. Set OBJECT_STORAGE_ALLOW_INSECURE=true "
        + "only for a local S3-compatible service outside production.",
      );
    }
  }
  if (isProduction && allowInsecure) {
    // Belt and braces: the flag itself is refused in production, so it cannot
    // be left set in a deployment environment file and quietly take effect.
    throw new StorageConfigError(
      "OBJECT_STORAGE_ALLOW_INSECURE cannot be enabled in production.",
    );
  }

  return {
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    region: env["OBJECT_STORAGE_REGION"] ?? "",
    buckets: {
      artifacts: env["OBJECT_STORAGE_BUCKET_ARTIFACTS"] ?? "",
      quarantine: env["OBJECT_STORAGE_BUCKET_QUARANTINE"] ?? "",
    },
    accessKeyId: env["OBJECT_STORAGE_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: env["OBJECT_STORAGE_SECRET_ACCESS_KEY"] ?? "",
    forcePathStyle: env["OBJECT_STORAGE_FORCE_PATH_STYLE"] !== "false",
    requestTimeoutMs: readInt(
      env["OBJECT_STORAGE_REQUEST_TIMEOUT_MS"], "OBJECT_STORAGE_REQUEST_TIMEOUT_MS", 30_000,
    ),
    maxAttempts: readInt(env["OBJECT_STORAGE_MAX_ATTEMPTS"], "OBJECT_STORAGE_MAX_ATTEMPTS", 3),
    allowInsecureEndpoint: allowInsecure && !isProduction,
  };
}

/**
 * The subset of configuration that is safe to log.
 *
 * An allowlist, not a redaction pass. A denylist over a config object leaks the
 * first field someone adds without thinking about it, and this object holds a
 * secret key (INV-212).
 */
export function describeStorageConfig(
  config: S3StorageConfig,
): Record<string, string | number | boolean> {
  return {
    region: config.region,
    endpoint: config.endpoint ?? "(provider default)",
    forcePathStyle: config.forcePathStyle,
    requestTimeoutMs: config.requestTimeoutMs,
    maxAttempts: config.maxAttempts,
    // Bucket NAMES are operational configuration, not secrets. The credentials
    // that reach them are the secret, and neither appears here — not even the
    // access key id, which has no diagnostic value worth the exposure (§105).
    bucketArtifacts: config.buckets.artifacts,
    bucketQuarantine: config.buckets.quarantine,
  };
}
