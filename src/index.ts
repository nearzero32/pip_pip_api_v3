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
import { CartService } from "./modules/cart/cart.service";
import { CustomerAddressService } from "./modules/customer-addresses/customer-address.service";
import { DeliveryPricingService } from "./modules/delivery-pricing/delivery-pricing.service";
import { OsrmRoutingProvider } from "./modules/delivery-pricing/osrm-routing-provider";
import { RedisActivePricingCache } from "./modules/delivery-pricing/active-pricing-cache";
import { OrderService } from "./modules/orders/order.service";
import { CityDriverPricingService } from "./modules/driver-offers/city-driver-pricing.service";
import { DriverRuntimeStore } from "./modules/driver-offers/driver-runtime";
import { OfferService } from "./modules/driver-offers/offer.service";
import { loadOfferLimits } from "./modules/driver-offers/offer-limits";

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
const cartService = new CartService(database.client);
const customerAddressService = new CustomerAddressService(database.client);
const routingProvider = new OsrmRoutingProvider(config.osrmBaseUrl, config.osrmProfile, config.osrmTimeoutMs, logger);
const activePricingCache = new RedisActivePricingCache(config.redisUrl);
const deliveryPricingService = new DeliveryPricingService(database.client, routingProvider, logger, activePricingCache, {cacheTtlSeconds:config.deliveryPricingCacheTtlSeconds,routingTimeoutMs:config.osrmTimeoutMs,routingProvider:"OSRM"});
const orderService = new OrderService(database.client, deliveryPricingService);
const driverRuntimeStore = new DriverRuntimeStore(config.redisUrl, config.nodeEnv, logger);
const cityDriverPricingService = new CityDriverPricingService(database.client);
const offerLimits = loadOfferLimits({
  DRIVER_OFFER_SPIN_LIMIT: String(config.driverOfferSpinLimit),
  DRIVER_OFFER_SPIN_WINDOW: String(config.driverOfferSpinWindowSeconds),
  DRIVER_OFFER_CLAIM_LIMIT: String(config.driverOfferClaimLimit),
  DRIVER_OFFER_CLAIM_WINDOW: String(config.driverOfferClaimWindowSeconds),
  DRIVER_RUNTIME_MUTATION_LIMIT: String(config.driverRuntimeMutationLimit),
  DRIVER_RUNTIME_MUTATION_WINDOW: String(config.driverRuntimeMutationWindowSeconds),
  DASHBOARD_MANUAL_ASSIGN_LIMIT: String(config.dashboardManualAssignLimit),
  DASHBOARD_MANUAL_ASSIGN_WINDOW: String(config.dashboardManualAssignWindowSeconds),
});
const offerService = new OfferService(
  database.client,
  rateLimiter,
  driverRuntimeStore,
  orderService,
  logger,
  config.nodeEnv,
  offerLimits,
);
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
  cartService,
  customerAddressService,
  deliveryPricingService,
  orderService,
  cityDriverPricingService,
  offerService,
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
    activePricingCache.close();
    await driverRuntimeStore.close();
    await database.close();
  },
  logger,
  timeoutMs: config.gracefulShutdownTimeoutMs,
  exit: (code) => process.exit(code),
});
registerSignalHandlers(shutdown);
