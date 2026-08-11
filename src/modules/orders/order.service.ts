import type { SQL } from "bun";
import { createHash } from "crypto";
import { AppError } from "../../errors/app-error";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireCityPermission } from "../auth/staff/authorization";
import type { DeliveryPricingService } from "../delivery-pricing/delivery-pricing.service";
import type {
  DriverRuntimeStoreLike,
  DriverWorkStatus,
} from "../driver-offers/driver-runtime";
import {
  applyRedisAfterCommit,
  bumpDriverRuntimeRevision,
  enqueueCityOpenOffersRecon,
  enqueueDriverRuntimeRecon,
} from "../driver-offers/redis-reconciliation";
import { dateValue, pageOf } from "../geography/shared";
import type { Logger } from "../../observability/logger";
import {
  assertTransition,
  customerMayCancel,
  dashboardMayCancel,
  mayApprove,
  mayReplaceItems,
  type OrderStatus,
} from "./order-state-machine";

export type OrderCancelSideEffect = {
  cityId: string;
  orderId: string;
  closedOfferIds: string[];
  driverId: string | null;
  remainingActiveOrders: number;
  expectedRevision: number | null;
  cityRevision: number | null;
  jobIds: string[];
};

type ActorType = "CUSTOMER" | "MERCHANT" | "STAFF" | "SYSTEM" | "DRIVER";
type ActionSource =
  | "CUSTOMER_APP"
  | "MERCHANT_APP"
  | "DASHBOARD"
  | "SYSTEM"
  | "DRIVER_APP";
type PaymentMethod = "CASH" | "ONLINE";
type PaymentStatus = "UNPAID" | "AWAITING_PAYMENT" | "PAID" | "FAILED";
type OrderItemState = "ACTIVE" | "REPLACED";
type SelectionInput = { modifierOptionId: string; quantity?: number };
type CreateItemInput = {
  productId: string;
  sizeId?: string | null;
  quantity: number;
  modifierSelections?: SelectionInput[];
};
type ValidatedLine = {
  productId: string;
  productName: string;
  selectedSizeId: string | null;
  selectedSizeName: string | null;
  unitPrice: number;
  modifiersPrice: number;
  quantity: number;
  lineTotal: number;
  selections: Array<{
    modifierOptionId: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
};

const quantityOf = (raw: unknown, field = "quantity") => {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > 99
  )
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return raw;
};

const cleanReason = (value: unknown, field = "reason") => {
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return trimmed;
};

/** Non-CASH orders require verified PAID status before operational mutations. */
const assertPaymentAllowsMutation = (order: {
  payment_method: string;
  payment_status: string;
}) => {
  if (order.payment_method === "CASH") return;
  if (order.payment_status === "PAID") return;
  throw new AppError(
    409,
    "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED",
    "Online payment is not confirmed",
  );
};

const hashPayload = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const parseSelections = (raw: unknown): SelectionInput[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new AppError(422, "VALIDATION_FAILED", "Invalid modifier selections");
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Invalid modifier selection",
      );
    const row = value as Record<string, unknown>;
    if (
      typeof row.modifierOptionId !== "string" ||
      seen.has(row.modifierOptionId)
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Invalid or duplicate modifier selection",
      );
    seen.add(row.modifierOptionId);
    return {
      modifierOptionId: row.modifierOptionId,
      quantity: quantityOf(row.quantity ?? 1, "modifier quantity"),
    };
  });
};

export class OrderService {
  constructor(
    private client: SQL,
    private deliveryPricing: DeliveryPricingService,
    private runtime: DriverRuntimeStoreLike | null = null,
    private logger: Logger | null = null,
  ) {}

  /**
   * Close open offer rounds and active assignment for a cancelled order.
   * Lock order (already held) → assignment → driver profile. Returns Redis side-effects.
   */
  private async closeAssignmentAndOffersOnCancel(
    tx: SQL,
    order: { id: string; cityId: string },
    now: Date,
  ): Promise<OrderCancelSideEffect> {
    const closedOffers = await tx<{ id: string }[]>`
      update order_offer_rounds
      set status = 'CANCELLED', closed_at = ${now}, updated_at = ${now}
      where order_id = ${order.id} and status = 'OPEN'
      returning id::text`;

    const [assignment] = await tx<
      { id: string; driver_id: string }[]
    >`select id::text, driver_id::text
      from order_driver_assignments
      where order_id = ${order.id}
        and completed_at is null
        and cancelled_at is null
      for update`;

    let driverId: string | null = null;
    let remainingActiveOrders = 0;
    let expectedRevision: number | null = null;
    let cityRevision: number | null = null;
    const jobIds: string[] = [];

    if (assignment) {
      driverId = assignment.driver_id;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`driver-assign:${driverId}`}, 0))`;
      await tx`
        select account_id from driver_profiles
        where account_id = ${driverId} for update`;
      await tx`
        update order_driver_assignments
        set cancelled_at = ${now}, updated_at = ${now}
        where id = ${assignment.id}
          and completed_at is null
          and cancelled_at is null`;
      await tx`
        update orders set driver_account_id = null, updated_at = ${now}
        where id = ${order.id}`;
      const [count] = await tx<{ count: number }[]>`
        select count(*)::int as count from order_driver_assignments
        where driver_id = ${driverId}
          and completed_at is null and cancelled_at is null`;
      remainingActiveOrders = count?.count ?? 0;
      expectedRevision = await bumpDriverRuntimeRevision(tx, driverId);
      jobIds.push(
        await enqueueDriverRuntimeRecon(tx, {
          driverId,
          expectedRevision,
          cityId: order.cityId,
        }),
      );
    }

    if (closedOffers.length > 0 || assignment) {
      const cityRecon = await enqueueCityOpenOffersRecon(tx, order.cityId);
      cityRevision = cityRecon.revision;
      jobIds.push(cityRecon.jobId);
    }

    return {
      cityId: order.cityId,
      orderId: order.id,
      closedOfferIds: closedOffers.map((row) => row.id),
      driverId,
      remainingActiveOrders,
      expectedRevision,
      cityRevision,
      jobIds,
    };
  }

  private async applyCancelRuntime(effect: OrderCancelSideEffect) {
    if (!this.runtime) return;
    if (
      effect.closedOfferIds.length === 0 &&
      !effect.driverId &&
      effect.jobIds.length === 0
    ) {
      return;
    }

    await applyRedisAfterCommit({
      client: this.client,
      jobIds: effect.jobIds,
      ...(this.logger ? { logger: this.logger } : {}),
      event: "driver_runtime_cancel_update_failed",
      apply: async () => {
        if (effect.cityRevision != null) {
          for (const offerId of effect.closedOfferIds) {
            await this.runtime!.removeOpenOfferWithCas(
              effect.cityId,
              offerId,
              effect.cityRevision,
            );
          }
        } else {
          for (const offerId of effect.closedOfferIds) {
            await this.runtime!.removeOpenOffer(effect.cityId, offerId);
          }
        }
        if (!effect.driverId) return;

        const current = await this.runtime!.getRuntime(effect.driverId);
        let workStatus: DriverWorkStatus;
        if (effect.remainingActiveOrders > 0) workStatus = "BUSY";
        else if (!current || current.workStatus === "OFFLINE")
          workStatus = "OFFLINE";
        else workStatus = "AVAILABLE";

        if (current) {
          const revision = effect.expectedRevision ?? current.revision;
          await this.runtime!.setRuntime({
            ...current,
            activeOrderCount: effect.remainingActiveOrders,
            workStatus,
            updatedAt: new Date().toISOString(),
            ...(revision != null ? { revision } : {}),
          });
        } else {
          await this.runtime!.invalidateRuntime(effect.driverId);
        }
      },
    });
  }

  private async assertActiveCustomer(tx: SQL, accountId: string) {
    const [row] = await tx<{ id: string }[]>`
      select cp.account_id::text id
      from customer_profiles cp
      join accounts a on a.id = cp.account_id
      where cp.account_id = ${accountId}
        and cp.status = 'ACTIVE'
        and a.status = 'ACTIVE'`;
    if (!row)
      throw new AppError(
        401,
        "AUTHENTICATION_STATE_INVALID",
        "Authentication state is invalid",
      );
  }

  private async validateLine(
    tx: SQL,
    cityId: string,
    storeId: string,
    item: CreateItemInput,
  ): Promise<ValidatedLine> {
    const quantity = quantityOf(item.quantity);
    const selections = parseSelections(item.modifierSelections);
    const [store] = await tx<{ order_acceptance_status: string }[]>`
      select s.order_acceptance_status::text
      from stores s
      join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
      where s.id = ${storeId}
        and s.city_id = ${cityId}
        and s.status = 'ACTIVE'
        and s.archived_at is null
        and mc.status = 'ACTIVE'
        and mc.archived_at is null
      for share of s`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    if (store.order_acceptance_status !== "ACCEPTING")
      throw new AppError(
        409,
        "STORE_NOT_ACCEPTING_ORDERS",
        "Store is not accepting orders",
      );

    const [product] = await tx<
      {
        id: string;
        name: string;
        base_price: number | null;
        modifier_group_id: string | null;
        is_available: boolean;
      }[]
    >`select p.id::text, p.name, p.base_price, p.modifier_group_id::text, p.is_available
      from products p
      left join store_categories sc on sc.id = p.category_id
      where p.id = ${item.productId}
        and p.store_id = ${storeId}
        and p.city_id = ${cityId}
        and p.status = 'ACTIVE'
        and p.archived_at is null
        and (p.category_id is null or (sc.status = 'ACTIVE' and sc.archived_at is null))
      for share of p`;
    if (!product || !product.is_available)
      throw new AppError(
        404,
        "ORDER_ITEM_UNAVAILABLE",
        "Order item is unavailable",
      );

    let selectedSizeId: string | null = null;
    let selectedSizeName: string | null = null;
    let unitPrice = product.base_price;
    const wantsSize = item.sizeId != null && item.sizeId !== undefined;
    if (product.base_price == null) {
      if (!wantsSize || typeof item.sizeId !== "string")
        throw new AppError(
          422,
          "PRODUCT_SIZE_REQUIRED",
          "Product size is required",
        );
      const [size] = await tx<{ id: string; name: string; price: number }[]>`
        select id::text, name, price
        from product_sizes
        where id = ${item.sizeId}
          and product_id = ${product.id}
          and store_id = ${storeId}
          and city_id = ${cityId}
          and status = 'ACTIVE'
          and is_available = true
        for share`;
      if (!size)
        throw new AppError(
          404,
          "PRODUCT_SIZE_NOT_FOUND",
          "Product size not found",
        );
      selectedSizeId = size.id;
      selectedSizeName = size.name;
      unitPrice = size.price;
    } else if (wantsSize) {
      throw new AppError(
        422,
        "PRODUCT_SIZE_NOT_APPLICABLE",
        "Product size is not applicable",
      );
    }
    if (unitPrice == null || unitPrice <= 0)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product price");

    const catalogSelections: ValidatedLine["selections"] = [];
    let modifiersPrice = 0;
    if (product.modifier_group_id) {
      const defaults = await tx<
        { id: string; name: string; price: number; max_quantity: number }[]
      >`select mo.id::text, mo.name, pmo.price, pmo.max_quantity
        from product_modifier_options pmo
        join modifier_options mo on mo.id = pmo.modifier_option_id
        where pmo.product_id = ${product.id}
          and mo.modifier_group_id = ${product.modifier_group_id}
          and mo.status = 'ACTIVE'
          and mo.archived_at is null
          and mo.is_available = true
          and pmo.is_default = true`;
      const requested =
        selections.length > 0
          ? selections
          : defaults.map((d) => ({ modifierOptionId: d.id, quantity: 1 }));
      for (const sel of requested) {
        const [opt] = await tx<
          {
            id: string;
            name: string;
            price: number;
            max_quantity: number;
            is_available: boolean;
          }[]
        >`select mo.id::text, mo.name, pmo.price, pmo.max_quantity, mo.is_available
          from product_modifier_options pmo
          join modifier_options mo on mo.id = pmo.modifier_option_id
          where pmo.product_id = ${product.id}
            and mo.id = ${sel.modifierOptionId}
            and mo.modifier_group_id = ${product.modifier_group_id}
            and mo.status = 'ACTIVE'
            and mo.archived_at is null`;
        if (!opt || !opt.is_available || (sel.quantity ?? 1) > opt.max_quantity)
          throw new AppError(
            422,
            "INVALID_MODIFIER_SELECTION",
            "Invalid modifier selection",
          );
        const qty = sel.quantity ?? 1;
        catalogSelections.push({
          modifierOptionId: opt.id,
          name: opt.name,
          quantity: qty,
          unitPrice: opt.price,
        });
        modifiersPrice += opt.price * qty;
      }
    } else if (selections.length > 0) {
      throw new AppError(
        422,
        "INVALID_MODIFIER_SELECTION",
        "Invalid modifier selection",
      );
    }

    return {
      productId: product.id,
      productName: product.name,
      selectedSizeId,
      selectedSizeName,
      unitPrice,
      modifiersPrice,
      quantity,
      lineTotal: (unitPrice + modifiersPrice) * quantity,
      selections: catalogSelections,
    };
  }

  private mapOrder(
    row: Record<string, unknown>,
    extras: Record<string, unknown> = {},
  ) {
    return {
      id: String(row.id),
      orderNumber: String(row.order_number),
      cityId: String(row.city_id),
      zoneId: String(row.zone_id),
      storeId: String(row.store_id),
      customerAccountId: String(row.customer_account_id),
      status: String(row.status) as OrderStatus,
      paymentMethod: String(row.payment_method) as PaymentMethod,
      paymentStatus: String(row.payment_status) as PaymentStatus,
      productsSubtotal: Number(row.products_subtotal),
      deliveryFee: Number(row.delivery_fee),
      total: Number(row.total),
      currency: "IQD" as const,
      version: Number(row.version),
      statusChangedAt: dateValue(row.status_changed_at)!,
      deliveredAt: dateValue(row.delivered_at),
      cancelledAt: dateValue(row.cancelled_at),
      createdAt: dateValue(row.created_at)!,
      updatedAt: dateValue(row.updated_at)!,
      ...extras,
    };
  }

  private async loadItems(executor: SQL, orderId: string) {
    const rows = await executor<Record<string, unknown>[]>`
      select id::text, product_id::text, selected_size_id::text, product_name_snapshot,
             selected_size_name_snapshot, unit_price_snapshot, modifiers_price_snapshot,
             quantity, line_total, state::text, replaces_order_item_id::text,
             modifier_selections_snapshot, created_at
      from order_items
      where order_id = ${orderId}
      order by created_at asc, id asc`;
    return rows.map((row) => ({
      id: String(row.id),
      productId: String(row.product_id),
      selectedSizeId:
        row.selected_size_id == null ? null : String(row.selected_size_id),
      productName: String(row.product_name_snapshot),
      selectedSizeName:
        row.selected_size_name_snapshot == null
          ? null
          : String(row.selected_size_name_snapshot),
      unitPrice: Number(row.unit_price_snapshot),
      modifiersPrice: Number(row.modifiers_price_snapshot),
      quantity: Number(row.quantity),
      lineTotal: Number(row.line_total),
      state: String(row.state) as OrderItemState,
      replacesOrderItemId:
        row.replaces_order_item_id == null
          ? null
          : String(row.replaces_order_item_id),
      modifierSelections: (Array.isArray(row.modifier_selections_snapshot)
        ? row.modifier_selections_snapshot
        : []) as Array<{
        modifierOptionId: string;
        name: string;
        quantity: number;
        unitPrice: number;
      }>,
      createdAt: dateValue(row.created_at)!,
    }));
  }

  private async loadHistory(executor: SQL, orderId: string) {
    const rows = await executor<Record<string, unknown>[]>`
      select id::text, from_status::text, to_status::text, entered_at, exited_at,
             duration_seconds, changed_by_account_id::text, actor_type::text,
             source::text, reason, created_at
      from order_status_history
      where order_id = ${orderId}
      order by entered_at asc, id asc`;
    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      enteredAt: dateValue(row.entered_at),
      exitedAt: dateValue(row.exited_at),
      durationSeconds:
        row.duration_seconds == null ? null : Number(row.duration_seconds),
      changedByAccountId: row.changed_by_account_id,
      actorType: row.actor_type,
      source: row.source,
      reason: row.reason,
      createdAt: dateValue(row.created_at),
    }));
  }

  /** Shared status transition used by order flows and driver-offer assignment. */
  async applyStatusTransition(
    tx: SQL,
    order: { id: string; status: OrderStatus; version: number },
    to: OrderStatus,
    actor: {
      accountId: string | null;
      actorType: ActorType;
      source: ActionSource;
      reason?: string | null;
    },
    now: Date,
  ) {
    return this.transition(tx, order, to, actor, now);
  }

  private async transition(
    tx: SQL,
    order: { id: string; status: OrderStatus; version: number },
    to: OrderStatus,
    actor: {
      accountId: string | null;
      actorType: ActorType;
      source: ActionSource;
      reason?: string | null;
    },
    now: Date,
  ) {
    assertTransition(order.status, to);
    const [open] = await tx<{ id: string; entered_at: Date }[]>`
      select id::text, entered_at
      from order_status_history
      where order_id = ${order.id} and exited_at is null
      for update`;
    if (!open)
      throw new AppError(
        500,
        "INTERNAL_ERROR",
        "Order history is inconsistent",
      );
    const durationSeconds = Math.max(
      0,
      Math.floor((now.getTime() - new Date(open.entered_at).getTime()) / 1000),
    );
    await tx`
      update order_status_history
      set exited_at = ${now}, duration_seconds = ${durationSeconds}
      where id = ${open.id}`;
    await tx`
      insert into order_status_history(
        order_id, from_status, to_status, entered_at, changed_by_account_id,
        actor_type, source, reason
      ) values (
        ${order.id}, ${order.status}, ${to}, ${now}, ${actor.accountId},
        ${actor.actorType}, ${actor.source}, ${actor.reason ?? null}
      )`;
    const deliveredAt = to === "DELIVERED" ? now : null;
    const cancelledAt = to === "CANCELLED" ? now : null;
    const updated = await tx<{ id: string }[]>`
      update orders
      set status = ${to},
          status_changed_at = ${now},
          version = version + 1,
          updated_at = ${now},
          delivered_at = coalesce(${deliveredAt}, delivered_at),
          cancelled_at = coalesce(${cancelledAt}, cancelled_at)
      where id = ${order.id} and version = ${order.version}
      returning id::text`;
    if (!updated[0])
      throw new AppError(
        409,
        "ORDER_INVALID_STATE",
        "Order was modified concurrently",
      );
  }

  async create(
    customerAccountId: string,
    cityId: string,
    input: {
      storeId: string;
      addressId: string;
      paymentMethod: PaymentMethod;
      items: CreateItemInput[];
      idempotencyKey: string;
      requestId?: string;
    },
  ) {
    if (!Array.isArray(input.items) || input.items.length === 0)
      throw new AppError(
        422,
        "ORDER_EMPTY",
        "Order must contain at least one item",
      );
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim()
    )
      throw new AppError(422, "VALIDATION_FAILED", "Invalid idempotencyKey");
    if (input.paymentMethod !== "CASH" && input.paymentMethod !== "ONLINE")
      throw new AppError(422, "VALIDATION_FAILED", "Invalid paymentMethod");
    if (input.paymentMethod === "ONLINE")
      throw new AppError(
        409,
        "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED",
        "Online payment is not confirmed",
      );

    const canonical = {
      storeId: input.storeId,
      addressId: input.addressId,
      paymentMethod: input.paymentMethod,
      items: input.items.map((item) => ({
        productId: item.productId,
        sizeId: item.sizeId ?? null,
        quantity: item.quantity,
        modifierSelections: parseSelections(item.modifierSelections)
          .map((s) => ({
            modifierOptionId: s.modifierOptionId,
            quantity: s.quantity ?? 1,
          }))
          .sort((a, b) => a.modifierOptionId.localeCompare(b.modifierOptionId)),
      })),
    };
    const requestHash = hashPayload(canonical);
    const idempotencyKey = input.idempotencyKey.trim();

    // Delivery quote outside the write lock — fail before order writes.
    const quote = await this.deliveryPricing.estimate(
      customerAccountId,
      cityId,
      {
        storeId: input.storeId,
        addressId: input.addressId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
    );
    if (!quote.publicEstimate.deliveryAvailable || !quote.snapshot)
      throw new AppError(
        409,
        "ORDER_DELIVERY_UNAVAILABLE",
        "Delivery is unavailable for this destination",
      );
    const deliverySnapshot = quote.snapshot;
    if (quote.publicEstimate.store.orderAcceptanceStatus !== "ACCEPTING")
      throw new AppError(
        409,
        "STORE_NOT_ACCEPTING_ORDERS",
        "Store is not accepting orders",
      );

    return this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`orders:create:${customerAccountId}:${cityId}:${idempotencyKey}`}, 0))`;
      await this.assertActiveCustomer(tx, customerAccountId);

      const [existing] = await tx<{ order_id: string; request_hash: string }[]>`
        select order_id::text, request_hash
        from order_idempotency_keys
        where customer_account_id = ${customerAccountId}
          and city_id = ${cityId}
          and idempotency_key = ${idempotencyKey}
        for update`;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new AppError(
            409,
            "ORDER_IDEMPOTENCY_CONFLICT",
            "Idempotency key was reused with a different payload",
          );
        return this.getForCustomer(
          customerAccountId,
          cityId,
          existing.order_id,
        );
      }

      const lines: ValidatedLine[] = [];
      for (const item of input.items)
        lines.push(await this.validateLine(tx, cityId, input.storeId, item));
      const productsSubtotal = lines.reduce(
        (sum, line) => sum + line.lineTotal,
        0,
      );
      const deliveryFee = deliverySnapshot.finalDeliveryFee;
      const total = productsSubtotal + deliveryFee;
      const paymentStatus =
        input.paymentMethod === "CASH" ? "UNPAID" : "AWAITING_PAYMENT";

      const [address] = await tx<
        {
          id: string;
          label: string;
          address_details: string;
          landmark: string | null;
          recipient_name: string | null;
          recipient_phone: string | null;
          latitude: number;
          longitude: number;
        }[]
      >`select id::text, label, address_details, landmark, recipient_name, recipient_phone,
               ST_Y(location)::float8 latitude, ST_X(location)::float8 longitude
        from customer_addresses
        where id = ${input.addressId}
          and customer_account_id = ${customerAccountId}
          and city_id = ${cityId}
        for share`;
      if (!address)
        throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");

      const [zone] = await tx<{ id: string }[]>`
        select z.id::text
        from zones z
        join store_zones sz on sz.zone_id = z.id and sz.city_id = z.city_id
        where z.city_id = ${cityId}
          and z.status = 'ACTIVE'
          and z.archived_at is null
          and sz.store_id = ${input.storeId}
          and ST_Covers(
            z.boundary,
            ST_SetSRID(ST_MakePoint(${address.longitude}, ${address.latitude}), 4326)
          )
        order by z.created_at asc, z.id asc
        limit 1`;
      if (!zone)
        throw new AppError(
          409,
          "ORDER_DELIVERY_UNAVAILABLE",
          "Delivery is unavailable for this destination",
        );

      const [numberRow] = await tx<{ n: string }[]>`
        select 'PP' || lpad(nextval('orders_public_number_seq')::text, 8, '0') as n`;
      const now = new Date();
      const [order] = await tx<Record<string, unknown>[]>`
        insert into orders(
          order_number, city_id, zone_id, store_id, customer_account_id, status,
          payment_method, payment_status, products_subtotal, delivery_fee, total,
          currency, version, status_changed_at, created_at, updated_at
        ) values (
          ${numberRow!.n}, ${cityId}, ${zone.id}, ${input.storeId}, ${customerAccountId},
          'UNDER_STORE_REVIEW', ${input.paymentMethod}, ${paymentStatus},
          ${productsSubtotal}, ${deliveryFee}, ${total}, 'IQD', 1, ${now}, ${now}, ${now}
        )
        returning id::text, order_number, city_id::text, zone_id::text, store_id::text,
                  customer_account_id::text, status::text, payment_method::text,
                  payment_status::text, products_subtotal, delivery_fee, total, currency,
                  version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at`;

      for (const line of lines) {
        await tx`
          insert into order_items(
            order_id, product_id, selected_size_id, product_name_snapshot,
            selected_size_name_snapshot, unit_price_snapshot, modifiers_price_snapshot,
            quantity, line_total, state, modifier_selections_snapshot
          ) values (
            ${order!.id}, ${line.productId}, ${line.selectedSizeId}, ${line.productName},
            ${line.selectedSizeName}, ${line.unitPrice}, ${line.modifiersPrice},
            ${line.quantity}, ${line.lineTotal}, 'ACTIVE', ${JSON.stringify(line.selections)}::jsonb
          )`;
      }

      await tx`
        insert into order_address_snapshots(
          order_id, source_address_id, label, address_details, landmark,
          recipient_name, recipient_phone, latitude, longitude
        ) values (
          ${order!.id}, ${address.id}, ${address.label}, ${address.address_details},
          ${address.landmark}, ${address.recipient_name}, ${address.recipient_phone},
          ${address.latitude}, ${address.longitude}
        )`;

      const snap = deliverySnapshot;
      await tx`
        insert into order_delivery_pricing_snapshots(
          order_id, pricing_version_id, pricing_version_number, routing_provider,
          distance_source, fallback_reason, distance_meters, duration_seconds,
          delivery_fee, zone_id, origin_latitude, origin_longitude,
          destination_latitude, destination_longitude, raw_calculation, calculated_at
        ) values (
          ${order!.id}, ${snap.pricingVersionId}, ${snap.pricingVersionNumber},
          ${snap.routingProvider}, ${snap.distanceSource}, ${snap.fallbackReason},
          ${snap.pricingDistanceMeters}, ${snap.durationSeconds}, ${snap.finalDeliveryFee},
          ${zone.id}, ${snap.origin.latitude}, ${snap.origin.longitude},
          ${snap.destination.latitude}, ${snap.destination.longitude},
          ${JSON.stringify(snap.rawCalculation)}::jsonb, ${new Date(snap.calculatedAt)}
        )`;

      await tx`
        insert into order_status_history(
          order_id, from_status, to_status, entered_at, changed_by_account_id,
          actor_type, source
        ) values (
          ${order!.id}, null, 'UNDER_STORE_REVIEW', ${now}, ${customerAccountId},
          'CUSTOMER', 'CUSTOMER_APP'
        )`;

      await tx`
        insert into order_idempotency_keys(
          customer_account_id, city_id, idempotency_key, request_hash, order_id
        ) values (
          ${customerAccountId}, ${cityId}, ${idempotencyKey}, ${requestHash}, ${order!.id}
        )`;

      const items = await this.loadItems(tx, String(order!.id));
      return this.mapOrder(order!, { items });
    });
  }

  async getForCustomer(
    customerAccountId: string,
    cityId: string,
    orderId: string,
  ) {
    await this.assertActiveCustomer(this.client, customerAccountId);
    const [row] = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders
      where id = ${orderId}
        and customer_account_id = ${customerAccountId}
        and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return this.mapOrder(row, {
      items: await this.loadItems(this.client, orderId),
    });
  }

  async listForCustomer(
    customerAccountId: string,
    cityId: string,
    page = 1,
    limit = 20,
  ) {
    await this.assertActiveCustomer(this.client, customerAccountId);
    const p = pageOf(page, limit);
    const offset = (p.page - 1) * p.limit;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from orders
      where customer_account_id = ${customerAccountId} and city_id = ${cityId}`;
    const rows = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders
      where customer_account_id = ${customerAccountId} and city_id = ${cityId}
      order by created_at desc, id desc
      limit ${p.limit} offset ${offset}`;
    return {
      data: rows.map((row) => this.mapOrder(row)),
      page: p.page,
      limit: p.limit,
      total: count?.total ?? 0,
    };
  }

  async cancelByCustomer(
    customerAccountId: string,
    cityId: string,
    orderId: string,
    reason: unknown,
  ) {
    const cleaned = cleanReason(reason);
    const effect = await this.client.begin(async (tx) => {
      await this.assertActiveCustomer(tx, customerAccountId);
      const [order] = await tx<
        { id: string; status: OrderStatus; version: number; city_id: string }[]
      >`select id::text, status::text, version, city_id::text
        from orders
        where id = ${orderId}
          and customer_account_id = ${customerAccountId}
          and city_id = ${cityId}
        for update`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (!customerMayCancel(order.status))
        throw new AppError(
          409,
          "ORDER_CANCELLATION_NOT_ALLOWED",
          "Order cannot be cancelled",
        );
      const now = new Date();
      await this.transition(
        tx,
        order,
        "CANCELLED",
        {
          accountId: customerAccountId,
          actorType: "CUSTOMER",
          source: "CUSTOMER_APP",
          reason: cleaned,
        },
        now,
      );
      await tx`
        insert into order_cancellations(
          order_id, previous_status, actor_account_id, actor_type, source, reason
        ) values (
          ${order.id}, ${order.status}, ${customerAccountId}, 'CUSTOMER',
          'CUSTOMER_APP', ${cleaned}
        )`;
      return this.closeAssignmentAndOffersOnCancel(
        tx,
        { id: order.id, cityId: order.city_id },
        now,
      );
    });
    await this.applyCancelRuntime(effect);
    return this.getForCustomer(customerAccountId, cityId, orderId);
  }

  async listForDashboard(identity: AuthIdentity, page = 1, limit = 20) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const p = pageOf(page, limit);
    const offset = (p.page - 1) * p.limit;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from orders where city_id = ${cityId}`;
    const rows = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders
      where city_id = ${cityId}
      order by created_at desc, id desc
      limit ${p.limit} offset ${offset}`;
    return {
      data: rows.map((row) => this.mapOrder(row)),
      page: p.page,
      limit: p.limit,
      total: count?.total ?? 0,
    };
  }

  async getForDashboard(identity: AuthIdentity, orderId: string) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const [row] = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders where id = ${orderId} and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const [address] = await this.client<Record<string, unknown>[]>`
      select label, address_details, landmark, recipient_name, recipient_phone,
             latitude, longitude, source_address_id::text
      from order_address_snapshots where order_id = ${orderId}`;
    const [pricing] = await this.client<Record<string, unknown>[]>`
      select pricing_version_id::text, pricing_version_number, routing_provider,
             distance_source, fallback_reason, distance_meters, duration_seconds,
             delivery_fee, zone_id::text, origin_latitude, origin_longitude,
             destination_latitude, destination_longitude, calculated_at
      from order_delivery_pricing_snapshots where order_id = ${orderId}`;
    const [cancellation] = await this.client<Record<string, unknown>[]>`
      select id::text, previous_status::text, actor_account_id::text, actor_type::text,
             source::text, reason, created_at
      from order_cancellations where order_id = ${orderId}`;
    return this.mapOrder(row, {
      items: await this.loadItems(this.client, orderId),
      statusHistory: await this.loadHistory(this.client, orderId),
      addressSnapshot: address
        ? {
            label: address.label,
            addressDetails: address.address_details,
            landmark: address.landmark,
            recipientName: address.recipient_name,
            recipientPhone: address.recipient_phone,
            latitude: Number(address.latitude),
            longitude: Number(address.longitude),
            sourceAddressId: address.source_address_id,
          }
        : null,
      deliveryPricingSnapshot: pricing
        ? {
            pricingVersionId: pricing.pricing_version_id,
            pricingVersionNumber: Number(pricing.pricing_version_number),
            routingProvider: pricing.routing_provider,
            distanceSource: pricing.distance_source,
            fallbackReason: pricing.fallback_reason,
            distanceMeters: Number(pricing.distance_meters),
            durationSeconds:
              pricing.duration_seconds == null
                ? null
                : Number(pricing.duration_seconds),
            deliveryFee: Number(pricing.delivery_fee),
            zoneId: pricing.zone_id,
            origin: {
              latitude: Number(pricing.origin_latitude),
              longitude: Number(pricing.origin_longitude),
            },
            destination: {
              latitude: Number(pricing.destination_latitude),
              longitude: Number(pricing.destination_longitude),
            },
            calculatedAt: dateValue(pricing.calculated_at),
          }
        : null,
      cancellation: cancellation
        ? {
            id: cancellation.id,
            previousStatus: cancellation.previous_status,
            actorAccountId: cancellation.actor_account_id,
            actorType: cancellation.actor_type,
            source: cancellation.source,
            reason: cancellation.reason,
            createdAt: dateValue(cancellation.created_at),
          }
        : null,
    });
  }

  async cancelByDashboard(
    identity: AuthIdentity,
    orderId: string,
    reason: unknown,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.cancel",
    );
    const cleaned = cleanReason(reason);
    const effect = await this.client.begin(async (tx) => {
      const [order] = await tx<
        { id: string; status: OrderStatus; version: number; city_id: string }[]
      >`select id::text, status::text, version, city_id::text
        from orders where id = ${orderId} and city_id = ${cityId} for update`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (!dashboardMayCancel(order.status))
        throw new AppError(
          409,
          "ORDER_CANCELLATION_NOT_ALLOWED",
          "Order cannot be cancelled",
        );
      const now = new Date();
      await this.transition(
        tx,
        order,
        "CANCELLED",
        {
          accountId: identity.accountId,
          actorType: "STAFF",
          source: "DASHBOARD",
          reason: cleaned,
        },
        now,
      );
      await tx`
        insert into order_cancellations(
          order_id, previous_status, actor_account_id, actor_type, source, reason
        ) values (
          ${order.id}, ${order.status}, ${identity.accountId}, 'STAFF',
          'DASHBOARD', ${cleaned}
        )`;
      await tx`
        insert into audit_logs (
          event_type, actor_account_id, actor_session_id, target_type, target_id,
          outcome, request_correlation_id, redacted_metadata
        ) values (
          'ORDER_CANCELLED', ${identity.accountId}, ${identity.sessionId || null},
          'ORDER', ${order.id}, 'SUCCESS', null,
          ${JSON.stringify({ cityId, previousStatus: order.status })}::jsonb
        )`;
      return this.closeAssignmentAndOffersOnCancel(
        tx,
        { id: order.id, cityId: order.city_id },
        now,
      );
    });
    await this.applyCancelRuntime(effect);
    return this.getForDashboard(identity, orderId);
  }

  async approve(
    identity: AuthIdentity,
    orderId: string,
    scope: { kind: "DASHBOARD" } | { kind: "MERCHANT"; storeId: string },
  ) {
    const cityId =
      scope.kind === "DASHBOARD"
        ? await requireCityPermission(this.client, identity, "orders.approve")
        : identity.cityId;
    if (!cityId)
      throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
    const scopedCityId = cityId;
    const merchantStoreId = scope.kind === "MERCHANT" ? scope.storeId : null;

    await this.client.begin(async (tx) => {
      const [order] = await tx<
        {
          id: string;
          status: OrderStatus;
          version: number;
          store_id: string;
          products_subtotal: number;
          delivery_fee: number;
          total: number;
          payment_method: string;
          payment_status: string;
        }[]
      >`select id::text, status::text, version, store_id::text, products_subtotal,
               delivery_fee, total, payment_method::text, payment_status::text
        from orders where id = ${orderId} and city_id = ${scopedCityId} for update`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (merchantStoreId && order.store_id !== merchantStoreId)
        throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      assertPaymentAllowsMutation(order);
      if (!mayApprove(order.status))
        throw new AppError(
          409,
          "ORDER_INVALID_STATE",
          "Order cannot be approved",
        );
      const [activeCount] = await tx<{ count: number }[]>`
        select count(*)::int count from order_items
        where order_id = ${order.id} and state = 'ACTIVE'`;
      if (!activeCount || activeCount.count < 1)
        throw new AppError(
          422,
          "ORDER_EMPTY",
          "Order must contain at least one item",
        );
      const [sum] = await tx<{ subtotal: number }[]>`
        select coalesce(sum(line_total),0)::int subtotal from order_items
        where order_id = ${order.id} and state = 'ACTIVE'`;
      if (
        sum!.subtotal !== order.products_subtotal ||
        order.total !== order.products_subtotal + order.delivery_fee
      )
        throw new AppError(
          409,
          "ORDER_TOTAL_CHANGED",
          "Order totals are inconsistent",
        );

      const now = new Date();
      await this.transition(
        tx,
        order,
        "APPROVED_BY_STORE",
        {
          accountId: identity.accountId,
          actorType: scope.kind === "MERCHANT" ? "MERCHANT" : "STAFF",
          source: scope.kind === "MERCHANT" ? "MERCHANT_APP" : "DASHBOARD",
        },
        now,
      );
    });
    if (scope.kind === "DASHBOARD")
      return this.getForDashboard(identity, orderId);
    return this.getForStore(scope.storeId, scopedCityId, orderId);
  }

  async listForStore(storeId: string, cityId: string, page = 1, limit = 20) {
    const p = pageOf(page, limit);
    const offset = (p.page - 1) * p.limit;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from orders
      where store_id = ${storeId} and city_id = ${cityId}`;
    const rows = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders
      where store_id = ${storeId} and city_id = ${cityId}
      order by created_at desc, id desc
      limit ${p.limit} offset ${offset}`;
    return {
      data: rows.map((row) => this.mapOrder(row)),
      page: p.page,
      limit: p.limit,
      total: count?.total ?? 0,
    };
  }

  async getForStore(storeId: string, cityId: string, orderId: string) {
    const [row] = await this.client<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, zone_id::text, store_id::text,
             customer_account_id::text, status::text, payment_method::text,
             payment_status::text, products_subtotal, delivery_fee, total, currency,
             version, status_changed_at, delivered_at, cancelled_at, created_at, updated_at
      from orders
      where id = ${orderId} and store_id = ${storeId} and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return this.mapOrder(row, {
      items: await this.loadItems(this.client, orderId),
      statusHistory: await this.loadHistory(this.client, orderId),
    });
  }

  async replaceItem(
    identity: AuthIdentity,
    orderId: string,
    originalItemId: string,
    input: {
      productId: string;
      sizeId?: string | null;
      quantity: number;
      modifierSelections?: SelectionInput[];
      reason: unknown;
      customerAgreedByPhone: unknown;
    },
    scope: { kind: "DASHBOARD" } | { kind: "MERCHANT"; storeId: string },
  ) {
    const cityId =
      scope.kind === "DASHBOARD"
        ? await requireCityPermission(
            this.client,
            identity,
            "orders.items.replace",
          )
        : identity.cityId;
    if (!cityId)
      throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
    const scopedCityId = cityId;
    const reason = cleanReason(input.reason);
    if (input.customerAgreedByPhone !== true)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "customerAgreedByPhone must be true",
      );

    await this.client.begin(async (tx) => {
      const [order] = await tx<
        {
          id: string;
          status: OrderStatus;
          version: number;
          store_id: string;
          products_subtotal: number;
          delivery_fee: number;
          total: number;
          payment_method: string;
          payment_status: string;
        }[]
      >`select id::text, status::text, version, store_id::text, products_subtotal,
               delivery_fee, total, payment_method::text, payment_status::text
        from orders where id = ${orderId} and city_id = ${scopedCityId} for update`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (scope.kind === "MERCHANT" && order.store_id !== scope.storeId)
        throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      assertPaymentAllowsMutation(order);
      if (!mayReplaceItems(order.status))
        throw new AppError(
          409,
          "ORDER_ITEM_REPLACEMENT_NOT_ALLOWED",
          "Item replacement is not allowed",
        );

      const [original] = await tx<
        {
          id: string;
          state: string;
          product_id: string;
          product_name_snapshot: string;
          quantity: number;
          unit_price_snapshot: number;
          line_total: number;
        }[]
      >`select id::text, state::text, product_id::text, product_name_snapshot,
               quantity, unit_price_snapshot, line_total
        from order_items where id = ${originalItemId} and order_id = ${order.id}
        for update`;
      if (!original)
        throw new AppError(404, "ORDER_ITEM_NOT_FOUND", "Order item not found");
      if (original.state === "REPLACED")
        throw new AppError(
          409,
          "ORDER_ITEM_ALREADY_REPLACED",
          "Order item was already replaced",
        );

      const replacement = await this.validateLine(
        tx,
        scopedCityId,
        order.store_id,
        {
          productId: input.productId,
          quantity: input.quantity,
          ...(input.sizeId !== undefined ? { sizeId: input.sizeId } : {}),
          ...(input.modifierSelections !== undefined
            ? { modifierSelections: input.modifierSelections }
            : {}),
        },
      );

      await tx`
        update order_items set state = 'REPLACED' where id = ${original.id}`;
      const [created] = await tx<{ id: string }[]>`
        insert into order_items(
          order_id, product_id, selected_size_id, product_name_snapshot,
          selected_size_name_snapshot, unit_price_snapshot, modifiers_price_snapshot,
          quantity, line_total, state, replaces_order_item_id, modifier_selections_snapshot
        ) values (
          ${order.id}, ${replacement.productId}, ${replacement.selectedSizeId},
          ${replacement.productName}, ${replacement.selectedSizeName},
          ${replacement.unitPrice}, ${replacement.modifiersPrice}, ${replacement.quantity},
          ${replacement.lineTotal}, 'ACTIVE', ${original.id},
          ${JSON.stringify(replacement.selections)}::jsonb
        ) returning id::text`;

      const productsSubtotalAfter =
        order.products_subtotal - original.line_total + replacement.lineTotal;
      const totalAfter = productsSubtotalAfter + order.delivery_fee;
      const updated = await tx<{ id: string }[]>`
        update orders
        set products_subtotal = ${productsSubtotalAfter},
            total = ${totalAfter},
            version = version + 1,
            updated_at = now()
        where id = ${order.id} and version = ${order.version}
        returning id::text`;
      if (!updated[0])
        throw new AppError(
          409,
          "ORDER_INVALID_STATE",
          "Order was modified concurrently",
        );

      await tx`
        insert into order_item_replacements(
          order_id, original_order_item_id, replacement_order_item_id,
          original_product_id, replacement_product_id,
          original_product_name_snapshot, replacement_product_name_snapshot,
          original_quantity, replacement_quantity, original_unit_price,
          replacement_unit_price, original_line_total, replacement_line_total,
          products_subtotal_before, products_subtotal_after, total_before, total_after,
          price_difference, actor_account_id, actor_type, source, reason,
          customer_agreed_by_phone
        ) values (
          ${order.id}, ${original.id}, ${created!.id},
          ${original.product_id}, ${replacement.productId},
          ${original.product_name_snapshot}, ${replacement.productName},
          ${original.quantity}, ${replacement.quantity}, ${original.unit_price_snapshot},
          ${replacement.unitPrice}, ${original.line_total}, ${replacement.lineTotal},
          ${order.products_subtotal}, ${productsSubtotalAfter}, ${order.total}, ${totalAfter},
          ${replacement.lineTotal - original.line_total}, ${identity.accountId},
          ${scope.kind === "MERCHANT" ? "MERCHANT" : "STAFF"},
          ${scope.kind === "MERCHANT" ? "MERCHANT_APP" : "DASHBOARD"},
          ${reason}, true
        )`;
    });
    if (scope.kind === "DASHBOARD")
      return this.getForDashboard(identity, orderId);
    return this.getForStore(scope.storeId, scopedCityId, orderId);
  }
}
