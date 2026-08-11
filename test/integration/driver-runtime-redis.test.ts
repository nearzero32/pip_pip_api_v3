import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DRIVER_RUNTIME_TTL_SECONDS,
  DriverRuntimeStore,
} from "../../src/modules/driver-offers/driver-runtime";
import {
  cityOpenOffersKey,
  driverRuntimeKey,
  redisAppPrefix,
} from "../../src/modules/driver-offers/redis-keys";
import { silentLogger } from "../../src/observability/logger";

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error("TEST_REDIS_URL is required for Redis integration tests");

describe("driver runtime redis", () => {
  let store: DriverRuntimeStore;
  const driverId = crypto.randomUUID();
  const cityId = crypto.randomUUID();

  beforeAll(() => {
    store = new DriverRuntimeStore(redisUrl!, "test", silentLogger);
  });

  afterAll(async () => {
    await store.invalidateRuntime(driverId);
    await store.removeOpenOffer(cityId, "offer-cleanup");
    await store.close();
  });

  test("key namespace and runtime serialization with TTL", async () => {
    expect(redisAppPrefix("test")).toBe("pip-pip:test");
    expect(driverRuntimeKey("test", driverId)).toBe(
      `pip-pip:test:driver:runtime:${driverId}`,
    );
    expect(cityOpenOffersKey("test", cityId)).toContain(cityId);

    const state = {
      driverId,
      cityId,
      eligibilityStatus: "ELIGIBLE" as const,
      workStatus: "AVAILABLE" as const,
      activeOrderCount: 0,
      eligibilityVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    await store.setRuntime(state);
    const loaded = await store.getRuntime(driverId);
    expect(loaded).toEqual(state);
    const ttl = await store.client.send("TTL", [
      driverRuntimeKey("test", driverId),
    ]);
    expect(Number(ttl)).toBeGreaterThan(0);
    expect(Number(ttl)).toBeLessThanOrEqual(DRIVER_RUNTIME_TTL_SECONDS);
  });

  test("hydrate lock path fills cache on miss", async () => {
    const missDriver = crypto.randomUUID();
    let hydrations = 0;
    const first = await store.getOrHydrateRuntime(missDriver, async () => {
      hydrations++;
      return {
        driverId: missDriver,
        cityId,
        eligibilityStatus: "ELIGIBLE",
        workStatus: "AVAILABLE",
        activeOrderCount: 0,
        eligibilityVersion: 1,
        updatedAt: new Date().toISOString(),
      };
    });
    const second = await store.getOrHydrateRuntime(missDriver, async () => {
      hydrations++;
      return first;
    });
    expect(first.driverId).toBe(missDriver);
    expect(second.driverId).toBe(missDriver);
    expect(hydrations).toBe(1);
    await store.invalidateRuntime(missDriver);
  });

  test("rebuild city open offers index", async () => {
    const offerId = crypto.randomUUID();
    await store.rebuildCityOpenOffers(cityId, [
      {
        offerId,
        orderId: crypto.randomUUID(),
        cityId,
        openedAt: new Date().toISOString(),
        pricingBaseSnapshot: 1000,
        roundingUnitSnapshot: 250,
        pricingStagesSnapshot: [{ afterSeconds: 0, increasePercentage: 0 }],
        pricingVersionSnapshot: 1,
      },
    ]);
    const ids = await store.listOpenOfferIds(cityId, 10);
    expect(ids).toContain(offerId);
    await store.removeOpenOffer(cityId, offerId);
  });
});
