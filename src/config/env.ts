export type NodeEnvironment = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  databasePoolSize: number;
  databaseConnectionTimeoutMs: number;
  gracefulShutdownTimeoutMs: number;
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

function integer(env: Record<string, string | undefined>, name: string, minimum: number, maximum: number): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rawNodeEnv = required(env, "NODE_ENV");
  if (!nodeEnvironments.has(rawNodeEnv as NodeEnvironment)) {
    throw new ConfigurationError("NODE_ENV must be development, test, or production");
  }
  const rawLogLevel = required(env, "LOG_LEVEL");
  if (!logLevels.has(rawLogLevel as LogLevel)) {
    throw new ConfigurationError("LOG_LEVEL must be debug, info, warn, or error");
  }

  return {
    nodeEnv: rawNodeEnv as NodeEnvironment,
    host: required(env, "HOST"),
    port: integer(env, "PORT", 1, 65_535),
    logLevel: rawLogLevel as LogLevel,
    databaseUrl: databaseUrl(env),
    databasePoolSize: integer(env, "DATABASE_POOL_SIZE", 1, 100),
    databaseConnectionTimeoutMs: integer(env, "DATABASE_CONNECTION_TIMEOUT_MS", 100, 120_000),
    gracefulShutdownTimeoutMs: integer(env, "GRACEFUL_SHUTDOWN_TIMEOUT_MS", 100, 120_000),
  };
}
