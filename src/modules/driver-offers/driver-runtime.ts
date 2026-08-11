import { RedisClient } from "bun";
import type { SQL } from "bun";
import type { Logger } from "../../observability/logger";
import type { NodeEnvironment } from "../../config/env";
import type { DriverPricingStage } from "../../db/schema/driver-offers";
import {
  cityOpenOffersKey,
  driverLocationKey,
  driverRuntimeHydrateLockKey,
  driverRuntimeKey,
  offerSummaryKey,
} from "./redis-keys";

export type DriverEligibilityStatus = "ELIGIBLE" | "INELIGIBLE";
export type DriverWorkStatus = "AVAILABLE" | "BUSY" | "OFFLINE";
export type LocationFreshness = "FRESH" | "STALE" | "MISSING";

export type DriverRuntimeState = {
  driverId: string;
  cityId: string;
  eligibilityStatus: DriverEligibilityStatus;
  workStatus: DriverWorkStatus;
  activeOrderCount: number;
  eligibilityVersion: number;
  updatedAt: string;
};

export type OpenOfferSummary = {
  offerId: string;
  orderId: string;
  cityId: string;
  openedAt: string;
  pricingBaseSnapshot: number;
  roundingUnitSnapshot: number;
  pricingStagesSnapshot: DriverPricingStage[];
  pricingVersionSnapshot: number;
};

export type DriverLocationState = {
  driverId: string;
  cityId: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
};

export type HydrationLockConfig = {
  lockTtlSeconds: number;
  waitMs: number;
  pollMs: number;
};

export const DEFAULT_HYDRATION_LOCK: HydrationLockConfig = {
  lockTtlSeconds: 8,
  waitMs: 2_000,
  pollMs: 50,
};

export const DRIVER_RUNTIME_TTL_SECONDS = 86_400;
export const DRIVER_LOCATION_TTL_SECONDS = 120;
export const OFFER_SUMMARY_TTL_SECONDS = 86_400;

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class DriverRuntimeStore {
  readonly client: RedisClient;
  private hydration: HydrationLockConfig;
  private locationFreshSeconds: number;

  constructor(
    url: string,
    private environment: NodeEnvironment,
    private logger: Logger,
    options?: {
      hydration?: Partial<HydrationLockConfig>;
      locationFreshSeconds?: number;
    },
  ) {
    this.client = new RedisClient(url, {
      connectionTimeout: 3000,
      idleTimeout: 30,
    });
    this.hydration = { ...DEFAULT_HYDRATION_LOCK, ...options?.hydration };
    this.locationFreshSeconds =
      options?.locationFreshSeconds ?? DRIVER_LOCATION_TTL_SECONDS;
  }

  async getRuntime(driverId: string): Promise<DriverRuntimeState | null> {
    try {
      const raw = await this.client.get(
        driverRuntimeKey(this.environment, driverId),
      );
      if (!raw) return null;
      return JSON.parse(raw) as DriverRuntimeState;
    } catch (error) {
      this.logger.warn({
        event: "driver_runtime_read_failed",
        driver_id: driverId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }

  async mgetRuntimes(
    driverIds: string[],
  ): Promise<Map<string, DriverRuntimeState | null>> {
    const out = new Map<string, DriverRuntimeState | null>();
    if (driverIds.length === 0) return out;
    try {
      const keys = driverIds.map((id) =>
        driverRuntimeKey(this.environment, id),
      );
      const values = (await this.client.send("MGET", keys)) as (string | null)[];
      for (let i = 0; i < driverIds.length; i++) {
        const raw = values[i];
        out.set(
          driverIds[i]!,
          raw ? (JSON.parse(raw) as DriverRuntimeState) : null,
        );
      }
    } catch (error) {
      this.logger.warn({
        event: "driver_runtime_mget_failed",
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      for (const id of driverIds) out.set(id, null);
    }
    return out;
  }

  async setRuntime(state: DriverRuntimeState): Promise<void> {
    try {
      await this.client.send("SET", [
        driverRuntimeKey(this.environment, state.driverId),
        JSON.stringify(state),
        "EX",
        String(DRIVER_RUNTIME_TTL_SECONDS),
      ]);
    } catch (error) {
      this.logger.error({
        event: "driver_runtime_write_failed",
        driver_id: state.driverId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      await this.invalidateRuntime(state.driverId);
    }
  }

  async invalidateRuntime(driverId: string): Promise<void> {
    try {
      await this.client.del(driverRuntimeKey(this.environment, driverId));
    } catch (error) {
      this.logger.warn({
        event: "driver_runtime_invalidate_failed",
        driver_id: driverId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  /**
   * Hydrate under a Redis lock with owner token + Lua release.
   * Waiters poll cache until wait budget expires; they do not stampede PG.
   * Conservative hydrate defaults workStatus to OFFLINE when no active orders.
   */
  async getOrHydrateRuntime(
    driverId: string,
    hydrate: () => Promise<DriverRuntimeState>,
  ): Promise<DriverRuntimeState> {
    const cached = await this.getRuntime(driverId);
    if (cached) return cached;

    const lockKey = driverRuntimeHydrateLockKey(this.environment, driverId);
    const owner = crypto.randomUUID();
    let acquired = false;
    try {
      const result = await this.client.send("SET", [
        lockKey,
        owner,
        "NX",
        "EX",
        String(this.hydration.lockTtlSeconds),
      ]);
      acquired = result === "OK";
    } catch {
      // Redis down — fall back to single PG hydrate without caching guarantee.
      return hydrate();
    }

    if (!acquired) {
      const deadline = Date.now() + this.hydration.waitMs;
      while (Date.now() < deadline) {
        await Bun.sleep(this.hydration.pollMs);
        const again = await this.getRuntime(driverId);
        if (again) return again;
      }
      // Lock expired without cache: try to become owner once.
      try {
        const retry = await this.client.send("SET", [
          lockKey,
          owner,
          "NX",
          "EX",
          String(this.hydration.lockTtlSeconds),
        ]);
        acquired = retry === "OK";
      } catch {
        return hydrate();
      }
      if (!acquired) {
        const last = await this.getRuntime(driverId);
        if (last) return last;
        // Safe fallback: hydrate once; PG remains source of truth for claim.
        return hydrate();
      }
    }

    try {
      const state = await hydrate();
      await this.setRuntime(state);
      return state;
    } finally {
      try {
        await this.client.send("EVAL", [
          releaseLockScript,
          "1",
          lockKey,
          owner,
        ]);
      } catch {
        /* TTL will clear */
      }
    }
  }

  async publishOpenOffer(summary: OpenOfferSummary): Promise<void> {
    const score = new Date(summary.openedAt).getTime();
    try {
      await this.client.send("ZADD", [
        cityOpenOffersKey(this.environment, summary.cityId),
        String(score),
        summary.offerId,
      ]);
      await this.client.send("SET", [
        offerSummaryKey(this.environment, summary.offerId),
        JSON.stringify(summary),
        "EX",
        String(OFFER_SUMMARY_TTL_SECONDS),
      ]);
    } catch (error) {
      this.logger.error({
        event: "open_offer_index_write_failed",
        offer_id: summary.offerId,
        city_id: summary.cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async removeOpenOffer(cityId: string, offerId: string): Promise<void> {
    try {
      await this.client.send("ZREM", [
        cityOpenOffersKey(this.environment, cityId),
        offerId,
      ]);
      await this.client.del(offerSummaryKey(this.environment, offerId));
    } catch (error) {
      this.logger.warn({
        event: "open_offer_index_remove_failed",
        offer_id: offerId,
        city_id: cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async listOpenOfferIds(cityId: string, limit: number): Promise<string[]> {
    try {
      const ids = (await this.client.send("ZRANGE", [
        cityOpenOffersKey(this.environment, cityId),
        "0",
        String(Math.max(0, limit - 1)),
      ])) as string[];
      return ids ?? [];
    } catch (error) {
      this.logger.warn({
        event: "open_offer_index_read_failed",
        city_id: cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return [];
    }
  }

  async getOfferSummary(offerId: string): Promise<OpenOfferSummary | null> {
    try {
      const raw = await this.client.get(
        offerSummaryKey(this.environment, offerId),
      );
      if (!raw) return null;
      return JSON.parse(raw) as OpenOfferSummary;
    } catch {
      return null;
    }
  }

  async rebuildCityOpenOffers(
    cityId: string,
    offers: OpenOfferSummary[],
  ): Promise<void> {
    const key = cityOpenOffersKey(this.environment, cityId);
    try {
      await this.client.del(key);
      for (const offer of offers) await this.publishOpenOffer(offer);
    } catch (error) {
      this.logger.error({
        event: "open_offer_index_rebuild_failed",
        city_id: cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async getLocation(driverId: string): Promise<DriverLocationState | null> {
    try {
      const raw = await this.client.get(
        driverLocationKey(this.environment, driverId),
      );
      if (!raw) return null;
      return JSON.parse(raw) as DriverLocationState;
    } catch {
      return null;
    }
  }

  async mgetLocations(
    driverIds: string[],
  ): Promise<Map<string, DriverLocationState | null>> {
    const out = new Map<string, DriverLocationState | null>();
    if (driverIds.length === 0) return out;
    try {
      const keys = driverIds.map((id) =>
        driverLocationKey(this.environment, id),
      );
      const values = (await this.client.send("MGET", keys)) as (string | null)[];
      for (let i = 0; i < driverIds.length; i++) {
        const raw = values[i];
        out.set(
          driverIds[i]!,
          raw ? (JSON.parse(raw) as DriverLocationState) : null,
        );
      }
    } catch {
      for (const id of driverIds) out.set(id, null);
    }
    return out;
  }

  locationFreshness(recordedAt: string | null | undefined): LocationFreshness {
    if (!recordedAt) return "MISSING";
    const ageMs = Date.now() - new Date(recordedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return "MISSING";
    if (ageMs <= this.locationFreshSeconds * 1000) return "FRESH";
    return "STALE";
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

/**
 * Build runtime from PostgreSQL.
 * Active assignments → BUSY. Otherwise OFFLINE (never invent AVAILABLE).
 */
export async function hydrateDriverRuntimeFromPostgres(
  client: SQL,
  driverId: string,
): Promise<DriverRuntimeState | null> {
  const [row] = await client<
    {
      city_id: string | null;
      approval_status: string;
      operational_status: string;
      account_status: string;
      active_count: number;
    }[]
  >`select
      dp.city_id::text as city_id,
      dp.approval_status::text as approval_status,
      dp.operational_status::text as operational_status,
      a.status::text as account_status,
      (
        select count(*)::int
        from order_driver_assignments oda
        where oda.driver_id = dp.account_id
          and oda.completed_at is null
          and oda.cancelled_at is null
      ) as active_count
    from driver_profiles dp
    join accounts a on a.id = dp.account_id
    where dp.account_id = ${driverId}`;
  if (!row || !row.city_id) return null;
  const eligible =
    row.account_status === "ACTIVE" &&
    row.approval_status === "APPROVED" &&
    row.operational_status === "ACTIVE";
  const activeOrderCount = Number(row.active_count);
  const workStatus: DriverWorkStatus =
    activeOrderCount > 0 ? "BUSY" : "OFFLINE";
  return {
    driverId,
    cityId: row.city_id,
    eligibilityStatus: eligible ? "ELIGIBLE" : "INELIGIBLE",
    workStatus,
    activeOrderCount,
    eligibilityVersion: 1,
    updatedAt: new Date().toISOString(),
  };
}

/** In-memory runtime store for integration tests (no Redis). */
export class FakeDriverRuntimeStore {
  private runtimes = new Map<string, DriverRuntimeState>();
  private summaries = new Map<string, OpenOfferSummary>();
  private cityOffers = new Map<string, Map<string, number>>();
  private locations = new Map<string, DriverLocationState>();
  hydrateCalls = 0;
  locationFreshSeconds = DRIVER_LOCATION_TTL_SECONDS;

  async getRuntime(driverId: string): Promise<DriverRuntimeState | null> {
    return this.runtimes.get(driverId) ?? null;
  }

  async mgetRuntimes(driverIds: string[]) {
    const out = new Map<string, DriverRuntimeState | null>();
    for (const id of driverIds) out.set(id, this.runtimes.get(id) ?? null);
    return out;
  }

  async setRuntime(state: DriverRuntimeState): Promise<void> {
    this.runtimes.set(state.driverId, state);
  }

  async invalidateRuntime(driverId: string): Promise<void> {
    this.runtimes.delete(driverId);
  }

  async getOrHydrateRuntime(
    driverId: string,
    hydrate: () => Promise<DriverRuntimeState>,
  ): Promise<DriverRuntimeState> {
    const cached = await this.getRuntime(driverId);
    if (cached) return cached;
    this.hydrateCalls++;
    const state = await hydrate();
    await this.setRuntime(state);
    return state;
  }

  async publishOpenOffer(summary: OpenOfferSummary): Promise<void> {
    const score = new Date(summary.openedAt).getTime();
    const bucket = this.cityOffers.get(summary.cityId) ?? new Map();
    bucket.set(summary.offerId, score);
    this.cityOffers.set(summary.cityId, bucket);
    this.summaries.set(summary.offerId, summary);
  }

  async removeOpenOffer(cityId: string, offerId: string): Promise<void> {
    this.cityOffers.get(cityId)?.delete(offerId);
    this.summaries.delete(offerId);
  }

  async listOpenOfferIds(cityId: string, limit: number): Promise<string[]> {
    const bucket = this.cityOffers.get(cityId);
    if (!bucket) return [];
    return [...bucket.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, limit))
      .map(([id]) => id);
  }

  async getOfferSummary(offerId: string): Promise<OpenOfferSummary | null> {
    return this.summaries.get(offerId) ?? null;
  }

  async rebuildCityOpenOffers(
    cityId: string,
    offers: OpenOfferSummary[],
  ): Promise<void> {
    this.cityOffers.set(cityId, new Map());
    for (const offer of offers) await this.publishOpenOffer(offer);
  }

  async getLocation(driverId: string): Promise<DriverLocationState | null> {
    return this.locations.get(driverId) ?? null;
  }

  async mgetLocations(driverIds: string[]) {
    const out = new Map<string, DriverLocationState | null>();
    for (const id of driverIds) out.set(id, this.locations.get(id) ?? null);
    return out;
  }

  locationFreshness(recordedAt: string | null | undefined): LocationFreshness {
    if (!recordedAt) return "MISSING";
    const ageMs = Date.now() - new Date(recordedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return "MISSING";
    if (ageMs <= this.locationFreshSeconds * 1000) return "FRESH";
    return "STALE";
  }

  setLocationForTest(location: DriverLocationState): void {
    this.locations.set(location.driverId, location);
  }

  async close(): Promise<void> {
    this.runtimes.clear();
    this.summaries.clear();
    this.cityOffers.clear();
    this.locations.clear();
  }
}

export type DriverRuntimeStoreLike =
  | DriverRuntimeStore
  | FakeDriverRuntimeStore;
