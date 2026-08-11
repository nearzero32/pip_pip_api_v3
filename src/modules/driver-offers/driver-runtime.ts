import { RedisClient } from "bun";
import type { SQL } from "bun";
import type { Logger } from "../../observability/logger";
import type { NodeEnvironment } from "../../config/env";
import type { DriverPricingStage } from "../../db/schema/driver-offers";
import {
  cityOpenOffersKey,
  cityOpenOffersRevisionKey,
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
  /** Monotonic CAS token mirrored from driver_runtime_revisions when known. */
  revision?: number;
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

export type DegradedHydrationConfig = {
  ttlMs: number;
  maxEntries: number;
  advisoryLockTimeoutMs: number;
};

export const DEFAULT_HYDRATION_LOCK: HydrationLockConfig = {
  lockTtlSeconds: 8,
  waitMs: 2_000,
  pollMs: 50,
};

export const DEFAULT_DEGRADED_HYDRATION: DegradedHydrationConfig = {
  ttlMs: 2_000,
  maxEntries: 2_000,
  advisoryLockTimeoutMs: 2_000,
};

export const DRIVER_RUNTIME_TTL_SECONDS = 86_400;
export const DRIVER_LOCATION_TTL_SECONDS = 120;
export const OFFER_SUMMARY_TTL_SECONDS = 86_400;

export type RuntimeCasResult =
  | "APPLIED"
  | "ALREADY_CURRENT"
  | "STALE_REJECTED";

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * Atomic runtime write with revision CAS inside Redis (single EVAL).
 * Rejects older revisions; rejects unrevisioned writes over a revised key.
 * Equal revision refreshes payload/TTL (idempotent) and returns ALREADY_CURRENT.
 */
const setRuntimeCasScript = `
local key = KEYS[1]
local payload = ARGV[1]
local incomingRaw = ARGV[2]
local ttl = tonumber(ARGV[3])
local incomingRev = nil
if incomingRaw ~= nil and incomingRaw ~= '' then
  incomingRev = tonumber(incomingRaw)
end
local raw = redis.call('GET', key)
if raw then
  local curMatch = string.match(raw, '"revision"%s*:%s*(%d+)')
  local curRev = curMatch and tonumber(curMatch) or nil
  if incomingRev == nil then
    if curRev ~= nil then
      return 'STALE_REJECTED'
    end
  elseif curRev ~= nil then
    if curRev > incomingRev then
      return 'STALE_REJECTED'
    end
    if curRev == incomingRev then
      redis.call('SET', key, payload, 'EX', ttl)
      return 'ALREADY_CURRENT'
    end
  end
end
redis.call('SET', key, payload, 'EX', ttl)
return 'APPLIED'
`;

export function evaluateRuntimeCasInMemory(
  existing: DriverRuntimeState | null | undefined,
  incoming: DriverRuntimeState,
): RuntimeCasResult {
  const incomingRev = incoming.revision;
  const curRev = existing?.revision;
  if (incomingRev == null) {
    if (curRev != null) return "STALE_REJECTED";
  } else if (curRev != null) {
    if (curRev > incomingRev) return "STALE_REJECTED";
    if (curRev === incomingRev) return "ALREADY_CURRENT";
  }
  return "APPLIED";
}

export function evaluateCityRevisionCas(
  currentRevision: number,
  incomingRevision: number,
): RuntimeCasResult {
  if (currentRevision > incomingRevision) return "STALE_REJECTED";
  if (currentRevision === incomingRevision) return "ALREADY_CURRENT";
  return "APPLIED";
}

/**
 * Full city ZSET rebuild under revision CAS (single EVAL).
 * KEYS[1]=zset KEYS[2]=revision
 * ARGV[1]=incomingRev ARGV[2]=memberCount then score,member pairs
 */
const rebuildCityOpenOffersCasScript = `
local zkey = KEYS[1]
local rkey = KEYS[2]
local incoming = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local curRaw = redis.call('GET', rkey)
local cur = curRaw and tonumber(curRaw) or 0
if cur > incoming then
  return 'STALE_REJECTED'
end
redis.call('DEL', zkey)
local i = 3
while i <= 2 + (count * 2) do
  redis.call('ZADD', zkey, ARGV[i], ARGV[i + 1])
  i = i + 2
end
redis.call('SET', rkey, incoming)
if cur == incoming then
  return 'ALREADY_CURRENT'
end
return 'APPLIED'
`;

/** Incremental ZADD under city revision CAS. */
const publishCityOpenOfferCasScript = `
local zkey = KEYS[1]
local rkey = KEYS[2]
local incoming = tonumber(ARGV[1])
local score = ARGV[2]
local member = ARGV[3]
local curRaw = redis.call('GET', rkey)
local cur = curRaw and tonumber(curRaw) or 0
if cur > incoming then
  return 'STALE_REJECTED'
end
redis.call('ZADD', zkey, score, member)
if cur < incoming then
  redis.call('SET', rkey, incoming)
  return 'APPLIED'
end
return 'ALREADY_CURRENT'
`;

/** Incremental ZREM under city revision CAS. */
const removeCityOpenOfferCasScript = `
local zkey = KEYS[1]
local rkey = KEYS[2]
local incoming = tonumber(ARGV[1])
local member = ARGV[2]
local curRaw = redis.call('GET', rkey)
local cur = curRaw and tonumber(curRaw) or 0
if cur > incoming then
  return 'STALE_REJECTED'
end
redis.call('ZREM', zkey, member)
if cur < incoming then
  redis.call('SET', rkey, incoming)
  return 'APPLIED'
end
return 'ALREADY_CURRENT'
`;


export class DriverRuntimeStore {
  readonly client: RedisClient;
  private hydration: HydrationLockConfig;
  private degraded: DegradedHydrationConfig;
  private locationFreshSeconds: number;
  private sql: SQL | null;
  private singleflight = new Map<string, Promise<DriverRuntimeState>>();
  private degradedCache = new Map<
    string,
    { state: DriverRuntimeState; expiresAt: number }
  >();
  private degradedOrder: string[] = [];

  constructor(
    url: string,
    private environment: NodeEnvironment,
    private logger: Logger,
    options?: {
      hydration?: Partial<HydrationLockConfig>;
      degraded?: Partial<DegradedHydrationConfig>;
      locationFreshSeconds?: number;
      sql?: SQL;
    },
  ) {
    this.client = new RedisClient(url, {
      connectionTimeout: 3000,
      idleTimeout: 30,
    });
    this.hydration = { ...DEFAULT_HYDRATION_LOCK, ...options?.hydration };
    this.degraded = { ...DEFAULT_DEGRADED_HYDRATION, ...options?.degraded };
    this.locationFreshSeconds =
      options?.locationFreshSeconds ?? DRIVER_LOCATION_TTL_SECONDS;
    this.sql = options?.sql ?? null;
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

  async setRuntimeWithCas(state: DriverRuntimeState): Promise<RuntimeCasResult> {
    this.clearDegraded(state.driverId);
    try {
      const result = await this.client.send("EVAL", [
        setRuntimeCasScript,
        "1",
        driverRuntimeKey(this.environment, state.driverId),
        JSON.stringify(state),
        state.revision != null ? String(state.revision) : "",
        String(DRIVER_RUNTIME_TTL_SECONDS),
      ]);
      const normalized =
        result === "APPLIED" ||
        result === "ALREADY_CURRENT" ||
        result === "STALE_REJECTED"
          ? result
          : "APPLIED";
      return normalized;
    } catch (error) {
      this.logger.error({
        event: "driver_runtime_write_failed",
        driver_id: state.driverId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      await this.invalidateRuntime(state.driverId);
      throw error;
    }
  }

  async setRuntime(state: DriverRuntimeState): Promise<void> {
    await this.setRuntimeWithCas(state);
  }

  async invalidateRuntime(driverId: string): Promise<void> {
    this.clearDegraded(driverId);
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
   * When Redis is unavailable: process-local singleflight + bounded degraded cache,
   * and optional PostgreSQL advisory xact lock to serialize hydrate across instances.
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
      return this.hydrateWhenRedisUnavailable(driverId, hydrate);
    }

    if (!acquired) {
      const deadline = Date.now() + this.hydration.waitMs;
      while (Date.now() < deadline) {
        await Bun.sleep(this.hydration.pollMs);
        const again = await this.getRuntime(driverId);
        if (again) return again;
      }
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
        return this.hydrateWhenRedisUnavailable(driverId, hydrate);
      }
      if (!acquired) {
        const last = await this.getRuntime(driverId);
        if (last) return last;
        return this.hydrateWhenRedisUnavailable(driverId, hydrate);
      }
    }

    try {
      const state = await hydrate();
      try {
        await this.setRuntime(state);
      } catch {
        this.putDegraded(driverId, state);
      }
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

  /**
   * Redis-down path: process-local singleflight + short degraded cache.
   * Optional PG advisory xact lock reduces cross-instance hydrate stampedes.
   * Not a distributed cache — each instance still may hydrate once.
   */
  private async hydrateWhenRedisUnavailable(
    driverId: string,
    hydrate: () => Promise<DriverRuntimeState>,
  ): Promise<DriverRuntimeState> {
    const degradedHit = this.getDegraded(driverId);
    if (degradedHit) return degradedHit;

    const inflight = this.singleflight.get(driverId);
    if (inflight) return inflight;

    const promise = (async () => {
      const state = await this.hydrateWithOptionalAdvisory(driverId, hydrate);
      this.putDegraded(driverId, state);
      return state;
    })().finally(() => {
      this.singleflight.delete(driverId);
    });
    this.singleflight.set(driverId, promise);
    return promise;
  }

  private async hydrateWithOptionalAdvisory(
    driverId: string,
    hydrate: () => Promise<DriverRuntimeState>,
  ): Promise<DriverRuntimeState> {
    if (!this.sql) return hydrate();
    return this.sql.begin(async (tx) => {
      await tx`select set_config('lock_timeout', ${String(this.degraded.advisoryLockTimeoutMs)}, true)`;
      try {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`driver-runtime-hydrate:${driverId}`}, 0))`;
      } catch {
        // lock_timeout — proceed without exclusivity
      }
      return hydrate();
    });
  }

  private getDegraded(driverId: string): DriverRuntimeState | null {
    const hit = this.degradedCache.get(driverId);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.clearDegraded(driverId);
      return null;
    }
    return hit.state;
  }

  private putDegraded(driverId: string, state: DriverRuntimeState): void {
    while (this.degradedOrder.length >= this.degraded.maxEntries) {
      const oldest = this.degradedOrder.shift();
      if (oldest) this.degradedCache.delete(oldest);
    }
    if (!this.degradedCache.has(driverId)) this.degradedOrder.push(driverId);
    this.degradedCache.set(driverId, {
      state,
      expiresAt: Date.now() + this.degraded.ttlMs,
    });
  }

  clearDegraded(driverId: string): void {
    this.degradedCache.delete(driverId);
    this.degradedOrder = this.degradedOrder.filter((id) => id !== driverId);
  }

  /** Test/introspection helpers */
  degradedCacheSize(): number {
    return this.degradedCache.size;
  }

  singleflightSize(): number {
    return this.singleflight.size;
  }

  async getCityOpenOffersRevision(cityId: string): Promise<number> {
    try {
      const raw = await this.client.get(
        cityOpenOffersRevisionKey(this.environment, cityId),
      );
      if (!raw) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
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

  async publishOpenOfferWithCas(
    summary: OpenOfferSummary,
    revision: number,
  ): Promise<RuntimeCasResult> {
    const score = new Date(summary.openedAt).getTime();
    try {
      await this.client.send("SET", [
        offerSummaryKey(this.environment, summary.offerId),
        JSON.stringify(summary),
        "EX",
        String(OFFER_SUMMARY_TTL_SECONDS),
      ]);
      const result = await this.client.send("EVAL", [
        publishCityOpenOfferCasScript,
        "2",
        cityOpenOffersKey(this.environment, summary.cityId),
        cityOpenOffersRevisionKey(this.environment, summary.cityId),
        String(revision),
        String(score),
        summary.offerId,
      ]);
      if (
        result === "APPLIED" ||
        result === "ALREADY_CURRENT" ||
        result === "STALE_REJECTED"
      ) {
        return result;
      }
      return "APPLIED";
    } catch (error) {
      this.logger.error({
        event: "open_offer_index_write_failed",
        offer_id: summary.offerId,
        city_id: summary.cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
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

  async removeOpenOfferWithCas(
    cityId: string,
    offerId: string,
    revision: number,
  ): Promise<RuntimeCasResult> {
    try {
      const result = await this.client.send("EVAL", [
        removeCityOpenOfferCasScript,
        "2",
        cityOpenOffersKey(this.environment, cityId),
        cityOpenOffersRevisionKey(this.environment, cityId),
        String(revision),
        offerId,
      ]);
      if (result !== "STALE_REJECTED") {
        await this.client.del(offerSummaryKey(this.environment, offerId));
      }
      if (
        result === "APPLIED" ||
        result === "ALREADY_CURRENT" ||
        result === "STALE_REJECTED"
      ) {
        return result;
      }
      return "APPLIED";
    } catch (error) {
      this.logger.warn({
        event: "open_offer_index_remove_failed",
        offer_id: offerId,
        city_id: cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
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
    revision = 0,
  ): Promise<void> {
    await this.rebuildCityOpenOffersWithCas(cityId, revision, offers);
  }

  async rebuildCityOpenOffersWithCas(
    cityId: string,
    revision: number,
    offers: OpenOfferSummary[],
  ): Promise<RuntimeCasResult> {
    const zkey = cityOpenOffersKey(this.environment, cityId);
    const rkey = cityOpenOffersRevisionKey(this.environment, cityId);
    try {
      for (const offer of offers) {
        await this.client.send("SET", [
          offerSummaryKey(this.environment, offer.offerId),
          JSON.stringify(offer),
          "EX",
          String(OFFER_SUMMARY_TTL_SECONDS),
        ]);
      }
      const args: string[] = [
        rebuildCityOpenOffersCasScript,
        "2",
        zkey,
        rkey,
        String(revision),
        String(offers.length),
      ];
      for (const offer of offers) {
        args.push(String(new Date(offer.openedAt).getTime()), offer.offerId);
      }
      const result = await this.client.send("EVAL", args);
      if (
        result === "APPLIED" ||
        result === "ALREADY_CURRENT" ||
        result === "STALE_REJECTED"
      ) {
        return result;
      }
      return "APPLIED";
    } catch (error) {
      this.logger.error({
        event: "open_offer_index_rebuild_failed",
        city_id: cityId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
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
  private cityRevisions = new Map<string, number>();
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

  async setRuntimeWithCas(state: DriverRuntimeState): Promise<RuntimeCasResult> {
    const existing = this.runtimes.get(state.driverId) ?? null;
    const result = evaluateRuntimeCasInMemory(existing, state);
    if (result === "APPLIED" || result === "ALREADY_CURRENT") {
      this.runtimes.set(state.driverId, { ...state });
    }
    return result;
  }

  async setRuntime(state: DriverRuntimeState): Promise<void> {
    await this.setRuntimeWithCas(state);
  }

  /** No-op for type compatibility with DriverRuntimeStore.clearDegraded. */
  clearDegraded(_driverId: string): void {}

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

  async publishOpenOfferWithCas(
    summary: OpenOfferSummary,
    revision: number,
  ): Promise<RuntimeCasResult> {
    const current = this.cityRevisions.get(summary.cityId) ?? 0;
    const result = evaluateCityRevisionCas(current, revision);
    if (result === "STALE_REJECTED") return result;
    await this.publishOpenOffer(summary);
    this.cityRevisions.set(summary.cityId, revision);
    return result;
  }

  async removeOpenOffer(cityId: string, offerId: string): Promise<void> {
    this.cityOffers.get(cityId)?.delete(offerId);
    this.summaries.delete(offerId);
  }

  async removeOpenOfferWithCas(
    cityId: string,
    offerId: string,
    revision: number,
  ): Promise<RuntimeCasResult> {
    const current = this.cityRevisions.get(cityId) ?? 0;
    const result = evaluateCityRevisionCas(current, revision);
    if (result === "STALE_REJECTED") return result;
    await this.removeOpenOffer(cityId, offerId);
    this.cityRevisions.set(cityId, revision);
    return result;
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

  async getCityOpenOffersRevision(cityId: string): Promise<number> {
    return this.cityRevisions.get(cityId) ?? 0;
  }

  async rebuildCityOpenOffers(
    cityId: string,
    offers: OpenOfferSummary[],
    revision = 0,
  ): Promise<void> {
    await this.rebuildCityOpenOffersWithCas(cityId, revision, offers);
  }

  async rebuildCityOpenOffersWithCas(
    cityId: string,
    revision: number,
    offers: OpenOfferSummary[],
  ): Promise<RuntimeCasResult> {
    const current = this.cityRevisions.get(cityId) ?? 0;
    const result = evaluateCityRevisionCas(current, revision);
    if (result === "STALE_REJECTED") return result;
    this.cityOffers.set(cityId, new Map());
    for (const offer of offers) await this.publishOpenOffer(offer);
    this.cityRevisions.set(cityId, revision);
    return result;
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
    this.cityRevisions.clear();
    this.locations.clear();
  }
}

export type DriverRuntimeStoreLike =
  | DriverRuntimeStore
  | FakeDriverRuntimeStore;
