import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { customerAddresses } from "./customer-addresses";
import { cityDeliveryPricingVersions } from "./delivery-pricing";
import {
  orderCustodyStatus,
  orderEventType,
  orderActionSource,
  orderActorType,
  orderItemState,
  orderPaymentMethod,
  orderPaymentStatus,
  orderProofPurpose,
  orderStatus,
} from "./enums";
import { cities, zones } from "./geography";
import { mediaAssets } from "./media";
import { products, productSizes } from "./products";
import { stores } from "./stores";
import { orderDriverAssignments } from "./driver-offers";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: text("order_number").notNull(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    zoneId: uuid("zone_id").notNull(),
    storeId: uuid("store_id").notNull(),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references(() => accounts.id),
    driverAccountId: uuid("driver_account_id").references(() => accounts.id),
    status: orderStatus("status").notNull().default("PENDING_STORE_APPROVAL"),
    custodyStatus: orderCustodyStatus("custody_status")
      .notNull()
      .default("WITH_STORE"),
    custodyDriverId: uuid("custody_driver_id").references(() => accounts.id),
    paymentMethod: orderPaymentMethod("payment_method").notNull(),
    paymentStatus: orderPaymentStatus("payment_status").notNull(),
    productsSubtotal: integer("products_subtotal").notNull(),
    deliveryFee: integer("delivery_fee").notNull(),
    total: integer("total").notNull(),
    currency: text("currency").notNull().default("IQD"),
    lockedDriverFee: integer("locked_driver_fee"),
    storeReadyMarkedAt: instant("store_ready_marked_at"),
    version: integer("version").notNull().default(1),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    deliveredAt: instant("delivered_at"),
    cancelledAt: instant("cancelled_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("orders_order_number_uidx").on(table.orderNumber),
    uniqueIndex("orders_id_city_uidx").on(table.id, table.cityId),
    foreignKey({
      name: "orders_store_city_fk",
      columns: [table.storeId, table.cityId],
      foreignColumns: [stores.id, stores.cityId],
    }),
    foreignKey({
      name: "orders_zone_city_fk",
      columns: [table.zoneId, table.cityId],
      foreignColumns: [zones.id, zones.cityId],
    }),
    index("orders_city_status_created_idx").on(
      table.cityId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("orders_store_status_created_idx").on(
      table.storeId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("orders_customer_created_idx").on(
      table.customerAccountId,
      table.createdAt,
      table.id,
    ),
    index("orders_city_created_idx").on(
      table.cityId,
      table.createdAt,
      table.id,
    ),
    check(
      "orders_locked_driver_fee_chk",
      sql`${table.lockedDriverFee} is null or ${table.lockedDriverFee} > 0`,
    ),
    check(
      "orders_money_nonneg_chk",
      sql`${table.productsSubtotal} >= 0 and ${table.deliveryFee} >= 0 and ${table.total} >= 0`,
    ),
    check(
      "orders_total_sum_chk",
      sql`${table.total} = ${table.productsSubtotal} + ${table.deliveryFee}`,
    ),
    check("orders_currency_chk", sql`${table.currency} = 'IQD'`),
    check("orders_version_positive_chk", sql`${table.version} > 0`),
    check(
      "orders_cancelled_at_chk",
      sql`(${table.status} = 'CANCELLED' and ${table.cancelledAt} is not null) or (${table.status} <> 'CANCELLED' and ${table.cancelledAt} is null)`,
    ),
    check(
      "orders_delivered_at_chk",
      sql`(${table.status} = 'DELIVERED' and ${table.deliveredAt} is not null) or (${table.status} <> 'DELIVERED' and ${table.deliveredAt} is null)`,
    ),
    check(
      "orders_custody_logic_chk",
      sql`(${table.custodyStatus} = 'WITH_STORE' and ${table.custodyDriverId} is null)
        or (${table.custodyStatus} = 'WITH_DRIVER' and ${table.custodyDriverId} is not null)
        or (${table.custodyStatus} = 'WITH_CUSTOMER' and ${table.custodyDriverId} is null)`,
    ),
    check(
      "orders_status_custody_chk",
      sql`(${table.status} in ('PICKED_UP','ARRIVED_AT_CUSTOMER') and ${table.custodyStatus} = 'WITH_DRIVER' and ${table.custodyDriverId} is not null)
        or (${table.status} = 'DELIVERED' and ${table.custodyStatus} = 'WITH_CUSTOMER' and ${table.custodyDriverId} is null)
        or (${table.status} not in ('PICKED_UP','ARRIVED_AT_CUSTOMER','DELIVERED'))`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    productId: uuid("product_id").notNull(),
    selectedSizeId: uuid("selected_size_id"),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    selectedSizeNameSnapshot: text("selected_size_name_snapshot"),
    unitPriceSnapshot: integer("unit_price_snapshot").notNull(),
    modifiersPriceSnapshot: integer("modifiers_price_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: integer("line_total").notNull(),
    state: orderItemState("state").notNull().default("ACTIVE"),
    replacesOrderItemId: uuid("replaces_order_item_id"),
    modifierSelectionsSnapshot: jsonb("modifier_selections_snapshot")
      .$type<
        Array<{
          modifierOptionId: string;
          name: string;
          quantity: number;
          unitPrice: number;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("order_items_order_state_idx").on(table.orderId, table.state),
    foreignKey({
      name: "order_items_product_fk",
      columns: [table.productId],
      foreignColumns: [products.id],
    }),
    foreignKey({
      name: "order_items_size_fk",
      columns: [table.selectedSizeId],
      foreignColumns: [productSizes.id],
    }),
    foreignKey({
      name: "order_items_replaces_fk",
      columns: [table.replacesOrderItemId],
      foreignColumns: [table.id],
    }),
    check("order_items_quantity_chk", sql`${table.quantity} between 1 and 99`),
    check(
      "order_items_prices_chk",
      sql`${table.unitPriceSnapshot} > 0 and ${table.modifiersPriceSnapshot} >= 0 and ${table.lineTotal} > 0`,
    ),
    check(
      "order_items_line_total_chk",
      sql`${table.lineTotal} = (${table.unitPriceSnapshot} + ${table.modifiersPriceSnapshot}) * ${table.quantity}`,
    ),
    check(
      "order_items_size_snapshot_chk",
      sql`(${table.selectedSizeId} is null) = (${table.selectedSizeNameSnapshot} is null)`,
    ),
  ],
);

export const orderItemReplacements = pgTable(
  "order_item_replacements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    originalOrderItemId: uuid("original_order_item_id")
      .notNull()
      .references(() => orderItems.id),
    replacementOrderItemId: uuid("replacement_order_item_id")
      .notNull()
      .references(() => orderItems.id),
    originalProductId: uuid("original_product_id").notNull(),
    replacementProductId: uuid("replacement_product_id").notNull(),
    originalProductNameSnapshot: text(
      "original_product_name_snapshot",
    ).notNull(),
    replacementProductNameSnapshot: text(
      "replacement_product_name_snapshot",
    ).notNull(),
    originalQuantity: integer("original_quantity").notNull(),
    replacementQuantity: integer("replacement_quantity").notNull(),
    originalUnitPrice: integer("original_unit_price").notNull(),
    replacementUnitPrice: integer("replacement_unit_price").notNull(),
    originalLineTotal: integer("original_line_total").notNull(),
    replacementLineTotal: integer("replacement_line_total").notNull(),
    productsSubtotalBefore: integer("products_subtotal_before").notNull(),
    productsSubtotalAfter: integer("products_subtotal_after").notNull(),
    totalBefore: integer("total_before").notNull(),
    totalAfter: integer("total_after").notNull(),
    priceDifference: integer("price_difference").notNull(),
    actorAccountId: uuid("actor_account_id")
      .notNull()
      .references(() => accounts.id),
    actorType: orderActorType("actor_type").notNull(),
    source: orderActionSource("source").notNull(),
    reason: text("reason").notNull(),
    customerAgreedByPhone: boolean("customer_agreed_by_phone")
      .notNull()
      .default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_item_replacements_original_uidx").on(
      table.originalOrderItemId,
    ),
    index("order_item_replacements_order_created_idx").on(
      table.orderId,
      table.createdAt,
    ),
    check(
      "order_item_replacements_reason_chk",
      sql`length(btrim(${table.reason})) > 0`,
    ),
  ],
);

export const orderCustodyHistory = pgTable(
  "order_custody_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    assignmentId: uuid("assignment_id").references(
      () => orderDriverAssignments.id,
    ),
    fromStatus: orderCustodyStatus("from_status"),
    toStatus: orderCustodyStatus("to_status").notNull(),
    fromDriverId: uuid("from_driver_id"),
    toDriverId: uuid("to_driver_id"),
    actorAccountId: uuid("actor_account_id"),
    actorType: orderActorType("actor_type").notNull(),
    source: orderActionSource("source").notNull(),
    reason: text("reason"),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("order_custody_history_order_created_idx").on(
      table.orderId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    assignmentId: uuid("assignment_id").references(
      () => orderDriverAssignments.id,
    ),
    eventType: orderEventType("event_type").notNull(),
    fromOrderStatus: orderStatus("from_order_status"),
    toOrderStatus: orderStatus("to_order_status"),
    fromCustodyStatus: orderCustodyStatus("from_custody_status"),
    toCustodyStatus: orderCustodyStatus("to_custody_status"),
    actorType: orderActorType("actor_type").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id),
    source: orderActionSource("source").notNull(),
    actedOnBehalfOf: text("acted_on_behalf_of"),
    reason: text("reason"),
    proofId: uuid("proof_id"),
    handoffId: uuid("handoff_id"),
    returnWorkflowId: uuid("return_workflow_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("order_events_order_created_idx").on(
      table.orderId,
      table.createdAt,
      table.id,
    ),
    check(
      "order_events_acted_on_behalf_chk",
      sql`${table.actedOnBehalfOf} is null or ${table.actedOnBehalfOf} in ('STORE','DRIVER')`,
    ),
  ],
);

export const orderItemMutations = pgTable(
  "order_item_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    mutationType: text("mutation_type").notNull(),
    orderItemId: uuid("order_item_id"),
    relatedOrderItemId: uuid("related_order_item_id"),
    productIdBefore: uuid("product_id_before"),
    productIdAfter: uuid("product_id_after"),
    productNameBefore: text("product_name_before"),
    productNameAfter: text("product_name_after"),
    quantityBefore: integer("quantity_before"),
    quantityAfter: integer("quantity_after"),
    unitPriceBefore: integer("unit_price_before"),
    unitPriceAfter: integer("unit_price_after"),
    lineTotalBefore: integer("line_total_before"),
    lineTotalAfter: integer("line_total_after"),
    productsSubtotalBefore: integer("products_subtotal_before").notNull(),
    productsSubtotalAfter: integer("products_subtotal_after").notNull(),
    deliveryFeeBefore: integer("delivery_fee_before").notNull(),
    deliveryFeeAfter: integer("delivery_fee_after").notNull(),
    totalBefore: integer("total_before").notNull(),
    totalAfter: integer("total_after").notNull(),
    actorAccountId: uuid("actor_account_id").notNull(),
    actorType: orderActorType("actor_type").notNull(),
    source: orderActionSource("source").notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("order_item_mutations_order_created_idx").on(
      table.orderId,
      table.createdAt,
      table.id,
    ),
    check(
      "order_item_mutations_reason_chk",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      "order_item_mutations_type_chk",
      sql`${table.mutationType} in ('ADD','REMOVE','REPLACE','QUANTITY_CHANGE')`,
    ),
    check(
      "order_item_mutations_delivery_fee_unchanged_chk",
      sql`${table.deliveryFeeBefore} = ${table.deliveryFeeAfter}`,
    ),
  ],
);

export const orderProofs = pgTable(
  "order_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => orderDriverAssignments.id),
    cityId: uuid("city_id").notNull().references(() => cities.id),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id),
    purpose: orderProofPurpose("purpose").notNull(),
    uploadedByDriverId: uuid("uploaded_by_driver_id")
      .notNull()
      .references(() => accounts.id),
    handoffId: uuid("handoff_id"),
    returnWorkflowId: uuid("return_workflow_id"),
    consumedAt: instant("consumed_at"),
    consumedByEventId: uuid("consumed_by_event_id"),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_proofs_media_asset_uidx").on(table.mediaAssetId),
    uniqueIndex("order_proofs_one_consumed_purpose_uidx")
      .on(table.orderId, table.assignmentId, table.purpose)
      .where(sql`${table.consumedAt} is not null`),
    index("order_proofs_order_created_idx").on(table.orderId, table.createdAt),
  ],
);

export const orderDriverHandoffs = pgTable(
  "order_driver_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    cityId: uuid("city_id").notNull().references(() => cities.id),
    fromAssignmentId: uuid("from_assignment_id")
      .notNull()
      .references(() => orderDriverAssignments.id),
    toAssignmentId: uuid("to_assignment_id")
      .notNull()
      .references(() => orderDriverAssignments.id),
    fromDriverId: uuid("from_driver_id")
      .notNull()
      .references(() => accounts.id),
    toDriverId: uuid("to_driver_id").notNull().references(() => accounts.id),
    status: text("status").notNull().default("PENDING"),
    reason: text("reason").notNull(),
    startedByAccountId: uuid("started_by_account_id")
      .notNull()
      .references(() => accounts.id),
    startedAt: instant("started_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
    cancelledAt: instant("cancelled_at"),
    proofId: uuid("proof_id"),
    version: integer("version").notNull().default(1),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_driver_handoffs_active_order_uidx")
      .on(table.orderId)
      .where(sql`${table.status} = 'PENDING'`),
    index("order_driver_handoffs_order_created_idx").on(
      table.orderId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "order_driver_handoffs_order_city_fk",
      columns: [table.orderId, table.cityId],
      foreignColumns: [orders.id, orders.cityId],
    }),
    check(
      "order_driver_handoffs_reason_chk",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      "order_driver_handoffs_drivers_diff_chk",
      sql`${table.fromDriverId} <> ${table.toDriverId}`,
    ),
  ],
);

export const orderReturnWorkflows = pgTable(
  "order_return_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    cityId: uuid("city_id").notNull().references(() => cities.id),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => orderDriverAssignments.id),
    driverId: uuid("driver_id").notNull().references(() => accounts.id),
    status: text("status").notNull().default("WAITING_FOR_DRIVER_RETURN"),
    reason: text("reason").notNull(),
    startedByAccountId: uuid("started_by_account_id")
      .notNull()
      .references(() => accounts.id),
    startedAt: instant("started_at").notNull().defaultNow(),
    driverReturnedAt: instant("driver_returned_at"),
    storeConfirmedAt: instant("store_confirmed_at"),
    completedAt: instant("completed_at"),
    cancelledAt: instant("cancelled_at"),
    proofId: uuid("proof_id"),
    version: integer("version").notNull().default(1),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_return_workflows_active_order_uidx")
      .on(table.orderId)
      .where(
        sql`${table.status} in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')`,
      ),
    index("order_return_workflows_order_created_idx").on(
      table.orderId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "order_return_workflows_order_city_fk",
      columns: [table.orderId, table.cityId],
      foreignColumns: [orders.id, orders.cityId],
    }),
    check(
      "order_return_workflows_reason_chk",
      sql`length(btrim(${table.reason})) > 0`,
    ),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    fromStatus: orderStatus("from_status"),
    toStatus: orderStatus("to_status").notNull(),
    enteredAt: instant("entered_at").notNull(),
    exitedAt: instant("exited_at"),
    durationSeconds: integer("duration_seconds"),
    changedByAccountId: uuid("changed_by_account_id").references(
      () => accounts.id,
    ),
    actorType: orderActorType("actor_type").notNull(),
    source: orderActionSource("source").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("order_status_history_order_entered_idx").on(
      table.orderId,
      table.enteredAt,
      table.id,
    ),
    uniqueIndex("order_status_history_one_open_uidx")
      .on(table.orderId)
      .where(sql`${table.exitedAt} is null`),
    check(
      "order_status_history_duration_chk",
      sql`(${table.exitedAt} is null and ${table.durationSeconds} is null) or (${table.exitedAt} is not null and ${table.durationSeconds} is not null and ${table.durationSeconds} >= 0)`,
    ),
  ],
);

export const orderAddressSnapshots = pgTable(
  "order_address_snapshots",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id),
    sourceAddressId: uuid("source_address_id").references(
      () => customerAddresses.id,
    ),
    label: text("label").notNull(),
    addressDetails: text("address_details").notNull(),
    landmark: text("landmark"),
    recipientName: text("recipient_name"),
    recipientPhone: text("recipient_phone"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "order_address_snapshots_lat_chk",
      sql`${table.latitude} between -90 and 90`,
    ),
    check(
      "order_address_snapshots_lng_chk",
      sql`${table.longitude} between -180 and 180`,
    ),
  ],
);

export const orderDeliveryPricingSnapshots = pgTable(
  "order_delivery_pricing_snapshots",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id),
    pricingVersionId: uuid("pricing_version_id")
      .notNull()
      .references(() => cityDeliveryPricingVersions.id),
    pricingVersionNumber: integer("pricing_version_number").notNull(),
    routingProvider: text("routing_provider").notNull(),
    distanceSource: text("distance_source").notNull(),
    fallbackReason: text("fallback_reason"),
    distanceMeters: doublePrecision("distance_meters").notNull(),
    durationSeconds: doublePrecision("duration_seconds"),
    deliveryFee: integer("delivery_fee").notNull(),
    zoneId: uuid("zone_id").notNull(),
    originLatitude: doublePrecision("origin_latitude").notNull(),
    originLongitude: doublePrecision("origin_longitude").notNull(),
    destinationLatitude: doublePrecision("destination_latitude").notNull(),
    destinationLongitude: doublePrecision("destination_longitude").notNull(),
    rawCalculation: jsonb("raw_calculation")
      .$type<{ numerator: string; denominator: string }>()
      .notNull(),
    calculatedAt: instant("calculated_at").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "order_delivery_pricing_snapshots_fee_chk",
      sql`${table.deliveryFee} >= 0`,
    ),
    check(
      "order_delivery_pricing_snapshots_distance_chk",
      sql`${table.distanceMeters} >= 0`,
    ),
  ],
);

export const orderCancellations = pgTable(
  "order_cancellations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    previousStatus: orderStatus("previous_status").notNull(),
    actorAccountId: uuid("actor_account_id")
      .notNull()
      .references(() => accounts.id),
    actorType: orderActorType("actor_type").notNull(),
    source: orderActionSource("source").notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_cancellations_order_uidx").on(table.orderId),
    check(
      "order_cancellations_reason_chk",
      sql`length(btrim(${table.reason})) > 0`,
    ),
  ],
);

export const orderIdempotencyKeys = pgTable(
  "order_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references(() => accounts.id),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_idempotency_customer_city_key_uidx").on(
      table.customerAccountId,
      table.cityId,
      table.idempotencyKey,
    ),
    check(
      "order_idempotency_key_nonempty_chk",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
  ],
);
