import { SQL } from "bun";
import type { AppConfig } from "../../src/config/env";
import { createApp } from "../../src/app";
import { applyMigrations } from "../../src/db/migration-runner";
import { seedGovernorates } from "../../src/db/seed";
import {
  createAuthModule,
  type AuthModule,
} from "../../src/modules/auth/auth-module";
import { TestOtpDelivery } from "../../src/modules/auth/phone/delivery";
import { InMemoryRateLimiter } from "../../src/modules/auth/rate-limit/rate-limiter";
import { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";
import { GeographyService } from "../../src/modules/geography/service";
import { MediaCleanupWorker } from "../../src/modules/media/cleanup-worker";
import { FakeMediaStorage } from "../../src/modules/media/fake-media-storage";
import { MediaService } from "../../src/modules/media/media.service";
import { MainCategoryService } from "../../src/modules/catalog/main-category.service";
import { SubcategoryService } from "../../src/modules/catalog/subcategory.service";
import { StoreCategoryService } from "../../src/modules/catalog/store-category.service";
import { ProductService } from "../../src/modules/catalog/product.service";
import { ModifierService } from "../../src/modules/catalog/modifier.service";
import { CartService } from "../../src/modules/cart/cart.service";
import { CustomerAddressService } from "../../src/modules/customer-addresses/customer-address.service";
import { DeliveryPricingService } from "../../src/modules/delivery-pricing/delivery-pricing.service";
import { FakeRoutingProvider } from "../../src/modules/delivery-pricing/routing-provider";
import { FakeActivePricingCache } from "../../src/modules/delivery-pricing/active-pricing-cache";
import { OrderService } from "../../src/modules/orders/order.service";
import { CityDriverPricingService } from "../../src/modules/driver-offers/city-driver-pricing.service";
import {
  FakeDriverRuntimeStore,
} from "../../src/modules/driver-offers/driver-runtime";
import { OfferService } from "../../src/modules/driver-offers/offer.service";
import { DEFAULT_OFFER_LIMITS } from "../../src/modules/driver-offers/offer-limits";
import { StoreService } from "../../src/modules/stores/store.service";
import { silentLogger } from "../../src/observability/logger";
import { decodeBase64Url } from "../../src/modules/auth/shared/encoding";

export const integrationConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "error",
  databaseUrl: process.env.TEST_ADMIN_DATABASE_URL!,
  databasePoolSize: 5,
  databaseConnectionTimeoutMs: 5000,
  gracefulShutdownTimeoutMs: 5000,
  redisUrl: process.env.TEST_REDIS_URL ?? "redis://localhost:6380",
  otpDeliveryAdapter: "test",
  secretVerifierKey: "integration-verifier-key-at-least-32-characters",
  secretVerifierKeyVersion: "v1",
  jwtIssuer: "integration",
  jwtKeyId: "integration-v1",
  jwtPrivateKeyBase64:
    "MC4CAQAwBQYDK2VwBCIEIOhYjslG5wawzghWHcQbYCMjFp8kzMYLVFZoKEOBzTA4",
  jwtPublicKeyBase64:
    "MCowBQYDK2VwAyEA+ly2CeP4N1AQ5vNUEt226L6GtOMU/uLE2rjFfo4OBCE=",
  accessTokenLifetimeSeconds: 600,
  argon2MemoryCost: 19456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  r2Endpoint: "https://example.r2.cloudflarestorage.com",
  r2Bucket: "test-bucket",
  r2AccessKeyId: "test-access-key-id",
  r2SecretAccessKey: "test-secret-access-key",
  r2PublicBaseUrl: "https://media.test.example.com",
  r2UploadUrlTtlSeconds: 300,
  mediaMaxImageBytes: 5_242_880,
  mediaUnattachedTtlHours: 24,
  mediaCleanupIntervalSeconds: 900,
  mediaDeleteLeaseSeconds: 300,
  osrmBaseUrl: "https://osrm.test.invalid",
  osrmProfile: "driving",
  osrmTimeoutMs: 1000,
  deliveryPricingCacheTtlSeconds: 21600,
  driverOfferSpinLimit: DEFAULT_OFFER_LIMITS.spinLimit,
  driverOfferSpinWindowSeconds: DEFAULT_OFFER_LIMITS.spinWindowSeconds,
  driverOfferClaimLimit: DEFAULT_OFFER_LIMITS.claimLimit,
  driverOfferClaimWindowSeconds: DEFAULT_OFFER_LIMITS.claimWindowSeconds,
  driverRuntimeMutationLimit: DEFAULT_OFFER_LIMITS.runtimeMutationLimit,
  driverRuntimeMutationWindowSeconds:
    DEFAULT_OFFER_LIMITS.runtimeMutationWindowSeconds,
  dashboardManualAssignLimit: DEFAULT_OFFER_LIMITS.dashboardManualAssignLimit,
  dashboardManualAssignWindowSeconds:
    DEFAULT_OFFER_LIMITS.dashboardManualAssignWindowSeconds,
  driverRuntimeHydrateLockTtlSeconds: DEFAULT_OFFER_LIMITS.hydrateLockTtlSeconds,
  driverRuntimeHydrateWaitMs: DEFAULT_OFFER_LIMITS.hydrateWaitMs,
  driverRuntimeHydratePollMs: DEFAULT_OFFER_LIMITS.hydratePollMs,
  driverLocationFreshSeconds: DEFAULT_OFFER_LIMITS.locationFreshSeconds,
  driverOfferSpinAgeBucketMs: DEFAULT_OFFER_LIMITS.spinAgeBucketMs,
  driverOfferSpinRotationWindowMs: DEFAULT_OFFER_LIMITS.spinRotationWindowMs,
};

export const seededGovernorateId = "11111111-1111-4111-8111-000000000001";

export const requireSafeAdminUrl = () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("TEST_ADMIN_DATABASE_URL is required");
  const parsed = new URL(adminUrl);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    /prod/i.test(parsed.pathname)
  )
    throw new Error("Unsafe integration database");
  return adminUrl;
};

/** Normalize SQL text and detect table references to roles / account_roles. */
export const referencesRoleTables = (sql: string): boolean => {
  const normalized = sql
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /(?:^|[\s,(])(?:only\s+)?(?:public\.)?(?:account_roles|roles)(?:\s|\)|,|$)/.test(
    normalized,
  );
};

export const trackSql = (client: SQL) => {
  const queries: string[] = [];
  const wrap = (target: SQL): SQL =>
    new Proxy(target, {
      apply(t, thisArg, args) {
        const strings = args[0] as TemplateStringsArray;
        queries.push(strings.join(""));
        return Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      },
      get(t, prop, receiver) {
        if (prop === "begin") {
          return async (fn: (tx: SQL) => Promise<unknown>) =>
            (t as SQL & { begin: Function }).begin((tx: SQL) => fn(wrap(tx)));
        }
        if (prop === "unsafe") {
          return (sql: string, values?: unknown[]) => {
            queries.push(sql);
            return (
              t as SQL & {
                unsafe: (query: string, params?: unknown[]) => unknown;
              }
            ).unsafe(sql, values);
          };
        }
        const value = Reflect.get(t, prop, receiver);
        if (typeof value === "function") return value.bind(t);
        return value;
      },
    }) as SQL;
  return { client: wrap(client), queries };
};

export const tokenClaims = (token: string) =>
  JSON.parse(
    new TextDecoder().decode(decodeBase64Url(token.split(".")[1]!)),
  ) as Record<string, unknown>;

export type IntegrationHarness = {
  admin: SQL;
  client: SQL;
  delivery: TestOtpDelivery;
  auth: AuthModule;
  geography: GeographyService;
  media: MediaService;
  mediaStorage: FakeMediaStorage;
  mediaCleanup: MediaCleanupWorker;
  mainCategories: MainCategoryService;
  subcategories: SubcategoryService;
  stores: StoreService;
  storeCategories: StoreCategoryService;
  products: ProductService;
  modifiers: ModifierService;
  cart: CartService;
  addresses: CustomerAddressService;
  deliveryPricing: DeliveryPricingService;
  orders: OrderService;
  cityDriverPricing: CityDriverPricingService;
  offers: OfferService;
  driverRuntime: FakeDriverRuntimeStore;
  routingProvider: FakeRoutingProvider;
  activePricingCache: FakeActivePricingCache;
  app: ReturnType<typeof createApp>;
  clock: { value: number; advance: () => void };
  close: () => Promise<void>;
};

export async function createIntegrationHarness(options?: {
  trackClient?: boolean;
  seed?: boolean;
  databasePrefix?: string;
}): Promise<
  IntegrationHarness & { trackedQueries?: string[]; trackedClient?: SQL }
> {
  const adminUrl = requireSafeAdminUrl();
  const dbName = `${options?.databasePrefix ?? "pip_pip_v3_test"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${dbName}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const raw = new SQL(url.toString(), { max: 12 });
  const tracked = options?.trackClient ? trackSql(raw) : undefined;
  const client = tracked?.client ?? raw;
  await applyMigrations(raw);
  const [postgis] = await raw<{ installed: boolean }[]>`
    select exists(select 1 from pg_extension where extname = 'postgis') as installed`;
  if (!postgis?.installed) {
    throw new Error(
      "PostGIS extension is required for integration tests; use postgis/postgis:17-3.5",
    );
  }
  if (options?.seed !== false) await seedGovernorates(raw);
  const clock = {
    value: Date.now(),
    advance: () => {
      clock.value += 3_600_001;
    },
  };
  const delivery = new TestOtpDelivery();
  const rateLimiterForAuth = new InMemoryRateLimiter(() => clock.value);
  const auth = createAuthModule(
    client,
    rateLimiterForAuth,
    delivery,
    { ...integrationConfig, databaseUrl: url.toString() },
  );
  const geography = new GeographyService(client, auth.sessions);
  const mediaStorage = new FakeMediaStorage();
  const mediaConfig = {
    ...integrationConfig,
    databaseUrl: url.toString(),
  };
  const media = new MediaService(
    client,
    mediaStorage,
    mediaConfig,
    silentLogger,
  );
  const mediaCleanup = new MediaCleanupWorker(
    client,
    mediaStorage,
    mediaConfig,
    silentLogger,
  );
  const mainCategories = new MainCategoryService(client, media, mediaConfig);
  const subcategories = new SubcategoryService(client, media, mediaConfig);
  const stores = new StoreService(client, media, mediaConfig);
  const storeCategories = new StoreCategoryService(client);
  const products = new ProductService(client, media, mediaConfig);
  const modifiers = new ModifierService(client);
  const cart = new CartService(client);
  const addresses = new CustomerAddressService(client);
  const routingProvider = new FakeRoutingProvider({ distanceMeters: 1000, durationSeconds: 120 });
  const activePricingCache = new FakeActivePricingCache();
  const deliveryPricing = new DeliveryPricingService(client,routingProvider,silentLogger,activePricingCache,{cacheTtlSeconds:21600,routingTimeoutMs:1000,routingProvider:"OSRM"});
  const rateLimiter = new InMemoryRateLimiter(() => clock.value);
  const driverRuntime = new FakeDriverRuntimeStore();
  const orders = new OrderService(client, deliveryPricing, driverRuntime, silentLogger);
  const cityDriverPricing = new CityDriverPricingService(client);
  const offers = new OfferService(
    client,
    rateLimiter,
    driverRuntime,
    orders,
    silentLogger,
    "test",
    DEFAULT_OFFER_LIMITS,
  );
  const app = createApp({
    logger: silentLogger,
    production: false,
    readinessCheck: async () => undefined,
    authModule: auth,
    geographyService: geography,
    mediaService: media,
    mainCategoryService: mainCategories,
    subcategoryService: subcategories,
    storeService: stores,
    storeCategoryService: storeCategories,
    productService: products,
    modifierService: modifiers,
    cartService: cart,
    customerAddressService: addresses,
    deliveryPricingService: deliveryPricing,
    orderService: orders,
    cityDriverPricingService: cityDriverPricing,
    offerService: offers,
    driverRuntime,
  });
  const result: IntegrationHarness & {
    trackedQueries?: string[];
    trackedClient?: SQL;
  } = {
    admin,
    client,
    delivery,
    auth,
    geography,
    media,
    mediaStorage,
    mediaCleanup,
    mainCategories,
    subcategories,
    stores,
    storeCategories,
    products,
    modifiers,
    cart,
    addresses,
    deliveryPricing,
    orders,
    cityDriverPricing,
    offers,
    driverRuntime,
    routingProvider,
    activePricingCache,
    app,
    clock,
    close: async () => {
      await mediaCleanup.stop();
      await driverRuntime.close();
      await raw.close();
      await admin.unsafe(`drop database if exists "${dbName}" with(force)`);
      await admin.close();
    },
  };
  if (tracked) {
    result.trackedQueries = tracked.queries;
    result.trackedClient = tracked.client;
  }
  return result;
}

export async function createStaffAccount(
  auth: AuthModule,
  client: SQL,
  input: {
    email: string;
    password: string;
    roles: string[];
    cityId?: string;
    managedByAccountId?: string;
  },
) {
  const [account] = await client<
    { id: string }[]
  >`insert into accounts default values returning id`;
  await client`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${account!.id},${input.email},${input.email.toLowerCase()},now(),true)`;
  await client`insert into staff_profiles(account_id,status,managed_by_account_id)values(${account!.id},'ACTIVE',${input.managedByAccountId ?? null})`;
  const hash = await new Argon2PasswordHasher({
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  }).hash(input.password);
  await client`insert into password_credentials(account_id,argon2id_hash)values(${account!.id},${hash})`;
  for (const roleCode of input.roles) {
    await auth.roles.assignRole({
      accountId: account!.id,
      roleCode,
      grantedByAccountId: input.managedByAccountId ?? account!.id,
      ...(input.cityId ? { cityId: input.cityId } : {}),
    });
  }
  return account!.id;
}

/** Create an ACTIVE city under the seeded Baghdad governorate for staff tests. */
export async function createActiveCity(
  client: SQL,
  nameEn = `City ${crypto.randomUUID().slice(0, 8)}`,
) {
  const [city] = await client<
    { id: string }[]
  >`insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order)
    values(${seededGovernorateId},${nameEn},${nameEn},33.3,44.4,'ACTIVE',1) returning id`;
  return city!.id;
}

export async function createDriverAccount(
  client: SQL,
  phone: string,
  code: string,
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
  cityId?: string,
) {
  let resolvedCityId = cityId ?? null;
  if (status === "ACTIVE" && !resolvedCityId) {
    resolvedCityId = await createActiveCity(client);
  }
  const [account] = await client<
    { id: string }[]
  >`insert into accounts default values returning id`;
  await client`insert into account_phones(account_id,phone_e164,verified_at,is_primary)values(${account!.id},${phone},now(),true)`;
  const [reviewer] = await client<
    { id: string }[]
  >`insert into accounts default values returning id`;
  const [application] = await client<
    { id: string }[]
  >`insert into driver_applications(account_id,status,decided_at,decided_by_account_id)values(${account!.id},'APPROVED',now(),${reviewer!.id})returning id`;
  const hasher = new Argon2PasswordHasher({
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await client`insert into driver_profiles(account_id,approved_application_id,operational_status,driver_photo_object_key,access_code_hash,city_id)values(${account!.id},${application!.id},${status},'photo',${await hasher.hash(code)},${resolvedCityId})`;
  return account!.id;
}

export const jsonRequest = (
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) => {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const requestInit: RequestInit = {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
  };
  if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
  return new Request(`http://localhost${path}`, requestInit);
};
