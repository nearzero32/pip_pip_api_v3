import { createApp } from "./app";
import { loadConfig } from "./config/env";
import { createDatabaseClient } from "./db/client";
import { createLogger } from "./observability/logger";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config);
const app = createApp({ logger, production: config.nodeEnv === "production", readinessCheck: () => database.ping() });

app.listen({ hostname: config.host, port: config.port });
logger.info({ event: "server_started", host: config.host, port: config.port, environment: config.nodeEnv });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "shutdown_started", signal });
  const timeout = setTimeout(() => {
    logger.error({ event: "shutdown_timeout" });
    process.exit(1);
  }, config.gracefulShutdownTimeoutMs);
  timeout.unref();
  try {
    await app.stop();
    await database.close();
    clearTimeout(timeout);
    logger.info({ event: "shutdown_completed" });
    process.exit(0);
  } catch (error) {
    logger.error({ event: "shutdown_failed", error_name: error instanceof Error ? error.name : "UnknownError" });
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
