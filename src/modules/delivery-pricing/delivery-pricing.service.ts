import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  requireCityAdmin,
  requireSuperAdmin,
} from "../auth/staff/authorization";
import { loadPublicEligibleStore } from "../stores/public-store-eligibility";
import {
  parseActivePricing,
  type ActivePricing,
  type ActivePricingCache,
} from "./active-pricing-cache";
import {
  calculateDeliveryFee,
  fallbackPricingDistance,
  PRICING_INTEGER_MAX,
  type PricingTerms,
} from "./pricing";
import {
  dashboardListResult,
  dashboardPageOf,
} from "../dashboard-lists/query";
import {
  DELIVERY_PRICING_LIST_WHERE_SQL,
  deliveryPricingListParams,
  parseDeliveryPricingListQuery,
} from "../dashboard-lists/product-list-query";
import {
  RoutingError,
  type Coordinates,
  type RoutingContext,
  type RoutingProvider,
} from "./routing-provider";

export type PricingInput = PricingTerms & {
  routingFallbackEnabled: boolean;
  fallbackOnNoRoute: boolean;
  fallbackOnProviderFailure: boolean;
  fallbackExtraDistanceMeters: number;
};
export type PricingRow = PricingInput & {
  id: string;
  cityId: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  createdByAccountId: string;
  createdAt: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  activationRevision: number | null;
};
export type DeliveryPricingOptions = {
  cacheTtlSeconds: number;
  routingTimeoutMs: number;
  routingProvider: "OSRM";
};
export type DeliverySnapshot = {
  pricingVersionId: string;
  pricingVersionNumber: number;
  routingProvider: string;
  distanceSource: "ROUTE" | "STRAIGHT_LINE_FALLBACK";
  fallbackReason: "NO_ROUTE" | "PROVIDER_FAILURE" | null;
  routeDistanceMeters: number | null;
  straightLineDistanceMeters: number;
  fallbackExtraDistanceMeters: number;
  pricingDistanceMeters: number;
  durationSeconds: number | null;
  baseFee: number;
  includedDistanceMeters: number;
  pricePerKm: number;
  roundingStep: number;
  maximumDistanceMeters: number | null;
  rawCalculation: { numerator: string; denominator: string };
  finalDeliveryFee: number;
  currency: "IQD";
  origin: Coordinates;
  destination: Coordinates;
  calculatedAt: string;
};
export type PublicEstimate = {
  deliveryAvailable: boolean;
  reason:
    | "ADDRESS_OUTSIDE_DELIVERY_ZONE"
    | "ROUTE_NOT_FOUND"
    | "MAX_DISTANCE_EXCEEDED"
    | null;
  deliveryFee: number | null;
  currency: "IQD";
  retryable: boolean;
  distanceSource: "ROUTE" | "STRAIGHT_LINE_FALLBACK" | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  routingProvider: string;
  pricingVersionId: string;
  pricingVersionNumber: number;
  fallbackReason: "NO_ROUTE" | "PROVIDER_FAILURE" | null;
  fallbackExtraDistanceMeters: number | null;
  store: {
    id: string;
    name: string;
    orderAcceptanceStatus: "ACCEPTING" | "PAUSED";
  };
};
export type DeliveryQuoteResult = {
  publicEstimate: PublicEstimate;
  snapshot: DeliverySnapshot | null;
};

const iso = (v: Date | string | null) =>
  v == null
    ? null
    : v instanceof Date
      ? v.toISOString()
      : new Date(v).toISOString();
const columns = `id,city_id as "cityId",version,status,base_fee as "baseFee",included_distance_meters as "includedDistanceMeters",price_per_km as "pricePerKm",rounding_step as "roundingStep",maximum_delivery_distance_meters as "maximumDeliveryDistanceMeters",routing_fallback_enabled as "routingFallbackEnabled",fallback_on_no_route as "fallbackOnNoRoute",fallback_on_provider_failure as "fallbackOnProviderFailure",fallback_extra_distance_meters as "fallbackExtraDistanceMeters",created_by_account_id as "createdByAccountId",created_at as "createdAt",activated_at as "activatedAt",deactivated_at as "deactivatedAt",activation_revision::int8 as "activationRevision"`;
const mapRow = (r: any): PricingRow => ({
  ...r,
  version: Number(r.version),
  activationRevision:
    r.activationRevision == null ? null : Number(r.activationRevision),
  createdAt: iso(r.createdAt)!,
  activatedAt: iso(r.activatedAt),
  deactivatedAt: iso(r.deactivatedAt),
});

export class DeliveryPricingService {
  private readonly loads = new Map<string, Promise<ActivePricing>>();
  constructor(
    private readonly client: SQL,
    private readonly routing: RoutingProvider,
    private readonly logger: Logger,
    private readonly cache: ActivePricingCache,
    private readonly options: DeliveryPricingOptions,
  ) {}
  private validate(input: PricingInput) {
    for (const [k, v] of Object.entries(input))
      if (
        typeof v === "number" &&
        (!Number.isSafeInteger(v) || v < 0 || v > PRICING_INTEGER_MAX)
      )
        throw new AppError(422, "VALIDATION_FAILED", `Invalid ${k}`);
    if (input.roundingStep < 1 || input.maximumDeliveryDistanceMeters === 0)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Invalid pricing configuration",
      );
    if (
      !input.routingFallbackEnabled &&
      (input.fallbackOnNoRoute || input.fallbackOnProviderFailure)
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Fallback policies require routingFallbackEnabled",
      );
  }
  async create(
    identity: AuthIdentity,
    cityId: string,
    input: PricingInput,
    requestId: string | null = null,
  ) {
    requireSuperAdmin(identity);
    this.validate(input);
    return this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`delivery-pricing:${cityId}`},0))`;
      const [city] = await tx<
        { status: string }[]
      >`select status from cities where id=${cityId} for update`;
      if (!city || city.status === "ARCHIVED")
        throw new AppError(404, "CITY_NOT_FOUND", "City not found");
      const [seq] = await tx<
        { version: number }[]
      >`select coalesce(max(version),0)::int+1 version from city_delivery_pricing_versions where city_id=${cityId}`;
      const rows = (await tx.unsafe(
        `insert into city_delivery_pricing_versions(city_id,version,base_fee,included_distance_meters,price_per_km,rounding_step,maximum_delivery_distance_meters,routing_fallback_enabled,fallback_on_no_route,fallback_on_provider_failure,fallback_extra_distance_meters,created_by_account_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${columns}`,
        [
          cityId,
          seq!.version,
          input.baseFee,
          input.includedDistanceMeters,
          input.pricePerKm,
          input.roundingStep,
          input.maximumDeliveryDistanceMeters,
          input.routingFallbackEnabled,
          input.fallbackOnNoRoute,
          input.fallbackOnProviderFailure,
          input.fallbackExtraDistanceMeters,
          identity.accountId,
        ],
      )) as PricingRow[];
      const row = mapRow(rows[0]);
      await this.audit(
        tx,
        "DELIVERY_PRICING_VERSION_CREATED",
        identity,
        row.id,
        cityId,
        requestId,
        { version: row.version },
      );
      return row;
    });
  }
  async activate(
    identity: AuthIdentity,
    cityId: string,
    id: string,
    requestId: string | null = null,
  ) {
    requireSuperAdmin(identity);
    const committed = await this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`delivery-pricing:${cityId}`},0))`;
      const [city] = await tx<
        { status: string }[]
      >`select status from cities where id=${cityId} for update`;
      if (!city || city.status !== "ACTIVE")
        throw new AppError(409, "CITY_NOT_ACTIVE", "City must be ACTIVE");
      const targetRows = (await tx.unsafe(
        `select ${columns} from city_delivery_pricing_versions where id=$1 and city_id=$2 for update`,
        [id, cityId],
      )) as PricingRow[];
      const target = targetRows[0];
      if (!target)
        throw new AppError(
          404,
          "DELIVERY_PRICING_NOT_FOUND",
          "Pricing version not found",
        );
      if (target.status === "ACTIVE")
        return { row: mapRow(target), previousId: null, changed: false };
      const [previous] = await tx<
        { id: string }[]
      >`select id from city_delivery_pricing_versions where city_id=${cityId} and status='ACTIVE' for update`;
      await tx`update city_delivery_pricing_versions set status='INACTIVE',deactivated_at=now() where city_id=${cityId} and status='ACTIVE'`;
      const rows = (await tx.unsafe(
        `update city_delivery_pricing_versions set status='ACTIVE',activated_at=now(),deactivated_at=null,activation_revision=nextval('delivery_pricing_activation_revision_seq') where id=$1 and city_id=$2 returning ${columns}`,
        [id, cityId],
      )) as PricingRow[];
      const row = mapRow(rows[0]);
      await this.audit(
        tx,
        "DELIVERY_PRICING_VERSION_ACTIVATED",
        identity,
        row.id,
        cityId,
        requestId,
        {
          previousActiveVersionId: previous?.id ?? null,
          newActiveVersionId: row.id,
          version: row.version,
          activationRevision: row.activationRevision,
        },
      );
      return { row, previousId: previous?.id ?? null, changed: true };
    });
    if (committed.changed)
      await this.publish(this.toActive(committed.row), "activation");
    return committed.row;
  }
  async list(
    identity: AuthIdentity,
    cityId: string,
    input: {
      search?: string;
      status?: string;
      createdByAccountId?: string;
      createdFrom?: string;
      createdTo?: string;
      activatedFrom?: string;
      activatedTo?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    requireSuperAdmin(identity);
    const filters = parseDeliveryPricingListQuery(input);
    const p = dashboardPageOf(input.page, input.limit);
    const offset = (p.page - 1) * p.limit;
    const params = deliveryPricingListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from city_delivery_pricing_versions where ${DELIVERY_PRICING_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select ${columns} from city_delivery_pricing_versions
       where ${DELIVERY_PRICING_LIST_WHERE_SQL}
       order by ${filters.orderSql}
       limit $10::int offset $11::int`,
      [...params, p.limit, offset],
    )) as PricingRow[];
    return dashboardListResult(rows.map(mapRow), p.page, p.limit, count?.total ?? 0);
  }
  async getSuper(identity: AuthIdentity, cityId: string, id: string) {
    requireSuperAdmin(identity);
    const rows = (await this.client.unsafe(
      `select ${columns} from city_delivery_pricing_versions where city_id=$1 and id=$2`,
      [cityId, id],
    )) as PricingRow[];
    if (!rows[0])
      throw new AppError(
        404,
        "DELIVERY_PRICING_NOT_FOUND",
        "Pricing version not found",
      );
    return mapRow(rows[0]);
  }
  async activeForSuper(identity: AuthIdentity, cityId: string) {
    requireSuperAdmin(identity);
    return this.active(cityId);
  }
  async activeForAdmin(identity: AuthIdentity) {
    return this.active(requireCityAdmin(identity));
  }
  private async active(cityId: string) {
    try {
      const raw = await this.cache.get(cityId);
      if (raw) {
        const parsed = parseActivePricing(raw, cityId);
        if (
          parsed &&
          (await this.isCurrentRevision(cityId, parsed.activationRevision))
        )
          return parsed;
      }
    } catch (error) {
      this.cacheFailure("read", cityId, error);
    }
    const existing = this.loads.get(cityId);
    if (existing) return existing;
    const load = this.loadActive(cityId).finally(() =>
      this.loads.delete(cityId),
    );
    this.loads.set(cityId, load);
    return load;
  }
  private async isCurrentRevision(cityId: string, activationRevision: number) {
    const rows = (await this.client.unsafe(
      `select activation_revision::int8 as "activationRevision" from city_delivery_pricing_versions where city_id=$1 and status='ACTIVE'`,
      [cityId],
    )) as { activationRevision: number | string }[];
    const current = rows[0];
    if (!current)
      throw new AppError(
        404,
        "ACTIVE_DELIVERY_PRICING_NOT_FOUND",
        "Active delivery pricing not found",
      );
    return Number(current.activationRevision) === activationRevision;
  }
  private async loadActive(cityId: string) {
    const rows = (await this.client.unsafe(
      `select ${columns} from city_delivery_pricing_versions where city_id=$1 and status='ACTIVE'`,
      [cityId],
    )) as PricingRow[];
    if (!rows[0])
      throw new AppError(
        404,
        "ACTIVE_DELIVERY_PRICING_NOT_FOUND",
        "Active delivery pricing not found",
      );
    const value = this.toActive(mapRow(rows[0]));
    await this.publish(value, "cache_fill");
    return value;
  }
  private toActive(row: PricingRow): ActivePricing {
    if (row.status !== "ACTIVE" || !row.activatedAt || !row.activationRevision)
      throw new AppError(500, "INTERNAL_ERROR", "Invalid active pricing");
    return Object.freeze({
      cityId: row.cityId,
      pricingVersionId: row.id,
      versionNumber: row.version,
      activationRevision: row.activationRevision,
      status: "ACTIVE",
      activatedAt: row.activatedAt,
      routingProvider: this.options.routingProvider,
      routingTimeoutMs: this.options.routingTimeoutMs,
      routingMaxAttempts: 2,
      baseFee: row.baseFee,
      includedDistanceMeters: row.includedDistanceMeters,
      pricePerKm: row.pricePerKm,
      roundingStep: row.roundingStep,
      maximumDeliveryDistanceMeters: row.maximumDeliveryDistanceMeters,
      routingFallbackEnabled: row.routingFallbackEnabled,
      fallbackOnNoRoute: row.fallbackOnNoRoute,
      fallbackOnProviderFailure: row.fallbackOnProviderFailure,
      fallbackExtraDistanceMeters: row.fallbackExtraDistanceMeters,
      currency: "IQD",
    });
  }
  private ttl(cityId: string) {
    let hash = 0;
    for (const c of cityId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const jitter = Math.floor(this.options.cacheTtlSeconds * 0.1);
    return this.options.cacheTtlSeconds - jitter + (hash % (jitter * 2 + 1));
  }
  private async publish(value: ActivePricing, reason: string) {
    for (let attempt = 1; attempt <= 2; attempt++)
      try {
        await this.cache.writeIfNewer(
          value.cityId,
          value,
          this.ttl(value.cityId),
        );
        return;
      } catch (error) {
        this.cacheFailure(reason, value.cityId, error, attempt);
        if (attempt === 1)
          await new Promise((resolve) => setTimeout(resolve, 20));
      }
  }
  private cacheFailure(
    operation: string,
    cityId: string,
    error: unknown,
    attempt?: number,
  ) {
    this.logger.warn({
      event: "delivery_pricing_cache_failure",
      operation,
      city_id: cityId,
      attempt,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
  private audit(
    tx: SQL,
    event: string,
    identity: AuthIdentity,
    targetId: string,
    cityId: string,
    requestId: string | null,
    metadata: Record<string, unknown>,
  ) {
    return tx`insert into audit_logs(event_type,actor_account_id,actor_session_id,target_type,target_id,outcome,request_correlation_id,redacted_metadata) values(${event},${identity.accountId},${identity.sessionId},'DELIVERY_PRICING_VERSION',${targetId},'SUCCESS',${requestId},${JSON.stringify({ cityId, ...metadata })}::jsonb)`;
  }

  async estimatePublic(
    customerAccountId: string,
    cityId: string,
    input: {
      storeId: string;
      addressId?: string;
      destination?: Coordinates;
      requestId?: string;
      signal?: AbortSignal;
    },
  ) {
    return (await this.estimate(customerAccountId, cityId, input))
      .publicEstimate;
  }
  async estimate(
    customerAccountId: string,
    cityId: string,
    input: {
      storeId: string;
      addressId?: string;
      destination?: Coordinates;
      requestId?: string;
      signal?: AbortSignal;
    },
  ): Promise<DeliveryQuoteResult> {
    if (Boolean(input.addressId) === Boolean(input.destination))
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Provide exactly one of addressId or destination",
      );
    let destination = input.destination;
    if (
      destination &&
      (!Number.isFinite(destination.latitude) ||
        destination.latitude < -90 ||
        destination.latitude > 90 ||
        !Number.isFinite(destination.longitude) ||
        destination.longitude < -180 ||
        destination.longitude > 180)
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Invalid destination coordinates",
      );
    if (input.addressId) {
      const [a] = await this.client<
        { latitude: number; longitude: number }[]
      >`select ST_Y(location)::float8 latitude,ST_X(location)::float8 longitude from customer_addresses where id=${input.addressId} and customer_account_id=${customerAccountId} and city_id=${cityId}`;
      if (!a) throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");
      destination = a;
    }
    const store = await loadPublicEligibleStore(
      this.client,
      cityId,
      input.storeId,
    );
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const pricing = await this.active(cityId);
    const [geo] = await this.client<
      { inside: boolean; straight: number }[]
    >`select exists(select 1 from zones z join store_zones sz on sz.zone_id=z.id and sz.city_id=z.city_id where z.city_id=${cityId} and z.status='ACTIVE' and z.archived_at is null and sz.store_id=${store.id} and ST_Covers(z.boundary,ST_SetSRID(ST_MakePoint(${destination!.longitude},${destination!.latitude}),4326))) inside,ST_DistanceSphere(ST_SetSRID(ST_MakePoint(${store.longitude},${store.latitude}),4326),ST_SetSRID(ST_MakePoint(${destination!.longitude},${destination!.latitude}),4326))::float8 straight`;
    const unavailable = (
      reason: PublicEstimate["reason"],
    ): DeliveryQuoteResult => ({
      publicEstimate: {
        deliveryAvailable: false,
        reason,
        deliveryFee: null,
        currency: "IQD",
        retryable: false,
        distanceSource: null,
        distanceMeters: null,
        durationSeconds: null,
        routingProvider: pricing.routingProvider,
        pricingVersionId: pricing.pricingVersionId,
        pricingVersionNumber: pricing.versionNumber,
        fallbackReason: null,
        fallbackExtraDistanceMeters: null,
        store: {
          id: store.id,
          name: store.name,
          orderAcceptanceStatus: store.orderAcceptanceStatus,
        },
      },
      snapshot: null,
    });
    if (!geo!.inside) return unavailable("ADDRESS_OUTSIDE_DELIVERY_ZONE");
    let distance: number,
      source: "ROUTE" | "STRAIGHT_LINE_FALLBACK",
      duration: number | null = null,
      routeDistance: number | null = null,
      fallbackReason: "NO_ROUTE" | "PROVIDER_FAILURE" | null = null;
    const context: RoutingContext = {
      requestId: input.requestId ?? "delivery-estimate",
      cityId,
      storeId: store.id,
      pricingVersionId: pricing.pricingVersionId,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    try {
      const route = await this.routing.route(
        { latitude: store.latitude, longitude: store.longitude },
        destination!,
        context,
      );
      distance = route.distanceMeters;
      duration = route.durationSeconds;
      routeDistance = route.distanceMeters;
      source = "ROUTE";
    } catch (error) {
      if (!(error instanceof RoutingError))
        throw new AppError(
          502,
          "ROUTING_PROVIDER_ERROR",
          "Routing provider error",
        );
      const classification = error.details.classification;
      if (classification === "NO_ROUTE") {
        if (!pricing.routingFallbackEnabled || !pricing.fallbackOnNoRoute)
          return unavailable("ROUTE_NOT_FOUND");
        fallbackReason = "NO_ROUTE";
      } else if (
        error.details.retryable &&
        (classification === "TIMEOUT" ||
          classification === "NETWORK_ERROR" ||
          classification === "TEMPORARY_HTTP_ERROR")
      ) {
        if (
          !pricing.routingFallbackEnabled ||
          !pricing.fallbackOnProviderFailure
        )
          throw new AppError(
            503,
            "ROUTING_UNAVAILABLE",
            "Routing temporarily unavailable",
            undefined,
            true,
          );
        fallbackReason = "PROVIDER_FAILURE";
      } else
        throw new AppError(
          classification === "REQUEST_CANCELLED" ? 499 : 502,
          "ROUTING_PROVIDER_ERROR",
          "Routing provider error",
        );
      distance = fallbackPricingDistance(
        geo!.straight,
        pricing.fallbackExtraDistanceMeters,
      );
      source = "STRAIGHT_LINE_FALLBACK";
    }
    let calculated;
    try {
      calculated = calculateDeliveryFee(distance, pricing);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.publicCode === "MAX_DISTANCE_EXCEEDED"
      )
        return unavailable("MAX_DISTANCE_EXCEEDED");
      throw error;
    }
    const straight = Math.ceil(geo!.straight),
      calculatedAt = new Date().toISOString();
    const snapshot: DeliverySnapshot = {
      pricingVersionId: pricing.pricingVersionId,
      pricingVersionNumber: pricing.versionNumber,
      routingProvider: pricing.routingProvider,
      distanceSource: source,
      fallbackReason,
      routeDistanceMeters: routeDistance,
      straightLineDistanceMeters: straight,
      fallbackExtraDistanceMeters: pricing.fallbackExtraDistanceMeters,
      pricingDistanceMeters: distance,
      durationSeconds: duration,
      baseFee: pricing.baseFee,
      includedDistanceMeters: pricing.includedDistanceMeters,
      pricePerKm: pricing.pricePerKm,
      roundingStep: pricing.roundingStep,
      maximumDistanceMeters: pricing.maximumDeliveryDistanceMeters,
      rawCalculation: calculated.rawCalculation,
      finalDeliveryFee: calculated.deliveryFee,
      currency: "IQD",
      origin: { latitude: store.latitude, longitude: store.longitude },
      destination: destination!,
      calculatedAt,
    };
    this.logger.info({
      event: "delivery_quote_completed",
      request_id: context.requestId,
      city_id: cityId,
      store_id: store.id,
      pricing_version_id: pricing.pricingVersionId,
      provider: pricing.routingProvider,
      fallback_applied: source === "STRAIGHT_LINE_FALLBACK",
      fallback_reason: fallbackReason,
      straight_line_distance_meters:
        source === "STRAIGHT_LINE_FALLBACK" ? straight : null,
      fallback_extra_distance_meters:
        source === "STRAIGHT_LINE_FALLBACK"
          ? pricing.fallbackExtraDistanceMeters
          : null,
      pricing_distance_meters: distance,
      final_outcome: "AVAILABLE",
    });
    return {
      publicEstimate: {
        deliveryAvailable: true,
        reason: null,
        deliveryFee: calculated.deliveryFee,
        currency: "IQD",
        retryable: false,
        distanceSource: source,
        distanceMeters: distance,
        durationSeconds: duration,
        routingProvider: pricing.routingProvider,
        pricingVersionId: pricing.pricingVersionId,
        pricingVersionNumber: pricing.versionNumber,
        fallbackReason,
        fallbackExtraDistanceMeters:
          source === "STRAIGHT_LINE_FALLBACK"
            ? pricing.fallbackExtraDistanceMeters
            : null,
        store: {
          id: store.id,
          name: store.name,
          orderAcceptanceStatus: store.orderAcceptanceStatus,
        },
      },
      snapshot,
    };
  }
}
