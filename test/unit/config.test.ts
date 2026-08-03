import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../../src/config/env";

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
    });
  });

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
});
