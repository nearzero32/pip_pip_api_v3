import { createApp } from "./app";
import { loadConfig } from "./config/env";
import { createDatabaseClient } from "./db/client";
import { createLogger } from "./observability/logger";
import { createShutdownHandler, registerSignalHandlers } from "./shutdown";
import { createAuthModule } from "./modules/auth/auth-module";
import { DevelopmentOtpDelivery, TestOtpDelivery } from "./modules/auth/phone/delivery";
import { RedisRateLimiter } from "./modules/auth/rate-limit/redis-rate-limiter";
import { GeographyService } from "./modules/geography/service";
import { MediaCleanupWorker } from "./modules/media/cleanup-worker";
import { MediaService } from "./modules/media/media.service";
import { R2MediaStorage } from "./modules/media/r2-media-storage";
import { MainCategoryService } from "./modules/catalog/main-category.service";
import { SubcategoryService } from "./modules/catalog/subcategory.service";
import { StoreService } from "./modules/stores/store.service";
import { StoreCategoryService } from "./modules/catalog/store-category.service";
import { ProductService } from "./modules/catalog/product.service";
import { ModifierService } from "./modules/catalog/modifier.service";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config);
const rateLimiter = new RedisRateLimiter(config.redisUrl);
const delivery = config.otpDeliveryAdapter === "test" ? new TestOtpDelivery() : new DevelopmentOtpDelivery();
const authModule = createAuthModule(database.client, rateLimiter, delivery, config);
const geographyService = new GeographyService(database.client, authModule.sessions);
const mediaStorage = new R2MediaStorage(config);
const mediaService = new MediaService(database.client, mediaStorage, config, logger);
const mainCategoryService = new MainCategoryService(
  database.client,
  mediaService,
  config,
);
const subcategoryService = new SubcategoryService(
  database.client,
  mediaService,
  config,
);
const storeService = new StoreService(database.client, mediaService, config);
const storeCategoryService = new StoreCategoryService(database.client);
const productService = new ProductService(database.client, mediaService, config);
const modifierService = new ModifierService(database.client);
const mediaCleanup = new MediaCleanupWorker(database.client, mediaStorage, config, logger);
mediaCleanup.start();

const app = createApp({
  logger,
  authModule,
  geographyService,
  mediaService,
  mainCategoryService,
  subcategoryService,
  storeService,
  storeCategoryService,
  productService,
  modifierService,
  production: config.nodeEnv === "production",
  readinessCheck: () => database.ping(),
  redisReadinessCheck: async () => {
    await rateLimiter.client.ping();
  },
});

app.listen({ hostname: config.host, port: config.port });
logger.info({ event: "server_started", host: config.host, port: config.port, environment: config.nodeEnv });

const shutdown = createShutdownHandler({
  stopServer: async () => {
    await mediaCleanup.stop();
    await app.stop();
  },
  closeDatabase: async () => {
    await rateLimiter.close();
    await database.close();
  },
  logger,
  timeoutMs: config.gracefulShutdownTimeoutMs,
  exit: (code) => process.exit(code),
});
registerSignalHandlers(shutdown);
