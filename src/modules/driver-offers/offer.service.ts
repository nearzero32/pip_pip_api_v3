import type { SQL } from "bun";
import { createHash } from "crypto";
import type { NodeEnvironment } from "../../config/env";
import type { DriverPricingStage } from "../../db/schema/driver-offers";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import type { RateLimiter } from "../auth/rate-limit/rate-limiter";
import { requireTrustedDriverCity } from "../auth/mobile/driver/driver-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireCityPermission } from "../auth/staff/authorization";
import { dateValue, pageOf } from "../geography/shared";
import type { OrderService } from "../orders/order.service";
import { insertOrderEvent } from "../orders/order-events";
import type { OrderStatus } from "../orders/order-state-machine";
import { computeOfferedDriverFee } from "./driver-fee";
import {
  hydrateDriverRuntimeFromPostgres,
  type DriverRuntimeStoreLike,
  type DriverWorkStatus,
  type LocationFreshness,
  type OpenOfferSummary,
} from "./driver-runtime";
import {
  abortOfferIdempotency,
  beginOfferIdempotency,
  completeOfferIdempotency,
} from "./offer-idempotency";
import type { OfferLimitsConfig } from "./offer-limits";
import { rateLimitNamespacedKey } from "./redis-keys";
import {
  applyRedisAfterCommit,
  bumpDriverRuntimeRevision,
  enqueueCityOpenOffersRecon,
  enqueueDriverRuntimeRecon,
} from "./redis-reconciliation";
import { rankOffersForSpin } from "./spin-rank";

type OfferRoundStatus =
  | "OPEN"
  | "CLAIMED"
  | "MANUALLY_ASSIGNED"
  | "STOPPED"
  | "CANCELLED";

type OfferRoundRow = {
  id: string;
  orderId: string;
  cityId: string;
  status: OfferRoundStatus;
  openedAt: string;
  closedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  pricingBaseSnapshot: number;
  roundingUnitSnapshot: number;
  pricingStagesSnapshot: DriverPricingStage[];
  pricingVersionSnapshot: number;
  finalDriverFee: number | null;
  claimedByDriverId: string | null;
  createdByAccountId: string;
  createdAt: string;
  updatedAt: string;
};

type ClaimPayload = {
  orderId: string;
  orderTotal: number;
  paymentMethod: "CASH" | "ONLINE";
  offeredDriverFee: number;
  store: {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
  } | null;
  customer: { phone: string | null };
  deliveryAddress: {
    label: string;
    addressDetails: string;
    landmark: string | null;
    recipientName: string | null;
    recipientPhone: string | null;
    latitude: number;
    longitude: number;
  } | null;
  items: Array<{
    id: string;
    productName: string;
    quantity: number;
    selectedSizeName: string | null;
    lineTotal: number;
  }>;
};

type ManualAssignResult = {
  assignmentId: string;
  orderId: string;
  driverId: string;
  driverFee: number;
  assignmentSequence: number;
  offerRoundId: string | null;
};

export type DriverOrderSummary = {
  orderId: string;
  orderNumber: string;
  status: string;
  assignmentSequence: number;
};

export type DriverCandidateRow = {
  driverId: string;
  driverName: string;
  cityId: string;
  eligibilityStatus: "ELIGIBLE" | "INELIGIBLE";
  workStatus: DriverWorkStatus;
  activeOrderCount: number;
  lastLocation: {
    latitude: number;
    longitude: number;
  } | null;
  lastLocationAt: string | null;
  locationFreshness: LocationFreshness;
  currentOrderSummary: DriverOrderSummary | null;
  nextOrderSummary: DriverOrderSummary | null;
};

const parseStages = (value: unknown): DriverPricingStage[] => {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? (parsed as DriverPricingStage[]) : [];
};

const hashPayload = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const requireIdempotencyKey = (idempotencyKey: string | null | undefined) => {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim())
    throw new AppError(422, "VALIDATION_FAILED", "Idempotency-Key is required");
  return idempotencyKey.trim();
};

const mapRound = (row: Record<string, unknown>): OfferRoundRow => ({
  id: String(row.id),
  orderId: String(row.order_id),
  cityId: String(row.city_id),
  status: String(row.status) as OfferRoundStatus,
  openedAt: dateValue(row.opened_at)!,
  closedAt: dateValue(row.closed_at),
  stoppedAt: dateValue(row.stopped_at),
  stopReason: row.stop_reason == null ? null : String(row.stop_reason),
  pricingBaseSnapshot: Number(row.pricing_base_snapshot),
  roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
  pricingStagesSnapshot: parseStages(row.pricing_stages_snapshot),
  pricingVersionSnapshot: Number(row.pricing_version_snapshot),
  finalDriverFee:
    row.final_driver_fee == null ? null : Number(row.final_driver_fee),
  claimedByDriverId:
    row.claimed_by_driver_id == null ? null : String(row.claimed_by_driver_id),
  createdByAccountId: String(row.created_by_account_id),
  createdAt: dateValue(row.created_at)!,
  updatedAt: dateValue(row.updated_at)!,
});

const ROUND_SELECT = `id::text, order_id::text, city_id::text, status::text, opened_at, closed_at,
  stopped_at, stop_reason, pricing_base_snapshot, rounding_unit_snapshot,
  pricing_stages_snapshot, pricing_version_snapshot, final_driver_fee,
  claimed_by_driver_id::text, created_by_account_id::text, created_at, updated_at`;

export class OfferService {
  constructor(
    private client: SQL,
    private limiter: RateLimiter,
    private runtime: DriverRuntimeStoreLike,
    private orders: OrderService,
    private logger: Logger,
    private environment: NodeEnvironment,
    private limits: OfferLimitsConfig,
  ) {}

  private async consumeLimit(
    scope: string,
    identityKey: string,
    limit: number,
    windowSeconds: number,
  ) {
    const key = rateLimitNamespacedKey(this.environment, scope, identityKey);
    const result = await this.limiter.consume(key, { limit, windowSeconds });
    if (!result.allowed)
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests",
        result.retryAfterSeconds,
      );
  }

  private async audit(
    tx: SQL,
    event: string,
    identity: AuthIdentity,
    targetType: string,
    targetId: string,
    requestId: string | null,
    metadata: Record<string, unknown>,
  ) {
    await tx`
      insert into audit_logs (
        event_type, actor_account_id, actor_session_id, target_type, target_id,
        outcome, request_correlation_id, redacted_metadata
      ) values (
        ${event}, ${identity.accountId}, ${identity.sessionId || null}, ${targetType},
        ${targetId}, 'SUCCESS', ${requestId}, ${JSON.stringify(metadata)}::jsonb
      )`;
  }

  private toSummary(round: OfferRoundRow): OpenOfferSummary {
    return {
      offerId: round.id,
      orderId: round.orderId,
      cityId: round.cityId,
      openedAt: round.openedAt,
      pricingBaseSnapshot: round.pricingBaseSnapshot,
      roundingUnitSnapshot: round.roundingUnitSnapshot,
      pricingStagesSnapshot: round.pricingStagesSnapshot,
      pricingVersionSnapshot: round.pricingVersionSnapshot,
    };
  }

  private async loadCityPricing(tx: SQL, cityId: string) {
    const [pricing] = await tx<
      {
        version: number;
        pricing_base: number;
        rounding_unit: number;
        pricing_stages: DriverPricingStage[];
      }[]
    >`select version, pricing_base, rounding_unit, pricing_stages
      from city_driver_pricing where city_id = ${cityId}`;
    if (!pricing)
      throw new AppError(
        404,
        "CITY_DRIVER_PRICING_NOT_FOUND",
        "City driver pricing not found",
      );
    return {
      ...pricing,
      pricing_stages: parseStages(pricing.pricing_stages),
    };
  }

  async openRound(
    identity: AuthIdentity,
    orderId: string,
    requestId: string | null = null,
    idempotencyKey?: string | null,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "order_offers.manage",
    );
    const key = requireIdempotencyKey(idempotencyKey);
    const scope = "v1:offer_rounds.open";
    const requestHash = hashPayload({ orderId, action: "open" });

    const committed = await this.client.begin(async (tx) => {
      const gate = await beginOfferIdempotency(tx, {
        scope,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey: key,
        requestHash,
      });
      if (gate.kind === "replay")
        return {
          round: gate.payload as unknown as OfferRoundRow,
          published: false,
          jobIds: [] as string[],
          cityRevision: 0,
        };

      try {
        const [order] = await tx<
          {
            id: string;
            status: OrderStatus;
            version: number;
            city_id: string;
          }[]
        >`select id::text, status::text, version, city_id::text
          from orders where id = ${orderId} and city_id = ${cityId} for update`;
        if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

        if (order.status === "APPROVED_BY_STORE") {
          await this.orders.applyStatusTransition(
            tx,
            order,
            "SEARCHING_DRIVER",
            {
              accountId: identity.accountId,
              actorType: "STAFF",
              source: "DASHBOARD",
              reason: "Offer round opened",
            },
            new Date(),
          );
          order.status = "SEARCHING_DRIVER";
          order.version += 1;
        } else if (order.status !== "SEARCHING_DRIVER") {
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not eligible for an offer round",
          );
        }

        const [open] = await tx<{ id: string }[]>`
          select id::text from order_offer_rounds
          where order_id = ${orderId} and status = 'OPEN' for update`;
        if (open)
          throw new AppError(
            409,
            "OFFER_ROUND_ALREADY_OPEN",
            "An open offer round already exists",
          );

        const [activeAssignment] = await tx<{ id: string }[]>`
          select id::text from order_driver_assignments
          where order_id = ${orderId}
            and completed_at is null and cancelled_at is null
          for update`;
        if (activeAssignment)
          throw new AppError(
            409,
            "ORDER_ALREADY_ASSIGNED",
            "Order already has an active driver assignment",
          );

        const pricing = await this.loadCityPricing(tx, cityId);
        const [inserted] = await tx<Record<string, unknown>[]>`
          insert into order_offer_rounds (
            order_id, city_id, status, pricing_base_snapshot, rounding_unit_snapshot,
            pricing_stages_snapshot, pricing_version_snapshot, created_by_account_id
          ) values (
            ${orderId}, ${cityId}, 'OPEN', ${pricing.pricing_base},
            ${pricing.rounding_unit}, ${pricing.pricing_stages},
            ${pricing.version}, ${identity.accountId}
          )
          returning id::text, order_id::text, city_id::text, status::text, opened_at, closed_at,
            stopped_at, stop_reason, pricing_base_snapshot, rounding_unit_snapshot,
            pricing_stages_snapshot, pricing_version_snapshot, final_driver_fee,
            claimed_by_driver_id::text, created_by_account_id::text, created_at, updated_at`;
        const round = mapRound(inserted!);

        await this.audit(
          tx,
          "OFFER_ROUND_OPENED",
          identity,
          "ORDER_OFFER_ROUND",
          round.id,
          requestId,
          { orderId, cityId },
        );

        const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);

        await completeOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
          httpStatus: 200,
          payload: round as unknown as Record<string, unknown>,
        });

        return {
          round,
          published: true,
          jobIds: [cityRecon.jobId] as string[],
          cityRevision: cityRecon.revision,
        };
      } catch (error) {
        await abortOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
        });
        throw error;
      }
    });

    if (committed.published) {
      await applyRedisAfterCommit({
        client: this.client,
        jobIds: committed.jobIds,
        logger: this.logger,
        event: "offer_open_redis_apply_failed",
        apply: async () => {
          await this.runtime.publishOpenOfferWithCas(
            this.toSummary(committed.round),
            committed.cityRevision,
          );
        },
      });
    }
    return committed.round;
  }

  async stopRound(
    identity: AuthIdentity,
    orderId: string,
    reason: string,
    requestId: string | null = null,
    idempotencyKey?: string | null,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "order_offers.manage",
    );
    const cleaned = typeof reason === "string" ? reason.trim() : "";
    if (!cleaned || cleaned.length > 1000)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid reason");
    const key = requireIdempotencyKey(idempotencyKey);
    const scope = "v1:offer_rounds.stop";
    const requestHash = hashPayload({
      orderId,
      reason: cleaned,
      action: "stop",
    });

    const committed = await this.client.begin(async (tx) => {
      const gate = await beginOfferIdempotency(tx, {
        scope,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey: key,
        requestHash,
      });
      if (gate.kind === "replay")
        return {
          round: gate.payload as unknown as OfferRoundRow,
          offerId: null as string | null,
          jobIds: [] as string[],
          cityRevision: 0,
        };

      try {
        const [order] = await tx<{ id: string }[]>`
          select id::text from orders where id = ${orderId} and city_id = ${cityId} for update`;
        if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

        const openRows = (await tx.unsafe(
          `select ${ROUND_SELECT} from order_offer_rounds
           where order_id = $1 and city_id = $2 and status = 'OPEN' for update`,
          [orderId, cityId],
        )) as Record<string, unknown>[];
        const open = openRows[0];
        if (!open)
          throw new AppError(404, "OFFER_NOT_OPEN", "No open offer round found");

        const now = new Date();
        const updated = (await tx.unsafe(
          `update order_offer_rounds
           set status = 'STOPPED', closed_at = $1, stopped_at = $1, stop_reason = $2,
               updated_at = $1
           where id = $3
           returning ${ROUND_SELECT}`,
          [now, cleaned, open.id],
        )) as Record<string, unknown>[];
        const round = mapRound(updated[0]!);

        await this.audit(
          tx,
          "OFFER_ROUND_STOPPED",
          identity,
          "ORDER_OFFER_ROUND",
          round.id,
          requestId,
          { orderId, cityId, reason: cleaned },
        );

        const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);

        await completeOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
          httpStatus: 200,
          payload: round as unknown as Record<string, unknown>,
        });

        return {
          round,
          offerId: round.id,
          jobIds: [cityRecon.jobId] as string[],
          cityRevision: cityRecon.revision,
        };
      } catch (error) {
        await abortOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
        });
        throw error;
      }
    });

    if (committed.offerId) {
      await applyRedisAfterCommit({
        client: this.client,
        jobIds: committed.jobIds,
        logger: this.logger,
        event: "offer_stop_redis_apply_failed",
        apply: async () => {
          await this.runtime.removeOpenOfferWithCas(
            cityId,
            committed.offerId!,
            committed.cityRevision,
          );
        },
      });
    }
    return committed.round;
  }

  async reopenRound(
    identity: AuthIdentity,
    orderId: string,
    reason: string,
    requestId: string | null = null,
    idempotencyKey?: string | null,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "order_offers.manage",
    );
    const key = requireIdempotencyKey(idempotencyKey);
    const [open] = await this.client<{ id: string }[]>`
      select id::text from order_offer_rounds
      where order_id = ${orderId} and city_id = ${cityId} and status = 'OPEN'`;
    if (open) {
      await this.stopRound(
        identity,
        orderId,
        reason || "Reopened",
        requestId,
        `${key}:stop`,
      );
    }
    return this.openRound(identity, orderId, requestId, `${key}:open`);
  }

  async listRounds(identity: AuthIdentity, orderId: string) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "order_offers.read",
    );
    const [order] = await this.client<{ id: string }[]>`
      select id::text from orders where id = ${orderId} and city_id = ${cityId}`;
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const rows = (await this.client.unsafe(
      `select ${ROUND_SELECT} from order_offer_rounds
       where order_id = $1 and city_id = $2
       order by opened_at desc, id desc`,
      [orderId, cityId],
    )) as Record<string, unknown>[];
    return rows.map(mapRound);
  }

  private async loadOpenSummariesForCity(
    cityId: string,
  ): Promise<OpenOfferSummary[]> {
    const ids = await this.runtime.listOpenOfferIds(cityId, 500);
    if (ids.length > 0) {
      const openRows = await this.client<
        {
          id: string;
          order_id: string;
          city_id: string;
          opened_at: Date;
          pricing_base_snapshot: number;
          rounding_unit_snapshot: number;
          pricing_stages_snapshot: DriverPricingStage[];
          pricing_version_snapshot: number;
        }[]
      >`select id::text, order_id::text, city_id::text, opened_at,
               pricing_base_snapshot, rounding_unit_snapshot,
               pricing_stages_snapshot, pricing_version_snapshot
        from order_offer_rounds
        where city_id = ${cityId}
          and status = 'OPEN'
          and id in ${this.client(ids)}
        order by opened_at asc, id asc`;
      const openIds = new Set(openRows.map((row) => row.id));
      for (const id of ids) {
        if (!openIds.has(id)) await this.runtime.removeOpenOffer(cityId, id);
      }
      if (openRows.length > 0) {
        return openRows.map((row) => ({
          offerId: row.id,
          orderId: row.order_id,
          cityId: row.city_id,
          openedAt: dateValue(row.opened_at)!,
          pricingBaseSnapshot: Number(row.pricing_base_snapshot),
          roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
          pricingStagesSnapshot: parseStages(row.pricing_stages_snapshot),
          pricingVersionSnapshot: Number(row.pricing_version_snapshot),
        }));
      }
    }

    const rows = await this.client<
      {
        id: string;
        order_id: string;
        city_id: string;
        opened_at: Date;
        pricing_base_snapshot: number;
        rounding_unit_snapshot: number;
        pricing_stages_snapshot: DriverPricingStage[];
        pricing_version_snapshot: number;
      }[]
    >`select id::text, order_id::text, city_id::text, opened_at,
             pricing_base_snapshot, rounding_unit_snapshot,
             pricing_stages_snapshot, pricing_version_snapshot
      from order_offer_rounds
      where city_id = ${cityId} and status = 'OPEN'
      order by opened_at asc, id asc`;
    const summaries = rows.map((row) => ({
      offerId: row.id,
      orderId: row.order_id,
      cityId: row.city_id,
      openedAt: dateValue(row.opened_at)!,
      pricingBaseSnapshot: Number(row.pricing_base_snapshot),
      roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
      pricingStagesSnapshot: parseStages(row.pricing_stages_snapshot),
      pricingVersionSnapshot: Number(row.pricing_version_snapshot),
    }));
    if (summaries.length > 0) {
      const [rev] = await this.client<{ revision: number }[]>`
        select revision from city_open_offer_revisions where city_id = ${cityId}`;
      await this.runtime.rebuildCityOpenOffersWithCas(
        cityId,
        Number(rev?.revision ?? 0),
        summaries,
      );
    }
    return summaries;
  }

  async spin(driverIdentity: AuthIdentity) {
    const { driverId, cityId } = requireTrustedDriverCity(driverIdentity);
    await this.consumeLimit(
      "driver.offer.spin",
      driverId,
      this.limits.spinLimit,
      this.limits.spinWindowSeconds,
    );

    // Eligibility + city from PG (via hydrate when Redis missing/degraded).
    // workStatus AVAILABLE/OFFLINE is NOT a gate for fetching offers in this phase.
    const runtime = await this.runtime.getOrHydrateRuntime(driverId, async () => {
      const hydrated = await hydrateDriverRuntimeFromPostgres(
        this.client,
        driverId,
      );
      if (!hydrated)
        throw new AppError(
          403,
          "DRIVER_NOT_ELIGIBLE",
          "Driver is not eligible",
        );
      return hydrated;
    });

    if (runtime.cityId !== cityId)
      throw new AppError(404, "CITY_MISMATCH", "Driver city mismatch");
    if (runtime.eligibilityStatus !== "ELIGIBLE")
      throw new AppError(403, "DRIVER_NOT_ELIGIBLE", "Driver is not eligible");

    // PostgreSQL is authoritative for active assignments (not Redis BUSY alone).
    const [activeCount] = await this.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId}
        and completed_at is null and cancelled_at is null`;
    if ((activeCount?.count ?? 0) !== 0)
      throw new AppError(
        409,
        "DRIVER_ACTIVE_ORDER_EXISTS",
        "Driver already has an active order",
      );

    const summaries = await this.loadOpenSummariesForCity(cityId);
    const now = new Date();
    const ranked = rankOffersForSpin(summaries, driverId, now, {
      maxOffers: this.limits.maxOffersPerSpin,
      ageBucketMs: this.limits.spinAgeBucketMs,
      rotationWindowMs: this.limits.spinRotationWindowMs,
    });

    return ranked.map((summary) => {
      const { offeredDriverFee } = computeOfferedDriverFee({
        pricingBase: summary.pricingBaseSnapshot,
        roundingUnit: summary.roundingUnitSnapshot,
        pricingStages: summary.pricingStagesSnapshot,
        openedAt: new Date(summary.openedAt),
        now,
      });
      return { offerId: summary.offerId, offeredDriverFee };
    });
  }

  private async loadClaimPayload(
    tx: SQL,
    orderId: string,
    offeredDriverFee: number,
  ): Promise<ClaimPayload> {
    const [order] = await tx<
      {
        id: string;
        products_subtotal: number;
        delivery_fee: number;
        payment_method: string;
        store_id: string;
        customer_account_id: string;
      }[]
    >`select id::text, products_subtotal, delivery_fee, payment_method::text,
             store_id::text, customer_account_id::text
      from orders where id = ${orderId}`;
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

    const [store] = await tx<
      { id: string; name: string; latitude: number; longitude: number }[]
    >`select id::text, name, ST_Y(location)::float8 latitude, ST_X(location)::float8 longitude
      from stores where id = ${order.store_id}`;

    const [customer] = await tx<{ phone: string | null }[]>`
      select phone_e164 as phone from account_phones
      where account_id = ${order.customer_account_id} and is_primary = true
      limit 1`;

    const [address] = await tx<Record<string, unknown>[]>`
      select label, address_details, landmark, recipient_name, recipient_phone,
             latitude, longitude
      from order_address_snapshots where order_id = ${orderId}`;

    const items = await tx<Record<string, unknown>[]>`
      select id::text, product_name_snapshot as product_name, quantity,
             selected_size_name_snapshot as selected_size_name, line_total
      from order_items
      where order_id = ${orderId} and state = 'ACTIVE'
      order by created_at asc, id asc`;

    return {
      orderId: order.id,
      orderTotal: Number(order.products_subtotal) + Number(order.delivery_fee),
      paymentMethod: order.payment_method as "CASH" | "ONLINE",
      offeredDriverFee,
      store: store
        ? {
            id: store.id,
            name: store.name,
            latitude: store.latitude,
            longitude: store.longitude,
          }
        : null,
      customer: { phone: customer?.phone ?? null },
      deliveryAddress: address
        ? {
            label: String(address.label),
            addressDetails: String(address.address_details),
            landmark:
              address.landmark == null ? null : String(address.landmark),
            recipientName:
              address.recipient_name == null
                ? null
                : String(address.recipient_name),
            recipientPhone:
              address.recipient_phone == null
                ? null
                : String(address.recipient_phone),
            latitude: Number(address.latitude),
            longitude: Number(address.longitude),
          }
        : null,
      items: items.map((item) => ({
        id: String(item.id),
        productName: String(item.product_name),
        quantity: Number(item.quantity),
        selectedSizeName:
          item.selected_size_name == null
            ? null
            : String(item.selected_size_name),
        lineTotal: Number(item.line_total),
      })),
    };
  }

  async claim(
    driverIdentity: AuthIdentity,
    offerId: string,
    idempotencyKey: string,
    requestId: string | null = null,
  ) {
    const { driverId, cityId } = requireTrustedDriverCity(driverIdentity);
    const key = requireIdempotencyKey(idempotencyKey);
    await this.consumeLimit(
      "driver.offer.claim",
      driverId,
      this.limits.claimLimit,
      this.limits.claimWindowSeconds,
    );
    const scope = "v1:offer.claim";
    const requestHash = hashPayload({ offerId, action: "claim" });

    const committed = await this.client.begin(async (tx) => {
      const gate = await beginOfferIdempotency(tx, {
        scope,
        actorAccountId: driverId,
        cityId,
        idempotencyKey: key,
        requestHash,
      });
      if (gate.kind === "replay")
        return {
          payload: gate.payload as unknown as ClaimPayload,
          offerCityId: null as string | null,
          offerId: null as string | null,
          revision: null as number | null,
          cityRevision: null as number | null,
          activeOrderCount: 0,
          jobIds: [] as string[],
        };

      try {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`driver-claim:${driverId}`}, 0))`;

        const [driver] = await tx<
          {
            account_status: string;
            approval_status: string;
            operational_status: string;
            city_id: string | null;
          }[]
        >`select a.status::text as account_status,
                 dp.approval_status::text as approval_status,
                 dp.operational_status::text as operational_status,
                 dp.city_id::text as city_id
          from driver_profiles dp
          join accounts a on a.id = dp.account_id
          where dp.account_id = ${driverId}
          for update of dp`;
        if (
          !driver ||
          driver.account_status !== "ACTIVE" ||
          driver.approval_status !== "APPROVED" ||
          driver.operational_status !== "ACTIVE"
        ) {
          throw new AppError(
            403,
            "DRIVER_NOT_ELIGIBLE",
            "Driver is not eligible",
          );
        }
        if (!driver.city_id || driver.city_id !== cityId)
          throw new AppError(404, "CITY_MISMATCH", "Driver city mismatch");

        const [activeCount] = await tx<{ count: number }[]>`
          select count(*)::int as count from order_driver_assignments
          where driver_id = ${driverId}
            and completed_at is null and cancelled_at is null`;
        if ((activeCount?.count ?? 0) !== 0)
          throw new AppError(
            409,
            "DRIVER_ACTIVE_ORDER_EXISTS",
            "Driver already has an active order",
          );

        const offerRows = (await tx.unsafe(
          `select o.id::text as order_id, o.status::text as order_status, o.version as order_version,
                  o.city_id::text as order_city_id, o.driver_account_id::text as driver_account_id,
                  r.id::text as offer_id, r.status::text as offer_status, r.opened_at,
                  r.pricing_base_snapshot, r.rounding_unit_snapshot, r.pricing_stages_snapshot,
                  r.city_id::text as offer_city_id
           from order_offer_rounds r
           join orders o on o.id = r.order_id
           where r.id = $1
           for update of o, r`,
          [offerId],
        )) as Record<string, unknown>[];
        const locked = offerRows[0];
        if (!locked)
          throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
        if (String(locked.offer_city_id) !== cityId)
          throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
        if (String(locked.offer_status) !== "OPEN")
          throw new AppError(409, "OFFER_NOT_OPEN", "Offer is not open");
        if (String(locked.order_status) !== "SEARCHING_DRIVER")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not searching for a driver",
          );

        const [orderAssignment] = await tx<{ id: string }[]>`
          select id::text from order_driver_assignments
          where order_id = ${String(locked.order_id)}
            and completed_at is null and cancelled_at is null
          for update`;
        if (orderAssignment || locked.driver_account_id)
          throw new AppError(
            409,
            "ORDER_ALREADY_ASSIGNED",
            "Order already has an active driver assignment",
          );

        const now = new Date();
        const { offeredDriverFee } = computeOfferedDriverFee({
          pricingBase: Number(locked.pricing_base_snapshot),
          roundingUnit: Number(locked.rounding_unit_snapshot),
          pricingStages: parseStages(locked.pricing_stages_snapshot),
          openedAt: new Date(locked.opened_at as Date | string),
          now,
        });

        const assignmentSequence = 1;
        const [assignment] = await tx<{ id: string }[]>`
          insert into order_driver_assignments (
            order_id, driver_id, city_id, offer_round_id, assignment_source,
            assignment_sequence, assigned_by_account_id, driver_fee, status, assigned_at
          ) values (
            ${String(locked.order_id)}, ${driverId}, ${cityId}, ${offerId},
            'OFFER_CLAIM', ${assignmentSequence}, ${driverId}, ${offeredDriverFee},
            'ASSIGNED', ${now}
          ) returning id::text`;

        await tx`
          update orders set driver_account_id = ${driverId}, updated_at = ${now}
          where id = ${String(locked.order_id)}`;

        await this.orders.applyStatusTransition(
          tx,
          {
            id: String(locked.order_id),
            status: String(locked.order_status) as OrderStatus,
            version: Number(locked.order_version),
          },
          "DRIVER_ASSIGNED",
          {
            accountId: driverId,
            actorType: "DRIVER",
            source: "DRIVER_APP",
            reason: "Driver claimed offer",
          },
          now,
        );
        await insertOrderEvent(tx, {
          orderId: String(locked.order_id),
          assignmentId: assignment!.id,
          eventType: "DRIVER_ASSIGNED",
          fromOrderStatus: "SEARCHING_DRIVER",
          toOrderStatus: "DRIVER_ASSIGNED",
          accountId: driverId,
          actorType: "DRIVER",
          source: "DRIVER_APP",
          createdAt: now,
        });

        await tx`
          update order_offer_rounds
          set status = 'CLAIMED', closed_at = ${now}, final_driver_fee = ${offeredDriverFee},
              claimed_by_driver_id = ${driverId}, updated_at = ${now}
          where id = ${offerId}`;

        const payload = await this.loadClaimPayload(
          tx,
          String(locked.order_id),
          offeredDriverFee,
        );

        await this.audit(
          tx,
          "OFFER_CLAIMED",
          driverIdentity,
          "ORDER_OFFER_ROUND",
          offerId,
          requestId,
          { orderId: payload.orderId, driverId, offeredDriverFee },
        );

        const revision = await bumpDriverRuntimeRevision(tx, driverId);
        const driverJobId = await enqueueDriverRuntimeRecon(tx, {
          driverId,
          expectedRevision: revision,
          cityId,
        });
        const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);

        await completeOfferIdempotency(tx, {
          scope,
          actorAccountId: driverId,
          cityId,
          idempotencyKey: key,
          httpStatus: 200,
          payload: payload as unknown as Record<string, unknown>,
        });

        return {
          payload,
          offerCityId: cityId,
          offerId,
          revision,
          cityRevision: cityRecon.revision,
          activeOrderCount: assignmentSequence,
          jobIds: [driverJobId, cityRecon.jobId] as string[],
        };
      } catch (error) {
        await abortOfferIdempotency(tx, {
          scope,
          actorAccountId: driverId,
          cityId,
          idempotencyKey: key,
        });
        throw error;
      }
    });

    if (
      committed.offerId &&
      committed.offerCityId &&
      committed.revision != null &&
      committed.cityRevision != null
    ) {
      await applyRedisAfterCommit({
        client: this.client,
        jobIds: committed.jobIds,
        logger: this.logger,
        event: "offer_claim_redis_apply_failed",
        apply: async () => {
          await this.runtime.removeOpenOfferWithCas(
            committed.offerCityId!,
            committed.offerId!,
            committed.cityRevision!,
          );
          await this.runtime.setRuntime({
            driverId,
            cityId,
            eligibilityStatus: "ELIGIBLE",
            workStatus: "BUSY",
            activeOrderCount: committed.activeOrderCount,
            eligibilityVersion: 1,
            revision: committed.revision!,
            updatedAt: new Date().toISOString(),
          });
        },
      });
    }

    return committed.payload;
  }

  async assignDriver(
    identity: AuthIdentity,
    orderId: string,
    input: { driverId: string; reason?: string | null },
    idempotencyKey: string | null | undefined,
    requestId: string | null = null,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.assign",
    );
    await this.consumeLimit(
      "dashboard.assign",
      identity.accountId,
      this.limits.dashboardManualAssignLimit,
      this.limits.dashboardManualAssignWindowSeconds,
    );
    if (typeof input.driverId !== "string" || !input.driverId)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid driverId");
    const reason =
      input.reason == null || input.reason === undefined
        ? null
        : String(input.reason).trim() || null;
    if (reason && reason.length > 1000)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid reason");
    const key = requireIdempotencyKey(idempotencyKey);
    const scope = "v1:orders.assign_driver";
    const requestHash = hashPayload({
      orderId,
      driverId: input.driverId,
      reason,
      action: "assign",
    });

    const committed = await this.client.begin(async (tx) => {
      const gate = await beginOfferIdempotency(tx, {
        scope,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey: key,
        requestHash,
      });
      if (gate.kind === "replay")
        return {
          result: gate.payload as unknown as ManualAssignResult,
          removeOfferId: null as string | null,
          driverId: input.driverId,
          activeCount: 0,
          revision: null as number | null,
          cityRevision: null as number | null,
          jobIds: [] as string[],
          applyRuntime: false,
        };

      try {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`driver-assign:${input.driverId}`}, 0))`;

        const [driver] = await tx<
          {
            account_status: string;
            approval_status: string;
            operational_status: string;
            city_id: string | null;
          }[]
        >`select a.status::text as account_status,
                 dp.approval_status::text as approval_status,
                 dp.operational_status::text as operational_status,
                 dp.city_id::text as city_id
          from driver_profiles dp
          join accounts a on a.id = dp.account_id
          where dp.account_id = ${input.driverId}
          for update of dp`;
        if (
          !driver ||
          driver.account_status !== "ACTIVE" ||
          driver.approval_status !== "APPROVED" ||
          driver.operational_status !== "ACTIVE"
        ) {
          throw new AppError(
            403,
            "DRIVER_NOT_ELIGIBLE",
            "Driver is not eligible",
          );
        }
        if (!driver.city_id || driver.city_id !== cityId)
          throw new AppError(404, "CITY_MISMATCH", "Driver city mismatch");

        const [activeCountRow] = await tx<{ count: number }[]>`
          select count(*)::int as count from order_driver_assignments
          where driver_id = ${input.driverId}
            and completed_at is null and cancelled_at is null`;
        const activeCount = activeCountRow?.count ?? 0;
        if (activeCount >= 2)
          throw new AppError(
            409,
            "DRIVER_ASSIGNMENT_CAPACITY_REACHED",
            "Driver assignment capacity reached",
          );

        const [order] = await tx<
          {
            id: string;
            status: OrderStatus;
            version: number;
            driver_account_id: string | null;
          }[]
        >`select id::text, status::text, version, driver_account_id::text
          from orders where id = ${orderId} and city_id = ${cityId} for update`;
        if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

        const [orderAssignment] = await tx<{ id: string }[]>`
          select id::text from order_driver_assignments
          where order_id = ${orderId}
            and completed_at is null and cancelled_at is null
          for update`;
        if (orderAssignment)
          throw new AppError(
            409,
            "ORDER_ALREADY_ASSIGNED",
            "Order already has an active driver assignment",
          );

        const now = new Date();
        let orderStatus = order.status;
        let orderVersion = order.version;
        if (orderStatus === "APPROVED_BY_STORE") {
          await this.orders.applyStatusTransition(
            tx,
            { id: order.id, status: orderStatus, version: orderVersion },
            "SEARCHING_DRIVER",
            {
              accountId: identity.accountId,
              actorType: "STAFF",
              source: "DASHBOARD",
              reason: reason ?? "Manual driver assignment",
            },
            now,
          );
          orderStatus = "SEARCHING_DRIVER";
          orderVersion += 1;
        }
        if (orderStatus !== "SEARCHING_DRIVER")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not eligible for driver assignment",
          );

        const openRows = (await tx.unsafe(
          `select ${ROUND_SELECT} from order_offer_rounds
           where order_id = $1 and status = 'OPEN' for update`,
          [orderId],
        )) as Record<string, unknown>[];
        const openRound = openRows[0] ? mapRound(openRows[0]) : null;

        let driverFee: number;
        let offerRoundId: string | null = null;
        let pricingBaseSnapshot: number | null = null;
        let roundingUnitSnapshot: number | null = null;
        let pricingStagesSnapshot: DriverPricingStage[] | null = null;
        let pricingVersionSnapshot: number | null = null;
        let pricingStageAfterSeconds: number | null = null;
        let pricingStageIncreasePercentage: number | null = null;

        if (openRound) {
          driverFee = computeOfferedDriverFee({
            pricingBase: openRound.pricingBaseSnapshot,
            roundingUnit: openRound.roundingUnitSnapshot,
            pricingStages: openRound.pricingStagesSnapshot,
            openedAt: new Date(openRound.openedAt),
            now,
          }).offeredDriverFee;
          offerRoundId = openRound.id;
          await tx`
            update order_offer_rounds
            set status = 'MANUALLY_ASSIGNED', closed_at = ${now},
                final_driver_fee = ${driverFee}, claimed_by_driver_id = ${input.driverId},
                updated_at = ${now}
            where id = ${openRound.id}`;
        } else {
          const pricing = await this.loadCityPricing(tx, cityId);
          const computed = computeOfferedDriverFee({
            pricingBase: pricing.pricing_base,
            roundingUnit: pricing.rounding_unit,
            pricingStages: pricing.pricing_stages,
            openedAt: now,
            now,
          });
          driverFee = computed.offeredDriverFee;
          pricingBaseSnapshot = pricing.pricing_base;
          roundingUnitSnapshot = pricing.rounding_unit;
          pricingStagesSnapshot = pricing.pricing_stages;
          pricingVersionSnapshot = pricing.version;
          pricingStageAfterSeconds = computed.stage.afterSeconds;
          pricingStageIncreasePercentage = computed.stage.increasePercentage;
        }

        const sequence = activeCount + 1;
        const [assignment] = await tx<{ id: string }[]>`
          insert into order_driver_assignments (
            order_id, driver_id, city_id, offer_round_id, assignment_source,
            assignment_sequence, assigned_by_account_id, assignment_reason,
            driver_fee, assigned_at,
            pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
            pricing_version_snapshot, pricing_stage_after_seconds,
            pricing_stage_increase_percentage
          ) values (
            ${orderId}, ${input.driverId}, ${cityId}, ${offerRoundId},
            'DASHBOARD_MANUAL', ${sequence}, ${identity.accountId}, ${reason},
            ${driverFee}, ${now},
            ${pricingBaseSnapshot}, ${roundingUnitSnapshot},
            ${pricingStagesSnapshot},
            ${pricingVersionSnapshot}, ${pricingStageAfterSeconds},
            ${pricingStageIncreasePercentage}
          )
          returning id::text`;

        await tx`
          update orders set driver_account_id = ${input.driverId}, updated_at = ${now}
          where id = ${orderId}`;

        await this.orders.applyStatusTransition(
          tx,
          { id: order.id, status: orderStatus, version: orderVersion },
          "DRIVER_ASSIGNED",
          {
            accountId: identity.accountId,
            actorType: "STAFF",
            source: "DASHBOARD",
            reason: reason ?? "Manual driver assignment",
          },
          now,
        );
        await insertOrderEvent(tx, {
          orderId,
          assignmentId: assignment!.id,
          eventType: "DRIVER_ASSIGNED",
          fromOrderStatus: orderStatus,
          toOrderStatus: "DRIVER_ASSIGNED",
          accountId: identity.accountId,
          actorType: "STAFF",
          source: "DASHBOARD",
          reason,
          createdAt: now,
        });

        const result: ManualAssignResult = {
          assignmentId: assignment!.id,
          orderId,
          driverId: input.driverId,
          driverFee,
          assignmentSequence: sequence,
          offerRoundId,
        };

        await this.audit(
          tx,
          "DRIVER_MANUALLY_ASSIGNED",
          identity,
          "ORDER",
          orderId,
          requestId,
          result,
        );

        const revision = await bumpDriverRuntimeRevision(tx, input.driverId);
        const driverJobId = await enqueueDriverRuntimeRecon(tx, {
          driverId: input.driverId,
          expectedRevision: revision,
          cityId,
        });
        const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);

        await completeOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
          httpStatus: 200,
          payload: result,
        });

        return {
          result,
          removeOfferId: offerRoundId,
          driverId: input.driverId,
          activeCount: sequence,
          revision,
          cityRevision: cityRecon.revision,
          jobIds: [driverJobId, cityRecon.jobId] as string[],
          applyRuntime: true,
        };
      } catch (error) {
        await abortOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
        });
        throw error;
      }
    });

    if (committed.applyRuntime && committed.revision != null) {
      await applyRedisAfterCommit({
        client: this.client,
        jobIds: committed.jobIds,
        logger: this.logger,
        event: "offer_assign_redis_apply_failed",
        apply: async () => {
          if (committed.removeOfferId)
            await this.runtime.removeOpenOfferWithCas(
              cityId,
              committed.removeOfferId,
              committed.cityRevision!,
            );
          await this.runtime.setRuntime({
            driverId: committed.driverId,
            cityId,
            eligibilityStatus: "ELIGIBLE",
            workStatus: "BUSY",
            activeOrderCount: committed.activeCount,
            eligibilityVersion: 1,
            revision: committed.revision!,
            updatedAt: new Date().toISOString(),
          });
        },
      });
    }

    return committed.result;
  }

  async listDriverCandidates(
    identity: AuthIdentity,
    page?: number,
    limit?: number,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.assign",
    );
    const p = pageOf(page, limit);
    const offset = (p.page - 1) * p.limit;

    const [countRow] = await this.client<{ total: number }[]>`
      select count(*)::int as total
      from driver_profiles dp
      join accounts a on a.id = dp.account_id
      where dp.city_id = ${cityId}
        and dp.approval_status = 'APPROVED'
        and dp.operational_status = 'ACTIVE'
        and a.status = 'ACTIVE'`;
    const total = countRow?.total ?? 0;

    const drivers = await this.client<
      { account_id: string; display_name: string }[]
    >`select dp.account_id::text,
             coalesce(
               (
                 select ap.phone_e164
                 from account_phones ap
                 where ap.account_id = dp.account_id and ap.is_primary = true
                 limit 1
               ),
               'Driver'
             ) as display_name
      from driver_profiles dp
      join accounts a on a.id = dp.account_id
      where dp.city_id = ${cityId}
        and dp.approval_status = 'APPROVED'
        and dp.operational_status = 'ACTIVE'
        and a.status = 'ACTIVE'
      order by dp.account_id asc
      limit ${p.limit} offset ${offset}`;

    const driverIds = drivers.map((d) => d.account_id);
    const assignments =
      driverIds.length === 0
        ? []
        : await this.client<
            {
              driver_id: string;
              order_id: string;
              order_number: string;
              status: string;
              assignment_sequence: number;
              store_name: string | null;
            }[]
          >`select oda.driver_id::text, o.id::text as order_id,
                   o.order_number::text as order_number, o.status::text,
                   oda.assignment_sequence, s.name as store_name
            from order_driver_assignments oda
            join orders o on o.id = oda.order_id
            left join stores s on s.id = o.store_id
            where oda.driver_id in ${this.client(driverIds)}
              and oda.completed_at is null
              and oda.cancelled_at is null
            order by oda.driver_id asc, oda.assignment_sequence asc`;

    const [runtimes, locations] = await Promise.all([
      this.runtime.mgetRuntimes(driverIds),
      this.runtime.mgetLocations(driverIds),
    ]);

    const byDriver = new Map<string, DriverOrderSummary[]>();
    for (const row of assignments) {
      const list = byDriver.get(row.driver_id) ?? [];
      list.push({
        orderId: row.order_id,
        orderNumber: row.order_number,
        status: row.status,
        assignmentSequence: row.assignment_sequence,
      });
      byDriver.set(row.driver_id, list);
    }

    const data: DriverCandidateRow[] = drivers.map((driver) => {
      const runtime = runtimes.get(driver.account_id) ?? null;
      const location = locations.get(driver.account_id) ?? null;
      const ordersForDriver = byDriver.get(driver.account_id) ?? [];
      const current =
        ordersForDriver.find((o) => o.assignmentSequence === 1) ?? null;
      const next =
        ordersForDriver.find((o) => o.assignmentSequence === 2) ?? null;
      return {
        driverId: driver.account_id,
        driverName: driver.display_name,
        cityId,
        eligibilityStatus: runtime?.eligibilityStatus ?? "INELIGIBLE",
        workStatus: runtime?.workStatus ?? "OFFLINE",
        activeOrderCount: runtime?.activeOrderCount ?? 0,
        lastLocation: location
          ? {
              latitude: location.latitude,
              longitude: location.longitude,
            }
          : null,
        lastLocationAt: location?.recordedAt ?? null,
        locationFreshness: this.runtime.locationFreshness(
          location?.recordedAt ?? null,
        ),
        currentOrderSummary: current,
        nextOrderSummary: next,
      };
    });

    return { data, page: p.page, limit: p.limit, total };
  }

  async reconcileCityOffers(cityId: string, revision: number) {
    const rows = await this.client<
      {
        id: string;
        order_id: string;
        city_id: string;
        opened_at: Date;
        pricing_base_snapshot: number;
        rounding_unit_snapshot: number;
        pricing_stages_snapshot: DriverPricingStage[];
        pricing_version_snapshot: number;
      }[]
    >`select id::text, order_id::text, city_id::text, opened_at,
             pricing_base_snapshot, rounding_unit_snapshot,
             pricing_stages_snapshot, pricing_version_snapshot
      from order_offer_rounds
      where city_id = ${cityId} and status = 'OPEN'
      order by opened_at asc, id asc`;
    const offers: OpenOfferSummary[] = rows.map((row) => ({
      offerId: row.id,
      orderId: row.order_id,
      cityId: row.city_id,
      openedAt: dateValue(row.opened_at)!,
      pricingBaseSnapshot: Number(row.pricing_base_snapshot),
      roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
      pricingStagesSnapshot: parseStages(row.pricing_stages_snapshot),
      pricingVersionSnapshot: Number(row.pricing_version_snapshot),
    }));
    const cas = await this.runtime.rebuildCityOpenOffersWithCas(
      cityId,
      revision,
      offers,
    );
    this.logger.info({
      event: "city_open_offers_reconciled",
      city_id: cityId,
      offer_count: offers.length,
      revision,
      cas,
    });
    return { cityId, offerCount: offers.length, revision, cas };
  }
}
