export type NodeEnvironment = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DatabaseConfig {
  nodeEnv: NodeEnvironment;
  databaseUrl: string;
  databasePoolSize: number;
  databaseConnectionTimeoutMs: number;
}

export interface MediaConfig {
  r2Endpoint: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2PublicBaseUrl: string;
  r2UploadUrlTtlSeconds: number;
  mediaMaxImageBytes: number;
  mediaUnattachedTtlHours: number;
  mediaCleanupIntervalSeconds: number;
  mediaDeleteLeaseSeconds: number;
}

export interface AppConfig extends DatabaseConfig, MediaConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  gracefulShutdownTimeoutMs: number;
  redisUrl: string;
  otpDeliveryAdapter: "development" | "test";
  secretVerifierKey: string;
  secretVerifierKeyVersion: string;
  jwtIssuer: string;
  jwtKeyId: string;
  jwtPrivateKeyBase64: string;
  jwtPublicKeyBase64: string;
  accessTokenLifetimeSeconds: number;
  argon2MemoryCost: number;
  argon2TimeCost: number;
  argon2Parallelism: number;
  osrmBaseUrl: string;
  osrmProfile: "driving";
  osrmTimeoutMs: number;
  deliveryPricingCacheTtlSeconds: number;
  driverOfferSpinLimit: number;
  driverOfferSpinWindowSeconds: number;
  driverOfferClaimLimit: number;
  driverOfferClaimWindowSeconds: number;
  driverRuntimeMutationLimit: number;
  driverRuntimeMutationWindowSeconds: number;
  dashboardManualAssignLimit: number;
  dashboardManualAssignWindowSeconds: number;
  driverRuntimeHydrateLockTtlSeconds: number;
  driverRuntimeHydrateWaitMs: number;
  driverRuntimeHydratePollMs: number;
  driverLocationFreshSeconds: number;
  driverOfferSpinAgeBucketMs: number;
  driverOfferSpinRotationWindowMs: number;
  redisReconEnabled: boolean;
  redisReconPollIntervalMs: number;
  redisReconBatchSize: number;
  redisReconMaxAttempts: number;
  redisReconRetryBaseMs: number;
  redisReconRetryMaxMs: number;
  redisReconLeaseSeconds: number;
  redisReconRetentionDays: number;
  driverRuntimeDegradedTtlMs: number;
  driverRuntimeDegradedMaxEntries: number;
  driverRuntimeHydrateAdvisoryLockTimeoutMs: number;
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

const nodeEnvironments = new Set<NodeEnvironment>(["development", "test", "production"]);
const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`${name} is required`);
  return value;
}

function integer(
  env: Record<string, string | undefined>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integerWithDefault(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function httpUrl(env: Record<string, string | undefined>, name: string): string {
  const raw = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) {
    throw new ConfigurationError(`${name} must use http:// or https:// and include a host`);
  }
  return raw.replace(/\/+$/, "");
}

function databaseUrl(env: Record<string, string | undefined>): string {
  const raw = required(env, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new ConfigurationError("DATABASE_URL must use postgres:// or postgresql:// and include a host and database");
  }
  if (env.NODE_ENV === "production" && /dev_only|changeme|password/i.test(parsed.password)) {
    throw new ConfigurationError("DATABASE_URL uses a development placeholder password in production");
  }
  return raw;
}

export function loadMediaConfig(
  env: Record<string, string | undefined> = process.env,
): MediaConfig {
  const r2Endpoint = httpUrl(env, "R2_ENDPOINT");
  const r2PublicBaseUrl = httpUrl(env, "R2_PUBLIC_BASE_URL");
  return {
    r2Endpoint,
    r2Bucket: required(env, "R2_BUCKET"),
    r2AccessKeyId: required(env, "R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
    r2PublicBaseUrl,
    r2UploadUrlTtlSeconds: integer(env, "R2_UPLOAD_URL_TTL_SECONDS", 60, 900),
    mediaMaxImageBytes: integer(env, "MEDIA_MAX_IMAGE_BYTES", 1024, 20 * 1024 * 1024),
    mediaUnattachedTtlHours: integer(env, "MEDIA_UNATTACHED_TTL_HOURS", 1, 168),
    mediaCleanupIntervalSeconds: integer(env, "MEDIA_CLEANUP_INTERVAL_SECONDS", 60, 3600),
    mediaDeleteLeaseSeconds: integer(env, "MEDIA_DELETE_LEASE_SECONDS", 60, 900),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rawNodeEnv = required(env, "NODE_ENV");
  if (!nodeEnvironments.has(rawNodeEnv as NodeEnvironment)) {
    throw new ConfigurationError("NODE_ENV must be development, test, or production");
  }
  const rawLogLevel = required(env, "LOG_LEVEL");
  if (!logLevels.has(rawLogLevel as LogLevel)) {
    throw new ConfigurationError("LOG_LEVEL must be debug, info, warn, or error");
  }
  const redisUrl = required(env, "REDIS_URL");
  let parsedRedis: URL;
  try { parsedRedis = new URL(redisUrl); } catch { throw new ConfigurationError("REDIS_URL must be a valid Redis URL"); }
  if (!new Set(["redis:", "rediss:"]).has(parsedRedis.protocol) || !parsedRedis.hostname) throw new ConfigurationError("REDIS_URL must use redis:// or rediss:// and include a host");
  const otpDeliveryAdapter = required(env, "OTP_DELIVERY_ADAPTER");
  if (otpDeliveryAdapter !== "development" && otpDeliveryAdapter !== "test") throw new ConfigurationError("OTP_DELIVERY_ADAPTER must be development or test");
  if (rawNodeEnv === "production") throw new ConfigurationError("No production-safe OTP delivery adapter is configured");
  const secretVerifierKey = required(env, "SECRET_VERIFIER_KEY");
  if (secretVerifierKey.length < 32) throw new ConfigurationError("SECRET_VERIFIER_KEY must be at least 32 characters");
  const jwtPrivateKeyBase64 = required(env, "JWT_PRIVATE_KEY_BASE64");
  const jwtPublicKeyBase64 = required(env, "JWT_PUBLIC_KEY_BASE64");
  try { Uint8Array.fromBase64(jwtPrivateKeyBase64); Uint8Array.fromBase64(jwtPublicKeyBase64); } catch { throw new ConfigurationError("JWT keys must be valid base64 DER values"); }

  return {
    nodeEnv: rawNodeEnv as NodeEnvironment,
    host: required(env, "HOST"),
    port: integer(env, "PORT", 1, 65_535),
    logLevel: rawLogLevel as LogLevel,
    databaseUrl: databaseUrl(env),
    databasePoolSize: integer(env, "DATABASE_POOL_SIZE", 1, 100),
    databaseConnectionTimeoutMs: integer(env, "DATABASE_CONNECTION_TIMEOUT_MS", 100, 120_000),
    gracefulShutdownTimeoutMs: integer(env, "GRACEFUL_SHUTDOWN_TIMEOUT_MS", 100, 120_000),
    redisUrl,
    otpDeliveryAdapter,
    secretVerifierKey,
    secretVerifierKeyVersion: required(env, "SECRET_VERIFIER_KEY_VERSION"),
    jwtIssuer: required(env, "JWT_ISSUER"),
    jwtKeyId: required(env, "JWT_KEY_ID"),
    jwtPrivateKeyBase64,
    jwtPublicKeyBase64,
    accessTokenLifetimeSeconds: integer(env, "ACCESS_TOKEN_LIFETIME_SECONDS", 60, 600),
    argon2MemoryCost: integer(env, "ARGON2_MEMORY_COST", 19_456, 1_048_576),
    argon2TimeCost: integer(env, "ARGON2_TIME_COST", 2, 10),
    argon2Parallelism: integer(env, "ARGON2_PARALLELISM", 1, 16),
    osrmBaseUrl: httpUrl(env, "OSRM_BASE_URL"),
    osrmProfile: (()=>{const value=required(env,"OSRM_PROFILE");if(value!=="driving")throw new ConfigurationError("OSRM_PROFILE must be driving");return "driving" as const;})(),
    osrmTimeoutMs: integer(env, "OSRM_TIMEOUT_MS", 100, 30_000),
    deliveryPricingCacheTtlSeconds: integer(env,"DELIVERY_PRICING_CACHE_TTL_SECONDS",3600,86_400),
    driverOfferSpinLimit: integerWithDefault(env, "DRIVER_OFFER_SPIN_LIMIT", 30, 1, 10_000),
    driverOfferSpinWindowSeconds: integerWithDefault(env, "DRIVER_OFFER_SPIN_WINDOW", 60, 1, 86_400),
    driverOfferClaimLimit: integerWithDefault(env, "DRIVER_OFFER_CLAIM_LIMIT", 20, 1, 10_000),
    driverOfferClaimWindowSeconds: integerWithDefault(env, "DRIVER_OFFER_CLAIM_WINDOW", 60, 1, 86_400),
    driverRuntimeMutationLimit: integerWithDefault(env, "DRIVER_RUNTIME_MUTATION_LIMIT", 20, 1, 10_000),
    driverRuntimeMutationWindowSeconds: integerWithDefault(env, "DRIVER_RUNTIME_MUTATION_WINDOW", 60, 1, 86_400),
    dashboardManualAssignLimit: integerWithDefault(env, "DASHBOARD_MANUAL_ASSIGN_LIMIT", 30, 1, 10_000),
    dashboardManualAssignWindowSeconds: integerWithDefault(env, "DASHBOARD_MANUAL_ASSIGN_WINDOW", 60, 1, 86_400),
    driverRuntimeHydrateLockTtlSeconds: integerWithDefault(env, "DRIVER_RUNTIME_HYDRATE_LOCK_TTL_SECONDS", 8, 1, 60),
    driverRuntimeHydrateWaitMs: integerWithDefault(env, "DRIVER_RUNTIME_HYDRATE_WAIT_MS", 2_000, 50, 30_000),
    driverRuntimeHydratePollMs: integerWithDefault(env, "DRIVER_RUNTIME_HYDRATE_POLL_MS", 50, 10, 5_000),
    driverLocationFreshSeconds: integerWithDefault(env, "DRIVER_LOCATION_FRESH_SECONDS", 120, 1, 86_400),
    driverOfferSpinAgeBucketMs: integerWithDefault(env, "DRIVER_OFFER_SPIN_AGE_BUCKET_MS", 60_000, 1_000, 3_600_000),
    driverOfferSpinRotationWindowMs: integerWithDefault(env, "DRIVER_OFFER_SPIN_ROTATION_WINDOW_MS", 15_000, 1_000, 3_600_000),
    redisReconEnabled: (() => {
      const raw = env.REDIS_RECON_ENABLED?.trim().toLowerCase();
      if (!raw) return true;
      if (raw === "0" || raw === "false" || raw === "no") return false;
      return true;
    })(),
    redisReconPollIntervalMs: integerWithDefault(env, "REDIS_RECON_POLL_INTERVAL_MS", 2_000, 500, 300_000),
    redisReconBatchSize: integerWithDefault(env, "REDIS_RECON_BATCH_SIZE", 25, 1, 500),
    redisReconMaxAttempts: integerWithDefault(env, "REDIS_RECON_MAX_ATTEMPTS", 12, 1, 100),
    redisReconRetryBaseMs: integerWithDefault(env, "REDIS_RECON_RETRY_BASE_MS", 1_000, 100, 60_000),
    redisReconRetryMaxMs: integerWithDefault(env, "REDIS_RECON_RETRY_MAX_MS", 60_000, 1_000, 600_000),
    redisReconLeaseSeconds: integerWithDefault(env, "REDIS_RECON_LEASE_SECONDS", 90, 5, 600),
    redisReconRetentionDays: integerWithDefault(env, "REDIS_RECON_RETENTION_DAYS", 7, 1, 90),
    driverRuntimeDegradedTtlMs: integerWithDefault(env, "DRIVER_RUNTIME_DEGRADED_TTL_MS", 2_000, 100, 60_000),
    driverRuntimeDegradedMaxEntries: integerWithDefault(env, "DRIVER_RUNTIME_DEGRADED_MAX_ENTRIES", 2_000, 10, 100_000),
    driverRuntimeHydrateAdvisoryLockTimeoutMs: integerWithDefault(env, "DRIVER_RUNTIME_HYDRATE_ADVISORY_LOCK_TIMEOUT_MS", 2_000, 50, 30_000),
    ...loadMediaConfig(env),
  };
}

export function loadDatabaseConfig(env: Record<string, string | undefined> = process.env): DatabaseConfig {
  const rawNodeEnv = required(env, "NODE_ENV");
  if (!nodeEnvironments.has(rawNodeEnv as NodeEnvironment)) throw new ConfigurationError("NODE_ENV must be development, test, or production");
  return {
    nodeEnv: rawNodeEnv as NodeEnvironment,
    databaseUrl: databaseUrl(env),
    databasePoolSize: integer(env, "DATABASE_POOL_SIZE", 1, 100),
    databaseConnectionTimeoutMs: integer(env, "DATABASE_CONNECTION_TIMEOUT_MS", 100, 120_000),
  };
}
