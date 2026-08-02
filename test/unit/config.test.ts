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
});
