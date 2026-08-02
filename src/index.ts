import { createApp } from "./app";
import { loadConfig } from "./config/env";
import { createDatabaseClient } from "./db/client";
import { createLogger } from "./observability/logger";
import { createShutdownHandler, registerSignalHandlers } from "./shutdown";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config);
const app = createApp({ logger, production: config.nodeEnv === "production", readinessCheck: () => database.ping() });

app.listen({ hostname: config.host, port: config.port });
logger.info({ event: "server_started", host: config.host, port: config.port, environment: config.nodeEnv });

const shutdown = createShutdownHandler({
  stopServer: async () => { await app.stop(); },
  closeDatabase: () => database.close(),
  logger,
  timeoutMs: config.gracefulShutdownTimeoutMs,
  exit: (code) => process.exit(code),
});
registerSignalHandlers(shutdown);
