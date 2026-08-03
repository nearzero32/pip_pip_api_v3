import { createApp } from "./app";
import { loadConfig } from "./config/env";
import { createDatabaseClient } from "./db/client";
import { createLogger } from "./observability/logger";
import { createShutdownHandler, registerSignalHandlers } from "./shutdown";
import { createAuthModule } from "./modules/auth/auth-module";
import { DevelopmentOtpDelivery, TestOtpDelivery } from "./modules/auth/phone/delivery";
import { RedisRateLimiter } from "./modules/auth/rate-limit/redis-rate-limiter";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config);
const rateLimiter = new RedisRateLimiter(config.redisUrl);
const delivery = config.otpDeliveryAdapter === "test" ? new TestOtpDelivery() : new DevelopmentOtpDelivery();
const authModule = createAuthModule(database.client, rateLimiter, delivery, config);
const app = createApp({ logger, authModule, production: config.nodeEnv === "production", readinessCheck: () => database.ping(), redisReadinessCheck: async () => { await rateLimiter.client.ping(); } });

app.listen({ hostname: config.host, port: config.port });
logger.info({ event: "server_started", host: config.host, port: config.port, environment: config.nodeEnv });

const shutdown = createShutdownHandler({
  stopServer: async () => { await app.stop(); },
  closeDatabase: async () => { await rateLimiter.close(); await database.close(); },
  logger,
  timeoutMs: config.gracefulShutdownTimeoutMs,
  exit: (code) => process.exit(code),
});
registerSignalHandlers(shutdown);
