import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig, loadMediaConfig } from "../../src/config/env";
import {
  buildCategoryImageObjectKey,
  buildPublicMediaUrl,
  canonicalExtensionForContentType,
  validateOriginalFileName,
} from "../../src/modules/media/object-key";
import {
  assertImageSignatureMatches,
  detectImageContentTypeFromPrefix,
} from "../../src/modules/media/signatures";
import { AppError } from "../../src/errors/app-error";
import { redact } from "../../src/shared/redaction/redact";

const validEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3000",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgresql://test:test@localhost:5432/pip_pip_test",
  DATABASE_POOL_SIZE: "5",
  DATABASE_CONNECTION_TIMEOUT_MS: "1000",
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: "5000",
  REDIS_URL: "redis://localhost:6379",
  OTP_DELIVERY_ADAPTER: "test",
  SECRET_VERIFIER_KEY: "test-verifier-key-that-is-at-least-32-characters",
  SECRET_VERIFIER_KEY_VERSION: "v1",
  JWT_ISSUER: "test-issuer",
  JWT_KEY_ID: "test-key-v1",
  JWT_PRIVATE_KEY_BASE64: "MC4CAQAwBQYDK2VwBCIEIOhYjslG5wawzghWHcQbYCMjFp8kzMYLVFZoKEOBzTA4",
  JWT_PUBLIC_KEY_BASE64: "MCowBQYDK2VwAyEA+ly2CeP4N1AQ5vNUEt226L6GtOMU/uLE2rjFfo4OBCE=",
  ACCESS_TOKEN_LIFETIME_SECONDS: "600",
  ARGON2_MEMORY_COST: "65536",
  ARGON2_TIME_COST: "3",
  ARGON2_PARALLELISM: "1",
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com/",
  R2_BUCKET: "bucket",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_PUBLIC_BASE_URL: "https://cdn.example.com/",
  R2_UPLOAD_URL_TTL_SECONDS: "300",
  MEDIA_MAX_IMAGE_BYTES: "5242880",
  MEDIA_UNATTACHED_TTL_HOURS: "24",
  MEDIA_CLEANUP_INTERVAL_SECONDS: "900",
  MEDIA_DELETE_LEASE_SECONDS: "300",
  OSRM_BASE_URL: "https://osrm.test.example/",
  OSRM_PROFILE: "driving",
  OSRM_TIMEOUT_MS: "3000",
  DELIVERY_PRICING_CACHE_TTL_SECONDS: "21600",
};

describe("configuration", () => {
  test("loads valid configuration", () => {
    expect(loadConfig(validEnv)).toEqual({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: validEnv.DATABASE_URL,
      databasePoolSize: 5,
      databaseConnectionTimeoutMs: 1000,
      gracefulShutdownTimeoutMs: 5000,
      redisUrl: validEnv.REDIS_URL,
      otpDeliveryAdapter: "test",
      secretVerifierKey: validEnv.SECRET_VERIFIER_KEY,
      secretVerifierKeyVersion: "v1",
      jwtIssuer: "test-issuer",
      jwtKeyId: "test-key-v1",
      jwtPrivateKeyBase64: validEnv.JWT_PRIVATE_KEY_BASE64,
      jwtPublicKeyBase64: validEnv.JWT_PUBLIC_KEY_BASE64,
      accessTokenLifetimeSeconds: 600,
      argon2MemoryCost: 65536,
      argon2TimeCost: 3,
      argon2Parallelism: 1,
      osrmBaseUrl: "https://osrm.test.example",
      osrmProfile: "driving",
      osrmTimeoutMs: 3000,
      deliveryPricingCacheTtlSeconds: 21600,
      r2Endpoint: "https://acct.r2.cloudflarestorage.com",
      r2Bucket: "bucket",
      r2AccessKeyId: "key",
      r2SecretAccessKey: "secret",
      r2PublicBaseUrl: "https://cdn.example.com",
      r2UploadUrlTtlSeconds: 300,
      mediaMaxImageBytes: 5_242_880,
      mediaUnattachedTtlHours: 24,
      mediaCleanupIntervalSeconds: 900,
      mediaDeleteLeaseSeconds: 300,
    });
  });
  test("validates delivery cache TTL and fixes OSRM profile",()=>{expect(()=>loadConfig({...validEnv,DELIVERY_PRICING_CACHE_TTL_SECONDS:"0"})).toThrow(ConfigurationError);expect(()=>loadConfig({...validEnv,OSRM_PROFILE:"walking"})).toThrow(ConfigurationError);});

  test("fails when required configuration is missing", () => {
    const env = { ...validEnv, DATABASE_URL: undefined };
    expect(() => loadConfig(env)).toThrow(new ConfigurationError("DATABASE_URL is required"));
  });

  test.each([
    ["PORT", "0"],
    ["PORT", "70000"],
    ["PORT", "not-a-number"],
    ["DATABASE_POOL_SIZE", "0"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "99"],
  ])("rejects invalid %s", (name, value) => {
    expect(() => loadConfig({ ...validEnv, [name]: value })).toThrow(ConfigurationError);
  });

  test("rejects an invalid database URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "mysql://localhost/db" })).toThrow(ConfigurationError);
  });

  test("rejects development placeholder credentials in production", () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "production", DATABASE_URL: "postgresql://user:dev_only@db/prod" })).toThrow(ConfigurationError);
  });

  test("requires a valid Redis URL", () => {
    expect(() => loadConfig({ ...validEnv, REDIS_URL: "http://localhost:6379" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnv, REDIS_URL: undefined })).toThrow(ConfigurationError);
  });

  test("rejects unsafe Argon2 and OTP delivery production configuration", () => {
    expect(() => loadConfig({ ...validEnv, ARGON2_MEMORY_COST: "1024" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "production", DATABASE_URL: "postgresql://user:a-strong-nonplaceholder@db/pip_pip", OTP_DELIVERY_ADAPTER: "development" })).toThrow(new ConfigurationError("No production-safe OTP delivery adapter is configured"));
  });

  test("normalizes R2 public base URL and validates media bounds", () => {
    const media = loadMediaConfig(validEnv);
    expect(media.r2PublicBaseUrl).toBe("https://cdn.example.com");
    expect(media.r2Endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(() =>
      loadMediaConfig({ ...validEnv, R2_UPLOAD_URL_TTL_SECONDS: "30" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadMediaConfig({ ...validEnv, R2_PUBLIC_BASE_URL: "not-a-url" }),
    ).toThrow(ConfigurationError);
  });
});

describe("media object keys and signatures", () => {
  test("maps canonical extensions and builds category keys", () => {
    expect(canonicalExtensionForContentType("image/jpeg")).toBe("jpg");
    expect(canonicalExtensionForContentType("image/png")).toBe("png");
    expect(canonicalExtensionForContentType("image/webp")).toBe("webp");
    const cityId = "11111111-1111-4111-8111-000000000099";
    const assetId = "22222222-2222-4222-8222-000000000099";
    expect(buildCategoryImageObjectKey(cityId, assetId, "image/webp")).toBe(
      `cities/${cityId}/categories/${assetId}/original.webp`,
    );
  });

  test("validates filenames", () => {
    expect(validateOriginalFileName("ok.webp")).toBe("ok.webp");
    expect(() => validateOriginalFileName("bad\nname.webp")).toThrow();
    expect(() => validateOriginalFileName("a".repeat(256))).toThrow();
  });

  test("detects JPEG PNG WebP and rejects SVG/fakes", () => {
    expect(detectImageContentTypeFromPrefix(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe(
      "image/jpeg",
    );
    expect(
      detectImageContentTypeFromPrefix(
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe("image/png");
    const webp = new TextEncoder().encode("RIFF....WEBP");
    expect(detectImageContentTypeFromPrefix(webp)).toBe("image/webp");
    expect(detectImageContentTypeFromPrefix(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(() =>
      assertImageSignatureMatches(new TextEncoder().encode("<svg></svg>"), "image/png"),
    ).toThrow(AppError);
  });

  test("public URL rules", () => {
    expect(
      buildPublicMediaUrl("https://cdn.example.com/", "cities/a/x.webp", "PUBLIC", "READY"),
    ).toBe("https://cdn.example.com/cities/a/x.webp");
    expect(
      buildPublicMediaUrl("https://cdn.example.com", "cities/a/x.webp", "PRIVATE", "READY"),
    ).toBeNull();
    expect(
      buildPublicMediaUrl("https://cdn.example.com", "cities/a/x.webp", "PUBLIC", "PENDING_UPLOAD"),
    ).toBeNull();
  });

  test("redacts R2 secrets and upload URLs", () => {
    const redacted = redact({
      r2_secret_access_key: "super-secret",
      access_key_id: "key",
      upload_url: "https://presigned",
      asset_id: "ok",
    }) as Record<string, string>;
    expect(redacted.r2_secret_access_key).toBe("[REDACTED]");
    expect(redacted.access_key_id).toBe("[REDACTED]");
    expect(redacted.upload_url).toBe("[REDACTED]");
    expect(redacted.asset_id).toBe("ok");
  });
});
