import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { cities } from "./geography";
import { orders } from "./orders";
import {
  assignmentClosingReason,
  assignmentLifecycleStatus,
  offerRoundKind,
} from "./enums";

export const offerRoundStatus = pgEnum("offer_round_status", [
  "OPEN",
  "CLAIMED",
  "MANUALLY_ASSIGNED",
  "STOPPED",
  "CANCELLED",
]);

export const assignmentSource = pgEnum("assignment_source", [
  "OFFER_CLAIM",
  "DASHBOARD_MANUAL",
]);

export const offerIdempotencyStatus = pgEnum("offer_idempotency_status", [
  "IN_PROGRESS",
  "COMPLETED",
]);

export type DriverPricingStage = {
  afterSeconds: number;
  increasePercentage: number;
};

export const cityDriverPricing = pgTable(
  "city_driver_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    version: integer("version").notNull(),
    pricingBase: integer("pricing_base").notNull(),
    roundingUnit: integer("rounding_unit").notNull(),
    pricingStages: jsonb("pricing_stages")
      .$type<DriverPricingStage[]>()
      .notNull(),
    updatedByAccountId: uuid("updated_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("city_driver_pricing_city_uidx").on(table.cityId),
    check("city_driver_pricing_base_chk", sql`${table.pricingBase} > 0`),
    check("city_driver_pricing_rounding_chk", sql`${table.roundingUnit} > 0`),
    check("city_driver_pricing_version_chk", sql`${table.version} > 0`),
    check(
      "city_driver_pricing_stages_chk",
      sql`jsonb_typeof(${table.pricingStages}) = 'array' and jsonb_array_length(${table.pricingStages}) >= 1`,
    ),
  ],
);

export const orderOfferRounds = pgTable(
  "order_offer_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    status: offerRoundStatus("status").notNull().default("OPEN"),
    roundKind: offerRoundKind("round_kind").notNull().default("INITIAL"),
    reofferReason: text("reoffer_reason"),
    openedByAccountId: uuid("opened_by_account_id").references(() => accounts.id),
    openedAt: instant("opened_at").notNull().defaultNow(),
    closedAt: instant("closed_at"),
    stoppedAt: instant("stopped_at"),
    stopReason: text("stop_reason"),
    pricingBaseSnapshot: integer("pricing_base_snapshot").notNull(),
    roundingUnitSnapshot: integer("rounding_unit_snapshot").notNull(),
    pricingStagesSnapshot: jsonb("pricing_stages_snapshot")
      .$type<DriverPricingStage[]>()
      .notNull(),
    pricingVersionSnapshot: integer("pricing_version_snapshot").notNull(),
    finalDriverFee: integer("final_driver_fee"),
    claimedByDriverId: uuid("claimed_by_driver_id").references(() => accounts.id),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_offer_rounds_one_open_uidx")
      .on(table.orderId)
      .where(sql`${table.status} = 'OPEN'`),
    index("order_offer_rounds_city_open_opened_idx")
      .on(table.cityId, table.openedAt, table.id)
      .where(sql`${table.status} = 'OPEN'`),
    index("order_offer_rounds_order_opened_idx").on(
      table.orderId,
      table.openedAt,
      table.id,
    ),
    foreignKey({
      name: "order_offer_rounds_order_city_fk",
      columns: [table.orderId, table.cityId],
      foreignColumns: [orders.id, orders.cityId],
    }),
    check(
      "order_offer_rounds_pricing_base_chk",
      sql`${table.pricingBaseSnapshot} > 0`,
    ),
    check(
      "order_offer_rounds_rounding_chk",
      sql`${table.roundingUnitSnapshot} > 0`,
    ),
    check(
      "order_offer_rounds_pricing_version_chk",
      sql`${table.pricingVersionSnapshot} > 0`,
    ),
    check(
      "order_offer_rounds_stages_chk",
      sql`jsonb_typeof(${table.pricingStagesSnapshot}) = 'array' and jsonb_array_length(${table.pricingStagesSnapshot}) >= 1`,
    ),
    check(
      "order_offer_rounds_fee_chk",
      sql`${table.finalDriverFee} is null or ${table.finalDriverFee} > 0`,
    ),
    check(
      "order_offer_rounds_status_fields_chk",
      sql`(
        (${table.status} = 'OPEN' and ${table.closedAt} is null and ${table.stoppedAt} is null and ${table.finalDriverFee} is null and ${table.claimedByDriverId} is null)
        or (${table.status} = 'STOPPED' and ${table.stoppedAt} is not null and ${table.finalDriverFee} is null and ${table.claimedByDriverId} is null)
        or (${table.status} = 'CLAIMED' and ${table.closedAt} is not null and ${table.finalDriverFee} is not null and ${table.claimedByDriverId} is not null)
        or (${table.status} = 'MANUALLY_ASSIGNED' and ${table.closedAt} is not null and ${table.finalDriverFee} is not null and ${table.claimedByDriverId} is not null)
        or (${table.status} = 'CANCELLED' and ${table.closedAt} is not null and ${table.finalDriverFee} is null)
      )`,
    ),
  ],
);

export const orderDriverAssignments = pgTable(
  "order_driver_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => accounts.id),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    offerRoundId: uuid("offer_round_id").references(() => orderOfferRounds.id),
    assignmentSource: assignmentSource("assignment_source").notNull(),
    status: assignmentLifecycleStatus("status").notNull().default("ASSIGNED"),
    assignmentSequence: integer("assignment_sequence").notNull(),
    assignedByAccountId: uuid("assigned_by_account_id").references(
      () => accounts.id,
    ),
    assignmentReason: text("assignment_reason"),
    driverFee: integer("driver_fee").notNull(),
    originalDriverFee: integer("original_driver_fee"),
    feeLockedFromAssignmentId: uuid("fee_locked_from_assignment_id"),
    replacesAssignmentId: uuid("replaces_assignment_id"),
    replacedByAssignmentId: uuid("replaced_by_assignment_id"),
    closingReason: assignmentClosingReason("closing_reason"),
    pricingBaseSnapshot: integer("pricing_base_snapshot"),
    roundingUnitSnapshot: integer("rounding_unit_snapshot"),
    pricingStagesSnapshot: jsonb("pricing_stages_snapshot").$type<
      DriverPricingStage[]
    >(),
    pricingVersionSnapshot: integer("pricing_version_snapshot"),
    pricingStageAfterSeconds: integer("pricing_stage_after_seconds"),
    pricingStageIncreasePercentage: integer(
      "pricing_stage_increase_percentage",
    ),
    assignedAt: instant("assigned_at").notNull().defaultNow(),
    pickedUpAt: instant("picked_up_at"),
    arrivedAtCustomerAt: instant("arrived_at_customer_at"),
    completedAt: instant("completed_at"),
    cancelledAt: instant("cancelled_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_driver_assignments_custody_active_uidx")
      .on(table.orderId)
      .where(
        sql`${table.completedAt} is null and ${table.cancelledAt} is null and ${table.status} in ('ASSIGNED','PICKED_UP','ARRIVED_AT_CUSTOMER','RETURN_PENDING')`,
      ),
    uniqueIndex("order_driver_assignments_handoff_pending_uidx")
      .on(table.orderId)
      .where(
        sql`${table.completedAt} is null and ${table.cancelledAt} is null and ${table.status} = 'HANDOFF_PENDING'`,
      ),
    index("order_driver_assignments_driver_active_idx")
      .on(table.driverId, table.assignmentSequence, table.assignedAt)
      .where(sql`${table.completedAt} is null and ${table.cancelledAt} is null`),
    index("order_driver_assignments_city_assigned_idx").on(
      table.cityId,
      table.assignedAt,
    ),
    foreignKey({
      name: "order_driver_assignments_order_city_fk",
      columns: [table.orderId, table.cityId],
      foreignColumns: [orders.id, orders.cityId],
    }),
    check(
      "order_driver_assignments_sequence_chk",
      sql`${table.assignmentSequence} between 1 and 2`,
    ),
    check("order_driver_assignments_fee_chk", sql`${table.driverFee} > 0`),
    check(
      "order_driver_assignments_terminal_chk",
      sql`not (${table.completedAt} is not null and ${table.cancelledAt} is not null)`,
    ),
    check(
      "order_driver_assignments_status_times_chk",
      sql`${table.cancelledAt} is not null or (
        (${table.status} = 'ASSIGNED' and ${table.pickedUpAt} is null and ${table.arrivedAtCustomerAt} is null and ${table.completedAt} is null)
        or (${table.status} = 'PICKED_UP' and ${table.pickedUpAt} is not null and ${table.arrivedAtCustomerAt} is null and ${table.completedAt} is null)
        or (${table.status} = 'ARRIVED_AT_CUSTOMER' and ${table.pickedUpAt} is not null and ${table.arrivedAtCustomerAt} is not null and ${table.completedAt} is null)
        or (${table.status} = 'COMPLETED' and ${table.pickedUpAt} is not null and ${table.arrivedAtCustomerAt} is not null and ${table.completedAt} is not null)
        or (${table.status} = 'HANDOFF_PENDING' and ${table.pickedUpAt} is null and ${table.arrivedAtCustomerAt} is null and ${table.completedAt} is null)
        or (${table.status} = 'RETURN_PENDING' and ${table.pickedUpAt} is not null and ${table.completedAt} is null)
        or (${table.status} in ('REMOVED_BEFORE_PICKUP','REPLACED_AFTER_PICKUP','RETURNED_TO_STORE','CANCELLED'))
      )`,
    ),
    check(
      "order_driver_assignments_pricing_source_chk",
      sql`(
        ${table.offerRoundId} is not null
        or (
          ${table.pricingBaseSnapshot} is not null
          and ${table.pricingBaseSnapshot} > 0
          and ${table.roundingUnitSnapshot} is not null
          and ${table.roundingUnitSnapshot} > 0
          and ${table.pricingStagesSnapshot} is not null
          and jsonb_typeof(${table.pricingStagesSnapshot}) = 'array'
          and jsonb_array_length(${table.pricingStagesSnapshot}) >= 1
          and ${table.pricingVersionSnapshot} is not null
          and ${table.pricingVersionSnapshot} > 0
          and ${table.pricingStageAfterSeconds} is not null
          and ${table.pricingStageAfterSeconds} >= 0
          and ${table.pricingStageIncreasePercentage} is not null
          and ${table.pricingStageIncreasePercentage} >= 0
        )
      )`,
    ),
  ],
);

export const offerIdempotencyKeys = pgTable(
  "offer_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    actorAccountId: uuid("actor_account_id")
      .notNull()
      .references(() => accounts.id),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: offerIdempotencyStatus("status").notNull().default("IN_PROGRESS"),
    httpStatus: integer("http_status"),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
    expiresAt: instant("expires_at"),
  },
  (table) => [
    uniqueIndex("offer_idempotency_scope_actor_city_key_uidx").on(
      table.scope,
      table.actorAccountId,
      table.cityId,
      table.idempotencyKey,
    ),
    check(
      "offer_idempotency_key_nonempty_chk",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check(
      "offer_idempotency_status_chk",
      sql`(
        (${table.status} = 'IN_PROGRESS' and ${table.responsePayload} is null and ${table.httpStatus} is null and ${table.completedAt} is null)
        or (${table.status} = 'COMPLETED' and ${table.responsePayload} is not null and ${table.httpStatus} is not null and ${table.completedAt} is not null)
      )`,
    ),
  ],
);

export const redisReconciliationJobType = pgEnum("redis_reconciliation_job_type", [
  "DRIVER_RUNTIME",
  "CITY_OPEN_OFFERS",
]);

export const redisReconciliationJobStatus = pgEnum(
  "redis_reconciliation_job_status",
  ["PENDING", "PROCESSING", "COMPLETED", "DEAD"],
);

/** Monotonic per-driver revision for Redis runtime CAS / stale job suppression. */
export const driverRuntimeRevisions = pgTable("driver_runtime_revisions", {
  driverId: uuid("driver_id")
    .primaryKey()
    .references(() => accounts.id),
  revision: integer("revision").notNull().default(0),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

/**
 * Monotonic per-city revision for CITY_OPEN_OFFERS coalescing / lost-wakeup prevention.
 * Enqueue always bumps; workers must not COMPLETE while target_revision advances mid-flight.
 */
export const cityOpenOfferRevisions = pgTable("city_open_offer_revisions", {
  cityId: uuid("city_id")
    .primaryKey()
    .references(() => cities.id),
  revision: integer("revision").notNull().default(0),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

/**
 * Durable Redis reconciliation outbox for M4-B post-commit failures.
 * Retention: COMPLETED/DEAD rows older than REDIS_RECON_RETENTION_DAYS may be deleted by the worker.
 */
export const redisReconciliationJobs = pgTable(
  "redis_reconciliation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: redisReconciliationJobType("job_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    cityId: uuid("city_id").references(() => cities.id),
    expectedRevision: integer("expected_revision"),
    status: redisReconciliationJobStatus("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    lockedAt: instant("locked_at"),
    lockedBy: text("locked_by"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
  },
  (table) => [
    index("redis_recon_jobs_due_idx")
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} in ('PENDING', 'PROCESSING')`),
    index("redis_recon_jobs_expired_lease_idx")
      .on(table.status, table.lockedAt)
      .where(sql`${table.status} = 'PROCESSING'`),
    uniqueIndex("redis_recon_jobs_driver_revision_uidx")
      .on(table.jobType, table.resourceId, table.expectedRevision)
      .where(sql`${table.jobType} = 'DRIVER_RUNTIME'`),
    uniqueIndex("redis_recon_jobs_city_open_active_uidx")
      .on(table.jobType, table.resourceId)
      .where(
        sql`${table.jobType} = 'CITY_OPEN_OFFERS' and ${table.status} in ('PENDING', 'PROCESSING')`,
      ),
    check(
      "redis_recon_jobs_attempt_chk",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "redis_recon_jobs_driver_rev_chk",
      sql`(
        (${table.jobType} = 'DRIVER_RUNTIME' and ${table.expectedRevision} is not null and ${table.expectedRevision} > 0)
        or (${table.jobType} = 'CITY_OPEN_OFFERS' and ${table.expectedRevision} is not null and ${table.expectedRevision} > 0 and ${table.cityId} is not null)
      )`,
    ),
    check(
      "redis_recon_jobs_status_dates_chk",
      sql`(
        (${table.status} in ('PENDING', 'PROCESSING') and ${table.completedAt} is null)
        or (${table.status} in ('COMPLETED', 'DEAD') and ${table.completedAt} is not null)
      )`,
    ),
  ],
);
