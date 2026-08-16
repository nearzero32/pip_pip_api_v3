import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireTrustedDriverCity } from "../auth/mobile/driver/driver-scope";
import { requireTrustedMerchantStore } from "../auth/merchant/merchant-access";
import { requireCityPermission } from "../auth/staff/authorization";
import type {
  DriverRuntimeStoreLike,
  DriverWorkStatus,
} from "../driver-offers/driver-runtime";
import type { DriverPricingStage } from "../../db/schema/driver-offers";
import {
  applyRedisAfterCommit,
  bumpDriverRuntimeRevision,
  enqueueCityOpenOffersRecon,
  enqueueDriverRuntimeRecon,
} from "../driver-offers/redis-reconciliation";
import { dateValue, pageOf } from "../geography/shared";
import type { MediaService } from "../media/media.service";
import {
  abortOrderCommandIdempotency,
  beginOrderCommandIdempotency,
  completeOrderCommandIdempotency,
  hashOrderCommandPayload,
  ORDER_COMMAND_SCOPES,
  requireOrderIdempotencyKey,
} from "./order-command-idempotency";
import {
  insertCustodyHistory,
  insertOrderEvent,
  type OrderActor,
} from "./order-events";
import type { OrderService } from "./order.service";
import { type OrderStatus } from "./order-state-machine";

type LockedOrder = {
  id: string;
  city_id: string;
  store_id: string;
  status: OrderStatus;
  version: number;
  custody_status: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER";
  custody_driver_id: string | null;
  driver_account_id: string | null;
  locked_driver_fee: number | null;
  store_ready_marked_at: Date | string | null;
  cancelled_at: Date | string | null;
};

type AssignmentRow = {
  id: string;
  driver_id: string;
  city_id: string;
  status: string;
  driver_fee: number;
  assignment_sequence: number;
  picked_up_at: Date | string | null;
  arrived_at_customer_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  offer_round_id: string | null;
  pricing_base_snapshot: number | null;
  rounding_unit_snapshot: number | null;
  pricing_stages_snapshot: DriverPricingStage | DriverPricingStage[] | null;
  pricing_version_snapshot: number | null;
  pricing_stage_after_seconds: number | null;
  pricing_stage_increase_percentage: number | null;
};

type RedisSideEffect = {
  jobIds: string[];
  cityId: string;
  closedOfferIds: string[];
  cityRevision: number | null;
  drivers: Array<{
    driverId: string;
    revision: number;
    activeOrderCount: number;
  }>;
};

const reasonOf = (value: unknown): string => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason || reason.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", "Invalid reason");
  return reason;
};

const noteOf = (value: unknown): string | null => {
  if (value == null || value === undefined) return null;
  const note = String(value).trim();
  if (!note) return null;
  if (note.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", "Invalid note");
  return note;
};

const parseStages = (
  value: DriverPricingStage | DriverPricingStage[] | null | unknown,
): DriverPricingStage[] | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return parseStages(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? (value as DriverPricingStage[]) : null;
};

export class OrderOpsService {
  constructor(
    private client: SQL,
    private orders: OrderService,
    private media: MediaService,
    private runtime: DriverRuntimeStoreLike | null = null,
    private logger: Logger | null = null,
  ) {}

  private staffActor(
    identity: AuthIdentity,
    reason: string,
    source: "DASHBOARD" | "DASHBOARD_OVERRIDE" = "DASHBOARD",
  ): OrderActor {
    return {
      accountId: identity.accountId,
      actorType: "STAFF",
      source,
      reason,
    };
  }

  private async lockOrder(
    tx: SQL,
    orderId: string,
    cityId: string,
  ): Promise<LockedOrder> {
    const [order] = await tx<LockedOrder[]>`
      select id::text, city_id::text, store_id::text, status::text, version,
             custody_status::text, custody_driver_id::text,
             driver_account_id::text, locked_driver_fee,
             store_ready_marked_at, cancelled_at
      from orders where id = ${orderId} and city_id = ${cityId} for update`;
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return order;
  }

  private async lockDriverIds(tx: SQL, driverIds: string[]) {
    for (const driverId of [...new Set(driverIds)].sort()) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`driver-assign:${driverId}`}, 0))`;
      await tx`
        select account_id from driver_profiles
        where account_id = ${driverId} for update`;
    }
  }

  private async custodyAssignment(
    tx: SQL,
    orderId: string,
    cityId: string,
  ): Promise<AssignmentRow> {
    const [assignment] = await tx<AssignmentRow[]>`
      select id::text, driver_id::text, city_id::text, status::text,
             driver_fee, assignment_sequence, picked_up_at, arrived_at_customer_at,
             completed_at, cancelled_at, offer_round_id::text,
             pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
             pricing_version_snapshot, pricing_stage_after_seconds,
             pricing_stage_increase_percentage
      from order_driver_assignments
      where order_id = ${orderId} and city_id = ${cityId}
        and completed_at is null and cancelled_at is null
        and status in ('ASSIGNED','ARRIVED_AT_STORE','PICKED_UP','ARRIVED_AT_CUSTOMER','RETURN_PENDING')
      for update`;
    if (!assignment)
      throw new AppError(
        409,
        "DRIVER_ASSIGNMENT_REQUIRED",
        "An active driver assignment is required",
      );
    return assignment;
  }

  private async lockAssignmentsForOrder(tx: SQL, orderId: string) {
    return tx<AssignmentRow[]>`
      select id::text, driver_id::text, city_id::text, status::text,
             driver_fee, assignment_sequence, picked_up_at, arrived_at_customer_at,
             completed_at, cancelled_at, offer_round_id::text,
             pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
             pricing_version_snapshot, pricing_stage_after_seconds,
             pricing_stage_increase_percentage
      from order_driver_assignments
      where order_id = ${orderId}
        and completed_at is null and cancelled_at is null
      for update`;
  }

  private async assertEligibleDriver(
    tx: SQL,
    driverId: string,
    cityId: string,
    capacityMax: number,
  ) {
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
      throw new AppError(403, "DRIVER_NOT_ELIGIBLE", "Driver is not eligible");
    }
    if (!driver.city_id || driver.city_id !== cityId)
      throw new AppError(404, "CITY_MISMATCH", "Driver city mismatch");
    const [activeCount] = await tx<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId}
        and completed_at is null and cancelled_at is null`;
    const count = activeCount?.count ?? 0;
    if (count >= capacityMax)
      throw new AppError(
        409,
        "DRIVER_ACTIVE_ASSIGNMENT_LIMIT_REACHED",
        "Driver assignment capacity reached",
      );
    return count + 1;
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
    return pricing;
  }

  private resolveLockedFee(
    order: LockedOrder,
    assignment: { driver_fee: number },
  ): number {
    const locked = order.locked_driver_fee ?? assignment.driver_fee;
    if (!locked || locked <= 0)
      throw new AppError(
        409,
        "ORDER_INVALID_STATE",
        "Locked driver fee is required",
      );
    return locked;
  }

  private async openLockedOfferRound(
    tx: SQL,
    input: {
      orderId: string;
      cityId: string;
      actorAccountId: string;
      roundKind: "INITIAL" | "DRIVER_REPLACEMENT";
      reofferReason: string;
      lockedFee: number;
      now: Date;
    },
  ) {
    const [open] = await tx<{ id: string }[]>`
      select id::text from order_offer_rounds
      where order_id = ${input.orderId} and status = 'OPEN' for update`;
    if (open)
      throw new AppError(
        409,
        "OFFER_ROUND_ALREADY_OPEN",
        "An open offer round already exists",
      );
    const pricing = await this.loadCityPricing(tx, input.cityId);
    // Snapshot city pricing for schema; claim uses orders.locked_driver_fee.
    const [round] = await tx<{ id: string }[]>`
      insert into order_offer_rounds (
        order_id, city_id, status, round_kind, reoffer_reason,
        opened_by_account_id, pricing_base_snapshot, rounding_unit_snapshot,
        pricing_stages_snapshot, pricing_version_snapshot, created_by_account_id
      ) values (
        ${input.orderId}, ${input.cityId}, 'OPEN', ${input.roundKind},
        ${input.reofferReason}, ${input.actorAccountId}, ${input.lockedFee},
        ${pricing.rounding_unit}, ${pricing.pricing_stages}, ${pricing.version},
        ${input.actorAccountId}
      ) returning id::text`;
    return round!.id;
  }

  private async insertManualAssignment(
    tx: SQL,
    input: {
      orderId: string;
      cityId: string;
      driverId: string;
      sequence: number;
      assignedBy: string;
      reason: string;
      driverFee: number;
      originalDriverFee: number;
      feeLockedFromAssignmentId: string;
      replacesAssignmentId: string;
      status: "ASSIGNED" | "HANDOFF_PENDING";
      now: Date;
      previous: AssignmentRow;
    },
  ) {
    const stages =
      parseStages(input.previous.pricing_stages_snapshot) ??
      (
        await this.loadCityPricing(tx, input.cityId)
      ).pricing_stages;
    const pricingBase =
      input.previous.pricing_base_snapshot ?? input.originalDriverFee;
    const roundingUnit = input.previous.rounding_unit_snapshot ?? 250;
    const pricingVersion = input.previous.pricing_version_snapshot ?? 1;
    const stageAfter = input.previous.pricing_stage_after_seconds ?? 0;
    const stagePct = input.previous.pricing_stage_increase_percentage ?? 0;
    const [row] = await tx<{ id: string }[]>`
      insert into order_driver_assignments (
        order_id, driver_id, city_id, assignment_source, status,
        assignment_sequence, assigned_by_account_id, assignment_reason,
        driver_fee, original_driver_fee, fee_locked_from_assignment_id,
        replaces_assignment_id, assigned_at,
        pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
        pricing_version_snapshot, pricing_stage_after_seconds,
        pricing_stage_increase_percentage
      ) values (
        ${input.orderId}, ${input.driverId}, ${input.cityId}, 'DASHBOARD_MANUAL',
        ${input.status}, ${input.sequence}, ${input.assignedBy}, ${input.reason},
        ${input.driverFee}, ${input.originalDriverFee},
        ${input.feeLockedFromAssignmentId}, ${input.replacesAssignmentId},
        ${input.now}, ${pricingBase}, ${roundingUnit}, ${stages},
        ${pricingVersion}, ${stageAfter}, ${stagePct}
      ) returning id::text`;
    await tx`
      update order_driver_assignments
      set replaced_by_assignment_id = ${row!.id}, updated_at = ${input.now}
      where id = ${input.replacesAssignmentId}`;
    return row!.id;
  }

  private emptyEffect(cityId: string): RedisSideEffect {
    return {
      jobIds: [],
      cityId,
      closedOfferIds: [],
      cityRevision: null,
      drivers: [],
    };
  }

  private async trackDriver(
    tx: SQL,
    effect: RedisSideEffect,
    driverId: string,
    cityId: string,
  ) {
    const revision = await bumpDriverRuntimeRevision(tx, driverId);
    const jobId = await enqueueDriverRuntimeRecon(tx, {
      driverId,
      expectedRevision: revision,
      cityId,
    });
    const [count] = await tx<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId}
        and completed_at is null and cancelled_at is null`;
    effect.jobIds.push(jobId);
    effect.drivers.push({
      driverId,
      revision,
      activeOrderCount: count?.count ?? 0,
    });
  }

  private async applyRuntime(effect: RedisSideEffect) {
    if (!this.runtime) return;
    if (effect.jobIds.length === 0 && effect.closedOfferIds.length === 0) return;
    await applyRedisAfterCommit({
      client: this.client,
      jobIds: effect.jobIds,
      ...(this.logger ? { logger: this.logger } : {}),
      event: "order_ops_redis_apply_failed",
      apply: async () => {
        if (effect.cityRevision != null) {
          for (const offerId of effect.closedOfferIds) {
            await this.runtime!.removeOpenOfferWithCas(
              effect.cityId,
              offerId,
              effect.cityRevision,
            );
          }
        }
        for (const driver of effect.drivers) {
          const current = await this.runtime!.getRuntime(driver.driverId);
          const workStatus: DriverWorkStatus =
            driver.activeOrderCount > 0 ? "BUSY" : "AVAILABLE";
          await this.runtime!.setRuntime({
            driverId: driver.driverId,
            cityId: effect.cityId,
            eligibilityStatus: current?.eligibilityStatus ?? "ELIGIBLE",
            workStatus,
            activeOrderCount: driver.activeOrderCount,
            eligibilityVersion: current?.eligibilityVersion ?? 1,
            revision: driver.revision,
            updatedAt: new Date().toISOString(),
          });
        }
      },
    });
  }

  private mapOpsHandoff(row: Record<string, unknown> | undefined) {
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      fromAssignmentId: String(row.from_assignment_id),
      toAssignmentId: String(row.to_assignment_id),
      fromDriverId: String(row.from_driver_id),
      toDriverId: String(row.to_driver_id),
      reason: String(row.reason),
      startedAt: dateValue(row.started_at),
      completedAt: dateValue(row.completed_at),
      cancelledAt: dateValue(row.cancelled_at),
    };
  }

  private mapOpsReturn(row: Record<string, unknown> | undefined) {
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      assignmentId: String(row.assignment_id),
      driverId: String(row.driver_id),
      reason: String(row.reason),
      startedAt: dateValue(row.started_at),
      driverReturnedAt: dateValue(row.driver_returned_at),
      storeConfirmedAt: dateValue(row.store_confirmed_at),
      completedAt: dateValue(row.completed_at),
      cancelledAt: dateValue(row.cancelled_at),
    };
  }

  private async loadDashboardOpsState(
    executor: SQL,
    cityId: string,
    orderId: string,
  ) {
    const [row] = await executor<Record<string, unknown>[]>`
      select id::text, order_number, status::text, custody_status::text,
             custody_driver_id::text, driver_account_id::text, locked_driver_fee,
             store_ready_marked_at, version, status_changed_at, cancelled_at
      from orders where id = ${orderId} and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const assignments = await executor<Record<string, unknown>[]>`
      select id::text, driver_id::text, status::text, assignment_source::text,
             assignment_reason, driver_fee, assignment_sequence,
             offer_round_id::text, assigned_at, arrived_at_store_at, picked_up_at,
             arrived_at_customer_at, completed_at, cancelled_at
      from order_driver_assignments
      where order_id = ${orderId} and city_id = ${cityId}
      order by assigned_at desc, id desc`;
    const [pendingHandoff] = await executor<Record<string, unknown>[]>`
      select id::text, status::text, from_assignment_id::text, to_assignment_id::text,
             from_driver_id::text, to_driver_id::text, reason, started_at,
             completed_at, cancelled_at
      from order_driver_handoffs
      where order_id = ${orderId} and city_id = ${cityId} and status = 'PENDING'
      order by started_at desc limit 1`;
    const [latestHandoff] = pendingHandoff
      ? [pendingHandoff]
      : await executor<Record<string, unknown>[]>`
          select id::text, status::text, from_assignment_id::text, to_assignment_id::text,
                 from_driver_id::text, to_driver_id::text, reason, started_at,
                 completed_at, cancelled_at
          from order_driver_handoffs
          where order_id = ${orderId} and city_id = ${cityId}
          order by started_at desc limit 1`;
    const [activeReturn] = await executor<Record<string, unknown>[]>`
      select id::text, status::text, assignment_id::text, driver_id::text, reason,
             started_at, driver_returned_at, store_confirmed_at, completed_at, cancelled_at
      from order_return_workflows
      where order_id = ${orderId} and city_id = ${cityId}
        and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
      order by started_at desc limit 1`;
    const [latestReturn] = activeReturn
      ? [activeReturn]
      : await executor<Record<string, unknown>[]>`
          select id::text, status::text, assignment_id::text, driver_id::text, reason,
                 started_at, driver_returned_at, store_confirmed_at, completed_at, cancelled_at
          from order_return_workflows
          where order_id = ${orderId} and city_id = ${cityId}
          order by started_at desc limit 1`;
    const [openRound] = await executor<Record<string, unknown>[]>`
      select id::text, status::text, round_kind::text, opened_at,
             pricing_version_snapshot, final_driver_fee
      from order_offer_rounds
      where order_id = ${orderId} and city_id = ${cityId} and status = 'OPEN'
      limit 1`;
    return {
      orderId: String(row.id),
      orderNumber: String(row.order_number),
      status: String(row.status),
      custodyStatus: String(row.custody_status),
      custodyDriverId: row.custody_driver_id == null ? null : String(row.custody_driver_id),
      driverAccountId:
        row.driver_account_id == null ? null : String(row.driver_account_id),
      lockedDriverFee:
        row.locked_driver_fee == null ? null : Number(row.locked_driver_fee),
      storeReadyMarkedAt: dateValue(row.store_ready_marked_at),
      version: Number(row.version),
      statusChangedAt: dateValue(row.status_changed_at),
      cancelledAt: dateValue(row.cancelled_at),
      assignments: assignments.map((a) => ({
        id: String(a.id),
        driverId: String(a.driver_id),
        status: String(a.status),
        assignmentSource: a.assignment_source == null ? null : String(a.assignment_source),
        assignmentSequence: Number(a.assignment_sequence),
        assignmentReason: a.assignment_reason == null ? null : String(a.assignment_reason),
        driverFee: Number(a.driver_fee),
        offerRoundId: a.offer_round_id == null ? null : String(a.offer_round_id),
        assignedAt: dateValue(a.assigned_at),
        arrivedAtStoreAt: dateValue(a.arrived_at_store_at),
        pickedUpAt: dateValue(a.picked_up_at),
        arrivedAtCustomerAt: dateValue(a.arrived_at_customer_at),
        completedAt: dateValue(a.completed_at),
        cancelledAt: dateValue(a.cancelled_at),
      })),
      handoff: this.mapOpsHandoff(latestHandoff),
      returnWorkflow: this.mapOpsReturn(latestReturn),
      openOfferRound: openRound
        ? {
            id: String(openRound.id),
            status: String(openRound.status),
            roundKind: String(openRound.round_kind),
            openedAt: dateValue(openRound.opened_at),
            pricingVersionSnapshot: Number(openRound.pricing_version_snapshot),
            finalDriverFee:
              openRound.final_driver_fee == null
                ? null
                : Number(openRound.final_driver_fee),
          }
        : null,
    };
  }

  async getDashboardOps(identity: AuthIdentity, orderId: string) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    return this.loadDashboardOpsState(this.client, cityId, orderId);
  }

  private async orderResponse(tx: SQL, orderId: string, cityId: string) {
    const [row] = await tx<Record<string, unknown>[]>`
      select id::text, order_number, city_id::text, store_id::text, status::text,
             custody_status::text, custody_driver_id::text, driver_account_id::text,
             locked_driver_fee, store_ready_marked_at, version, cancelled_at,
             status_changed_at, updated_at
      from orders where id = ${orderId} and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const assignments = await tx<Record<string, unknown>[]>`
      select id::text, driver_id::text, status::text, assignment_source::text,
             driver_fee, assignment_sequence, replaces_assignment_id::text,
             replaced_by_assignment_id::text, closing_reason::text,
             assigned_at, arrived_at_store_at, picked_up_at, cancelled_at, completed_at
      from order_driver_assignments
      where order_id = ${orderId}
      order by assigned_at desc, id desc`;
    const [handoff] = await tx<Record<string, unknown>[]>`
      select id::text, status::text, from_assignment_id::text, to_assignment_id::text,
             from_driver_id::text, to_driver_id::text, reason, started_at,
             completed_at, cancelled_at
      from order_driver_handoffs
      where order_id = ${orderId}
      order by started_at desc limit 1`;
    const [ret] = await tx<Record<string, unknown>[]>`
      select id::text, status::text, assignment_id::text, driver_id::text, reason,
             started_at, driver_returned_at, store_confirmed_at, completed_at
      from order_return_workflows
      where order_id = ${orderId}
      order by started_at desc limit 1`;
    return {
      id: row.id,
      orderNumber: row.order_number,
      cityId: row.city_id,
      storeId: row.store_id,
      status: row.status,
      custodyStatus: row.custody_status,
      custodyDriverId: row.custody_driver_id,
      driverAccountId: row.driver_account_id,
      lockedDriverFee:
        row.locked_driver_fee == null ? null : Number(row.locked_driver_fee),
      storeReadyMarkedAt: dateValue(row.store_ready_marked_at),
      version: Number(row.version),
      cancelledAt: dateValue(row.cancelled_at),
      statusChangedAt: dateValue(row.status_changed_at),
      updatedAt: dateValue(row.updated_at),
      assignments: assignments.map((a) => ({
        id: a.id,
        driverId: a.driver_id,
        status: a.status,
        assignmentSource: a.assignment_source,
        driverFee: Number(a.driver_fee),
        assignmentSequence: Number(a.assignment_sequence),
        replacesAssignmentId: a.replaces_assignment_id,
        replacedByAssignmentId: a.replaced_by_assignment_id,
        closingReason: a.closing_reason,
        assignedAt: dateValue(a.assigned_at),
        arrivedAtStoreAt: dateValue(a.arrived_at_store_at),
        pickedUpAt: dateValue(a.picked_up_at),
        cancelledAt: dateValue(a.cancelled_at),
        completedAt: dateValue(a.completed_at),
      })),
      handoff: handoff
        ? {
            id: handoff.id,
            status: handoff.status,
            fromAssignmentId: handoff.from_assignment_id,
            toAssignmentId: handoff.to_assignment_id,
            fromDriverId: handoff.from_driver_id,
            toDriverId: handoff.to_driver_id,
            reason: handoff.reason,
            startedAt: dateValue(handoff.started_at),
            completedAt: dateValue(handoff.completed_at),
            cancelledAt: dateValue(handoff.cancelled_at),
          }
        : null,
      returnWorkflow: ret
        ? {
            id: ret.id,
            status: ret.status,
            assignmentId: ret.assignment_id,
            driverId: ret.driver_id,
            reason: ret.reason,
            startedAt: dateValue(ret.started_at),
            driverReturnedAt: dateValue(ret.driver_returned_at),
            storeConfirmedAt: dateValue(ret.store_confirmed_at),
            completedAt: dateValue(ret.completed_at),
          }
        : null,
    };
  }

  private async consumeProof(
    tx: SQL,
    input: {
      fileId: string | undefined;
      purpose: "HANDOFF_PROOF" | "RETURN_PROOF";
      orderId: string;
      cityId: string;
      assignmentId: string;
      driverId: string | null;
      handoffId?: string | null;
      returnWorkflowId?: string | null;
    },
  ): Promise<string> {
    if (!input.fileId)
      throw new AppError(422, "PROOF_REQUIRED", "Proof is required");
    const [proof] = await tx<{
      id: string;
      order_id: string;
      assignment_id: string;
      city_id: string;
      media_asset_id: string;
      purpose: string;
      uploaded_by_driver_id: string;
      consumed_at: Date | null;
      handoff_id: string | null;
      return_workflow_id: string | null;
    }[]>`
      select id::text, order_id::text, assignment_id::text, city_id::text,
             media_asset_id::text, purpose::text, uploaded_by_driver_id::text,
             consumed_at, handoff_id::text, return_workflow_id::text
      from order_proofs
      where id = ${input.fileId} or media_asset_id = ${input.fileId}
      for update`;
    if (!proof) throw new AppError(404, "PROOF_NOT_FOUND", "Proof not found");
    if (proof.purpose !== input.purpose)
      throw new AppError(
        409,
        "PROOF_PURPOSE_MISMATCH",
        "Proof purpose does not match",
      );
    if (proof.consumed_at)
      throw new AppError(409, "PROOF_ALREADY_USED", "Proof was already used");
    if (
      proof.order_id !== input.orderId ||
      proof.assignment_id !== input.assignmentId
    )
      throw new AppError(
        409,
        "PROOF_ASSIGNMENT_MISMATCH",
        "Proof assignment does not match",
      );
    if (
      proof.city_id !== input.cityId ||
      (input.driverId && proof.uploaded_by_driver_id !== input.driverId)
    )
      throw new AppError(404, "PROOF_NOT_FOUND", "Proof not found");
    if (input.handoffId && proof.handoff_id && proof.handoff_id !== input.handoffId)
      throw new AppError(409, "PROOF_ASSIGNMENT_MISMATCH", "Proof handoff mismatch");
    if (
      input.returnWorkflowId &&
      proof.return_workflow_id &&
      proof.return_workflow_id !== input.returnWorkflowId
    )
      throw new AppError(
        409,
        "PROOF_ASSIGNMENT_MISMATCH",
        "Proof return workflow mismatch",
      );
    await this.media.claimAsset(tx, {
      assetId: proof.media_asset_id,
      cityId: input.cityId,
      purpose: input.purpose,
      visibility: "PRIVATE",
    });
    return proof.id;
  }

  async removeDriverBeforePickup(
    identity: AuthIdentity,
    orderId: string,
    input: {
      reason: string;
      note?: string;
      nextAction: "REOFFER" | "ASSIGN_DRIVER";
      driverId?: string;
      idempotencyKey: string;
    },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.assign",
    );
    if (input.nextAction === "REOFFER")
      await requireCityPermission(this.client, identity, "orders.reoffer");
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "removeDriverBeforePickup",
      reason,
      note,
      nextAction: input.nextAction,
      driverId: input.driverId ?? null,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.removeDriver,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_STORE")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order custody must be with store",
          );
        if (
          order.status !== "DRIVER_ASSIGNED" &&
          order.status !== "READY_FOR_PICKUP" &&
          order.status !== "ARRIVED_AT_STORE"
        )
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not eligible for driver removal",
          );
        const assignments = await this.lockAssignmentsForOrder(tx, orderId);
        const current = assignments.find(
          (row) =>
            row.status === "ASSIGNED" || row.status === "ARRIVED_AT_STORE",
        );
        if (!current)
          throw new AppError(
            409,
            "DRIVER_ASSIGNMENT_REQUIRED",
            "An active driver assignment is required",
          );
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        const lockedFee = this.resolveLockedFee(order, current);
        const driverIds = [current.driver_id];
        if (input.nextAction === "ASSIGN_DRIVER") {
          if (!input.driverId)
            throw new AppError(422, "VALIDATION_FAILED", "driverId is required");
          driverIds.push(input.driverId);
        }
        await this.lockDriverIds(tx, driverIds);

        await tx`
          update order_driver_assignments
          set status = 'REMOVED_BEFORE_PICKUP',
              closing_reason = 'REMOVED_BEFORE_PICKUP',
              cancelled_at = ${now}, updated_at = ${now}
          where id = ${current.id}`;

        if (order.status === "READY_FOR_PICKUP" && !order.store_ready_marked_at) {
          await tx`
            update orders set store_ready_marked_at = ${now}, updated_at = ${now}
            where id = ${order.id}`;
          order.store_ready_marked_at = now;
        }

        await tx`
          update orders set locked_driver_fee = ${lockedFee}, updated_at = ${now}
          where id = ${order.id}`;
        order.locked_driver_fee = lockedFee;

        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: current.id,
          eventType: "DRIVER_REMOVED_BEFORE_PICKUP",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          metadata: { note, nextAction: input.nextAction },
          createdAt: now,
        });

        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, current.driver_id, cityId);

        if (input.nextAction === "REOFFER") {
          await this.orders.applyOpsStatusTransition(
            tx,
            order,
            "SEARCHING_DRIVER",
            actor,
            now,
          );
          const roundId = await this.openLockedOfferRound(tx, {
            orderId,
            cityId,
            actorAccountId: identity.accountId,
            roundKind: "INITIAL",
            reofferReason: reason,
            lockedFee,
            now,
          });
          await tx`
            update orders set driver_account_id = null, updated_at = ${now}
            where id = ${order.id}`;
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            eventType: "ORDER_REOFFERED",
            fromOrderStatus: order.status,
            toOrderStatus: "SEARCHING_DRIVER",
            metadata: { roundId, note },
            createdAt: now,
          });
          const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);
          effect.cityRevision = cityRecon.revision;
          effect.jobIds.push(cityRecon.jobId);
        } else {
          const sequence = await this.assertEligibleDriver(
            tx,
            input.driverId!,
            cityId,
            2,
          );
          const newAssignmentId = await this.insertManualAssignment(tx, {
            orderId,
            cityId,
            driverId: input.driverId!,
            sequence,
            assignedBy: identity.accountId,
            reason,
            driverFee: lockedFee,
            originalDriverFee: lockedFee,
            feeLockedFromAssignmentId: current.id,
            replacesAssignmentId: current.id,
            status: "ASSIGNED",
            now,
            previous: current,
          });
          const readyAt =
            order.store_ready_marked_at || order.status === "READY_FOR_PICKUP";
          const nextStatus: OrderStatus = readyAt
            ? "READY_FOR_PICKUP"
            : "DRIVER_ASSIGNED";
          if (order.status !== nextStatus) {
            await this.orders.applyOpsStatusTransition(
              tx,
              order,
              nextStatus,
              actor,
              now,
            );
          } else {
            await tx`
              update orders set driver_account_id = ${input.driverId!}, updated_at = ${now}
              where id = ${order.id}`;
          }
          if (order.status === nextStatus) {
            /* driver already set below */
          }
          await tx`
            update orders set driver_account_id = ${input.driverId!}, updated_at = ${now}
            where id = ${order.id}`;
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            assignmentId: newAssignmentId,
            eventType: "DRIVER_MANUALLY_ASSIGNED",
            fromOrderStatus: order.status,
            toOrderStatus: nextStatus,
            metadata: { note, replacesAssignmentId: current.id },
            createdAt: now,
          });
          await this.trackDriver(tx, effect, input.driverId!, cityId);
        }

        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.removeDriver,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async startHandoffAssign(
    identity: AuthIdentity,
    orderId: string,
    input: {
      driverId: string;
      reason: string;
      note?: string;
      idempotencyKey: string;
    },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    await requireCityPermission(this.client, identity, "orders.handoff.manage");
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.assign",
    );
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "startHandoffAssign",
      driverId: input.driverId,
      reason,
      note,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.startHandoff,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_DRIVER")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order custody must be with driver",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const from = await this.custodyAssignment(tx, orderId, cityId);
        if (
          from.status !== "PICKED_UP" &&
          from.status !== "ARRIVED_AT_CUSTOMER"
        )
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Handoff requires post-pickup assignment",
          );
        const [pending] = await tx<{ id: string }[]>`
          select id::text from order_driver_handoffs
          where order_id = ${orderId} and status = 'PENDING' for update`;
        if (pending)
          throw new AppError(
            409,
            "HANDOFF_ALREADY_PENDING",
            "A handoff is already pending",
          );
        if (input.driverId === from.driver_id)
          throw new AppError(
            422,
            "VALIDATION_FAILED",
            "Replacement driver must differ",
          );
        await this.lockDriverIds(tx, [from.driver_id, input.driverId]);
        const sequence = await this.assertEligibleDriver(
          tx,
          input.driverId,
          cityId,
          2,
        );
        const lockedFee = this.resolveLockedFee(order, from);
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        await tx`
          update orders set locked_driver_fee = ${lockedFee}, updated_at = ${now}
          where id = ${order.id}`;
        const toAssignmentId = await this.insertManualAssignment(tx, {
          orderId,
          cityId,
          driverId: input.driverId,
          sequence,
          assignedBy: identity.accountId,
          reason,
          driverFee: lockedFee,
          originalDriverFee: lockedFee,
          feeLockedFromAssignmentId: from.id,
          replacesAssignmentId: from.id,
          status: "HANDOFF_PENDING",
          now,
          previous: from,
        });
        const [handoff] = await tx<{ id: string }[]>`
          insert into order_driver_handoffs (
            order_id, city_id, from_assignment_id, to_assignment_id,
            from_driver_id, to_driver_id, status, reason, started_by_account_id,
            started_at
          ) values (
            ${orderId}, ${cityId}, ${from.id}, ${toAssignmentId},
            ${from.driver_id}, ${input.driverId}, 'PENDING', ${reason},
            ${identity.accountId}, ${now}
          ) returning id::text`;
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: toAssignmentId,
          handoffId: handoff!.id,
          eventType: "HANDOFF_STARTED",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          metadata: { note },
          createdAt: now,
        });
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: toAssignmentId,
          handoffId: handoff!.id,
          eventType: "DRIVER_MANUALLY_ASSIGNED",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          metadata: { note, handoffPending: true },
          createdAt: now,
        });
        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, input.driverId, cityId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.startHandoff,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async reofferAfterPickup(
    identity: AuthIdentity,
    orderId: string,
    input: { reason: string; note?: string; idempotencyKey: string },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    await requireCityPermission(this.client, identity, "orders.reoffer");
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.handoff.manage",
    );
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "reofferAfterPickup",
      reason,
      note,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.reoffer,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_DRIVER")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order custody must be with driver",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const from = await this.custodyAssignment(tx, orderId, cityId);
        const [pending] = await tx<{ id: string }[]>`
          select id::text from order_driver_handoffs
          where order_id = ${orderId} and status = 'PENDING' for update`;
        if (pending)
          throw new AppError(
            409,
            "HANDOFF_ALREADY_PENDING",
            "A handoff is already pending",
          );
        await this.lockDriverIds(tx, [from.driver_id]);
        const lockedFee = this.resolveLockedFee(order, from);
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        await tx`
          update orders set locked_driver_fee = ${lockedFee}, updated_at = ${now}
          where id = ${order.id}`;
        const roundId = await this.openLockedOfferRound(tx, {
          orderId,
          cityId,
          actorAccountId: identity.accountId,
          roundKind: "DRIVER_REPLACEMENT",
          reofferReason: reason,
          lockedFee,
          now,
        });
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: from.id,
          eventType: "ORDER_REOFFERED",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          metadata: { note, roundId, roundKind: "DRIVER_REPLACEMENT" },
          createdAt: now,
        });
        const effect = this.emptyEffect(cityId);
        const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);
        effect.cityRevision = cityRecon.revision;
        effect.jobIds.push(cityRecon.jobId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.reoffer,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async cancelHandoff(
    identity: AuthIdentity,
    orderId: string,
    handoffId: string,
    input: { reason: string; note?: string; idempotencyKey: string },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.handoff.manage",
    );
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      handoffId,
      action: "cancelHandoff",
      reason,
      note,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.cancelHandoff,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        await this.lockAssignmentsForOrder(tx, orderId);
        const [handoff] = await tx<
          {
            id: string;
            status: string;
            to_assignment_id: string;
            to_driver_id: string;
            from_driver_id: string;
          }[]
        >`select id::text, status::text, to_assignment_id::text,
                 to_driver_id::text, from_driver_id::text
          from order_driver_handoffs
          where id = ${handoffId} and order_id = ${orderId} and city_id = ${cityId}
          for update`;
        if (!handoff) throw new AppError(404, "HANDOFF_NOT_FOUND", "Handoff not found");
        if (handoff.status !== "PENDING")
          throw new AppError(
            409,
            "HANDOFF_NOT_PENDING",
            "Handoff is not pending",
          );
        await this.lockDriverIds(tx, [
          handoff.from_driver_id,
          handoff.to_driver_id,
        ]);
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        await tx`
          update order_driver_assignments
          set status = 'CANCELLED', closing_reason = 'HANDOFF_CANCELLED',
              cancelled_at = ${now}, updated_at = ${now}
          where id = ${handoff.to_assignment_id}
            and completed_at is null and cancelled_at is null`;
        await tx`
          update order_driver_handoffs
          set status = 'CANCELLED', cancelled_at = ${now}, updated_at = ${now},
              version = version + 1
          where id = ${handoff.id}`;
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          handoffId: handoff.id,
          assignmentId: handoff.to_assignment_id,
          eventType: "HANDOFF_CANCELLED",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          metadata: { note },
          createdAt: now,
        });
        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, handoff.to_driver_id, cityId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.cancelHandoff,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async completeHandoff(
    identity: AuthIdentity,
    orderId: string,
    handoffId: string,
    input: {
      fileId?: string;
      reason?: string;
      note?: string;
      actedOnBehalfOf?: "DRIVER";
      idempotencyKey: string;
      assignmentId?: string;
    },
    scope: { kind: "DRIVER" } | { kind: "DASHBOARD" },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId =
      scope.kind === "DASHBOARD"
        ? await requireCityPermission(
            this.client,
            identity,
            "orders.handoff.manage",
          )
        : requireTrustedDriverCity(identity).cityId;
    const reason =
      scope.kind === "DASHBOARD"
        ? reasonOf(input.reason)
        : noteOf(input.reason) ?? "Driver completed handoff";
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      handoffId,
      action: "completeHandoff",
      scopeKind: scope.kind,
      fileId: input.fileId ?? null,
      reason,
      note,
      assignmentId: input.assignmentId ?? null,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.completeHandoff,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        await this.lockAssignmentsForOrder(tx, orderId);
        const [handoff] = await tx<
          {
            id: string;
            status: string;
            from_assignment_id: string;
            to_assignment_id: string;
            from_driver_id: string;
            to_driver_id: string;
          }[]
        >`select id::text, status::text, from_assignment_id::text,
                 to_assignment_id::text, from_driver_id::text, to_driver_id::text
          from order_driver_handoffs
          where id = ${handoffId} and order_id = ${orderId} and city_id = ${cityId}
          for update`;
        if (!handoff) throw new AppError(404, "HANDOFF_NOT_FOUND", "Handoff not found");
        if (handoff.status === "COMPLETED") {
          const response = await this.orderResponse(tx, orderId, cityId);
          await completeOrderCommandIdempotency(tx, {
            ...idempotency,
            httpStatus: 200,
            payload: response as unknown as Record<string, unknown>,
          });
          return { response, effect: this.emptyEffect(cityId) };
        }
        if (handoff.status !== "PENDING")
          throw new AppError(
            409,
            "HANDOFF_NOT_PENDING",
            "Handoff is not pending",
          );
        if (
          scope.kind === "DRIVER" &&
          identity.accountId !== handoff.to_driver_id
        )
          throw new AppError(
            403,
            "FORBIDDEN",
            "Only the replacement driver can complete handoff",
          );
        if (
          input.assignmentId &&
          input.assignmentId !== handoff.to_assignment_id
        )
          throw new AppError(
            409,
            "PROOF_ASSIGNMENT_MISMATCH",
            "Assignment does not match handoff",
          );
        await this.lockDriverIds(tx, [
          handoff.from_driver_id,
          handoff.to_driver_id,
        ]);
        const now = new Date();
        const actor: OrderActor =
          scope.kind === "DASHBOARD"
            ? {
                ...this.staffActor(identity, reason, "DASHBOARD_OVERRIDE"),
                actedOnBehalfOf: "DRIVER",
              }
            : {
                accountId: identity.accountId,
                actorType: "DRIVER",
                source: "DRIVER_APP",
                reason,
              };
        let proofId: string | null = null;
        if (scope.kind === "DRIVER") {
          proofId = await this.consumeProof(tx, {
            fileId: input.fileId,
            purpose: "HANDOFF_PROOF",
            orderId,
            cityId,
            assignmentId: handoff.to_assignment_id,
            driverId: identity.accountId,
            handoffId: handoff.id,
          });
        }
        await tx`
          update order_driver_assignments
          set status = 'REPLACED_AFTER_PICKUP',
              closing_reason = 'REPLACED_AFTER_HANDOFF',
              cancelled_at = ${now}, updated_at = ${now}
          where id = ${handoff.from_assignment_id}`;
        await tx`
          update order_driver_assignments
          set status = 'PICKED_UP', picked_up_at = ${now},
              arrived_at_customer_at = null, updated_at = ${now}
          where id = ${handoff.to_assignment_id}`;
        await tx`
          update order_driver_handoffs
          set status = 'COMPLETED', completed_at = ${now}, proof_id = ${proofId},
              updated_at = ${now}, version = version + 1
          where id = ${handoff.id}`;
        await tx`
          update orders
          set driver_account_id = ${handoff.to_driver_id},
              custody_driver_id = ${handoff.to_driver_id},
              custody_status = 'WITH_DRIVER',
              updated_at = ${now}
          where id = ${order.id}`;
        if (order.status === "ARRIVED_AT_CUSTOMER") {
          await this.orders.applyOpsStatusTransition(
            tx,
            order,
            "PICKED_UP",
            {
              ...actor,
              custody: {
                status: "WITH_DRIVER",
                driverId: handoff.to_driver_id,
              },
            },
            now,
          );
        }
        await insertCustodyHistory(tx, {
          ...actor,
          orderId,
          assignmentId: handoff.to_assignment_id,
          fromStatus: "WITH_DRIVER",
          toStatus: "WITH_DRIVER",
          fromDriverId: handoff.from_driver_id,
          toDriverId: handoff.to_driver_id,
          createdAt: now,
        });
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: handoff.to_assignment_id,
          handoffId: handoff.id,
          proofId,
          eventType: "HANDOFF_COMPLETED",
          fromOrderStatus: order.status,
          toOrderStatus:
            order.status === "ARRIVED_AT_CUSTOMER" ? "PICKED_UP" : order.status,
          fromCustodyStatus: "WITH_DRIVER",
          toCustodyStatus: "WITH_DRIVER",
          metadata: { note },
          createdAt: now,
        });
        if (proofId) {
          await tx`
            update order_proofs
            set consumed_at = ${now}, handoff_id = ${handoff.id}
            where id = ${proofId}`;
        }
        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, handoff.from_driver_id, cityId);
        await this.trackDriver(tx, effect, handoff.to_driver_id, cityId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.completeHandoff,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async cancelByDashboard(
    identity: AuthIdentity,
    orderId: string,
    input: { reason: string; note?: string; idempotencyKey: string },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.cancel",
    );
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "cancelOrder",
      reason,
      note,
    });
    const idempotency = {
      scope: ORDER_COMMAND_SCOPES.cancelOrder,
      actorAccountId: identity.accountId,
      cityId,
      idempotencyKey,
    };

    const committed = await this.client.begin(async (tx) => {
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return {
          kind: "replay" as const,
          response: gate.payload,
          effect: null as Awaited<
            ReturnType<OrderService["executeDashboardCancel"]>
          > | null,
        };
      try {
        const effect = await this.orders.executeDashboardCancel(
          tx,
          identity,
          cityId,
          orderId,
          reason,
        );
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { kind: "done" as const, response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });

    if (committed.kind === "done" && committed.effect)
      await this.orders.applyDashboardCancelRuntime(committed.effect);
    return committed.response;
  }

  async startReturnToStore(
    identity: AuthIdentity,
    orderId: string,
    input: { reason: string; note?: string; idempotencyKey: string },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.return.manage",
    );
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "startReturnToStore",
      reason,
      note,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.startReturn,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_DRIVER")
          throw new AppError(
            409,
            "ORDER_CUSTODY_NOT_WITH_DRIVER",
            "Return requires driver custody",
          );
        if (order.status === "CANCELLED")
          throw new AppError(
            409,
            "ORDER_ALREADY_CANCELLED",
            "Cancelled orders already use the cancel-return path",
          );
        if (
          order.status !== "PICKED_UP" &&
          order.status !== "ARRIVED_AT_CUSTOMER"
        )
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not eligible for operational return",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const [activeReturn] = await tx<{ id: string }[]>`
          select id::text from order_return_workflows
          where order_id = ${orderId}
            and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
          for update`;
        if (activeReturn)
          throw new AppError(
            409,
            "RETURN_WORKFLOW_ALREADY_ACTIVE",
            "A return workflow is already active",
          );
        const [pendingHandoff] = await tx<
          { id: string; to_assignment_id: string; to_driver_id: string }[]
        >`select id::text, to_assignment_id::text, to_driver_id::text
          from order_driver_handoffs
          where order_id = ${orderId} and status = 'PENDING' for update`;
        const [assignment] = await tx<
          { id: string; driver_id: string; status: string }[]
        >`select id::text, driver_id::text, status::text
          from order_driver_assignments
          where order_id = ${orderId}
            and completed_at is null and cancelled_at is null
            and status in ('PICKED_UP','ARRIVED_AT_CUSTOMER')
          for update`;
        if (!assignment)
          throw new AppError(
            409,
            "DRIVER_ASSIGNMENT_REQUIRED",
            "An active driver assignment is required",
          );
        if (assignment.driver_id !== order.custody_driver_id)
          throw new AppError(
            409,
            "DRIVER_HANDOFF_CUSTODY_MISMATCH",
            "Custody driver does not match assignment",
          );
        const driverIds = [assignment.driver_id];
        if (pendingHandoff) driverIds.push(pendingHandoff.to_driver_id);
        await this.lockDriverIds(tx, driverIds);
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        if (pendingHandoff) {
          await tx`
            update order_driver_assignments
            set status = 'CANCELLED', closing_reason = 'HANDOFF_CANCELLED',
                cancelled_at = ${now}, updated_at = ${now}
            where id = ${pendingHandoff.to_assignment_id}
              and completed_at is null and cancelled_at is null`;
          await tx`
            update order_driver_handoffs
            set status = 'CANCELLED', cancelled_at = ${now}, updated_at = ${now},
                version = version + 1
            where id = ${pendingHandoff.id}`;
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            assignmentId: pendingHandoff.to_assignment_id,
            handoffId: pendingHandoff.id,
            eventType: "HANDOFF_CANCELLED",
            fromOrderStatus: order.status,
            toOrderStatus: order.status,
            reason: "Cancelled to start operational return",
            createdAt: now,
          });
        }
        await tx`
          update order_driver_assignments
          set status = 'RETURN_PENDING', updated_at = ${now}
          where id = ${assignment.id}`;
        const [workflow] = await tx<{ id: string }[]>`
          insert into order_return_workflows (
            order_id, city_id, assignment_id, driver_id, status, reason,
            started_by_account_id, started_at
          ) values (
            ${order.id}, ${cityId}, ${assignment.id}, ${assignment.driver_id},
            'WAITING_FOR_DRIVER_RETURN', ${reason}, ${identity.accountId}, ${now}
          ) returning id::text`;
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: assignment.id,
          returnWorkflowId: workflow!.id,
          eventType: "RETURN_STARTED",
          fromOrderStatus: order.status,
          toOrderStatus: order.status,
          fromCustodyStatus: "WITH_DRIVER",
          toCustodyStatus: "WITH_DRIVER",
          metadata: { note, operational: true },
          createdAt: now,
        });
        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, assignment.driver_id, cityId);
        if (pendingHandoff)
          await this.trackDriver(tx, effect, pendingHandoff.to_driver_id, cityId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.startReturn,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async confirmDriverReturn(
    identity: AuthIdentity,
    orderId: string,
    input: {
      fileId?: string;
      reason?: string;
      note?: string;
      idempotencyKey: string;
    },
    scope: { kind: "DRIVER" } | { kind: "DASHBOARD" },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId =
      scope.kind === "DASHBOARD"
        ? await requireCityPermission(
            this.client,
            identity,
            "orders.return.manage",
          )
        : requireTrustedDriverCity(identity).cityId;
    const reason =
      scope.kind === "DASHBOARD"
        ? reasonOf(input.reason)
        : noteOf(input.reason) ?? "Driver confirmed return";
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "confirmDriverReturn",
      scopeKind: scope.kind,
      fileId: input.fileId ?? null,
      reason,
      note,
    });

    return this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.confirmDriverReturn,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay") return gate.payload;
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_DRIVER")
          throw new AppError(
            409,
            "ORDER_CUSTODY_NOT_WITH_DRIVER",
            "Order is not awaiting driver return",
          );
        if (
          order.status !== "CANCELLED" &&
          order.status !== "PICKED_UP" &&
          order.status !== "ARRIVED_AT_CUSTOMER"
        )
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not awaiting driver return",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const [workflow] = await tx<
          {
            id: string;
            status: string;
            assignment_id: string;
            driver_id: string;
          }[]
        >`select id::text, status::text, assignment_id::text, driver_id::text
          from order_return_workflows
          where order_id = ${orderId} and city_id = ${cityId}
            and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
          for update`;
        if (!workflow)
          throw new AppError(
            409,
            "RETURN_WORKFLOW_REQUIRED",
            "Return workflow not found",
          );
        if (workflow.status === "WAITING_FOR_STORE_CONFIRMATION") {
          const response = await this.orderResponse(tx, orderId, cityId);
          await completeOrderCommandIdempotency(tx, {
            ...idempotency,
            httpStatus: 200,
            payload: response as unknown as Record<string, unknown>,
          });
          return response;
        }
        if (
          scope.kind === "DRIVER" &&
          identity.accountId !== workflow.driver_id
        )
          throw new AppError(403, "FORBIDDEN", "Only the custody driver can confirm return");
        await this.lockDriverIds(tx, [workflow.driver_id]);
        const now = new Date();
        const actor: OrderActor =
          scope.kind === "DASHBOARD"
            ? {
                ...this.staffActor(identity, reason, "DASHBOARD_OVERRIDE"),
                actedOnBehalfOf: "DRIVER",
              }
            : {
                accountId: identity.accountId,
                actorType: "DRIVER",
                source: "DRIVER_APP",
                reason,
              };
        let proofId: string | null = null;
        if (scope.kind === "DRIVER") {
          proofId = await this.consumeProof(tx, {
            fileId: input.fileId,
            purpose: "RETURN_PROOF",
            orderId,
            cityId,
            assignmentId: workflow.assignment_id,
            driverId: identity.accountId,
            returnWorkflowId: workflow.id,
          });
        }
        await tx`
          update order_return_workflows
          set status = 'WAITING_FOR_STORE_CONFIRMATION',
              driver_returned_at = ${now}, proof_id = ${proofId},
              updated_at = ${now}, version = version + 1
          where id = ${workflow.id}`;
        if (proofId) {
          await tx`
            update order_proofs
            set consumed_at = ${now}, return_workflow_id = ${workflow.id}
            where id = ${proofId}`;
        }
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: workflow.assignment_id,
          returnWorkflowId: workflow.id,
          proofId,
          eventType: "DRIVER_RETURN_PROOF_SUBMITTED",
          fromOrderStatus: "CANCELLED",
          toOrderStatus: "CANCELLED",
          metadata: { note },
          createdAt: now,
        });
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return response;
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.confirmDriverReturn,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
  }

  async confirmStoreReturn(
    identity: AuthIdentity,
    orderId: string,
    input: {
      reason?: string;
      note?: string;
      idempotencyKey: string;
    },
    scope: { kind: "MERCHANT"; storeId: string } | { kind: "DASHBOARD" },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId =
      scope.kind === "DASHBOARD"
        ? await requireCityPermission(
            this.client,
            identity,
            "orders.return.manage",
          )
        : identity.cityId;
    if (!cityId) throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
    if (scope.kind === "MERCHANT") {
      const trusted = requireTrustedMerchantStore(identity);
      if (trusted.storeId !== scope.storeId)
        throw new AppError(
          403,
          "STORE_ORDER_OWNERSHIP_REQUIRED",
          "Store order ownership is required",
        );
    }
    const reason =
      scope.kind === "DASHBOARD"
        ? reasonOf(input.reason)
        : noteOf(input.reason) ?? "Store confirmed return";
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "confirmStoreReturn",
      scopeKind: scope.kind,
      reason,
      note,
      ...(scope.kind === "MERCHANT" ? { storeId: scope.storeId } : {}),
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.confirmStoreReturn,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (scope.kind === "MERCHANT" && order.store_id !== scope.storeId)
          throw new AppError(
            403,
            "STORE_ORDER_OWNERSHIP_REQUIRED",
            "Store order ownership is required",
          );
        if (order.custody_status !== "WITH_DRIVER")
          throw new AppError(
            409,
            "ORDER_CUSTODY_NOT_WITH_DRIVER",
            "Order is not awaiting store return confirmation",
          );
        if (
          order.status !== "CANCELLED" &&
          order.status !== "PICKED_UP" &&
          order.status !== "ARRIVED_AT_CUSTOMER"
        )
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not awaiting store return confirmation",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const [workflow] = await tx<
          {
            id: string;
            status: string;
            assignment_id: string;
            driver_id: string;
            driver_returned_at: Date | string | null;
          }[]
        >`select id::text, status::text, assignment_id::text, driver_id::text,
                 driver_returned_at
          from order_return_workflows
          where order_id = ${orderId} and city_id = ${cityId}
            and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
          for update`;
        if (!workflow)
          throw new AppError(
            409,
            "RETURN_WORKFLOW_REQUIRED",
            "Return workflow not found",
          );
        if (workflow.status === "WAITING_FOR_DRIVER_RETURN" && scope.kind === "MERCHANT")
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Driver return confirmation is required first",
          );
        await this.lockDriverIds(tx, [workflow.driver_id]);
        const now = new Date();
        const actor: OrderActor =
          scope.kind === "DASHBOARD"
            ? {
                ...this.staffActor(identity, reason, "DASHBOARD_OVERRIDE"),
                actedOnBehalfOf: "STORE",
              }
            : {
                accountId: identity.accountId,
                actorType: "MERCHANT",
                source: "MERCHANT_APP",
                reason,
              };
        const driverReturnedAt = workflow.driver_returned_at ?? now;
        await tx`
          update order_return_workflows
          set status = 'COMPLETED',
              driver_returned_at = ${driverReturnedAt},
              store_confirmed_at = ${now},
              completed_at = ${now},
              updated_at = ${now}, version = version + 1
          where id = ${workflow.id}`;
        await tx`
          update order_driver_assignments
          set status = 'RETURNED_TO_STORE',
              closing_reason = 'RETURNED_TO_STORE',
              cancelled_at = ${now}, updated_at = ${now}
          where id = ${workflow.assignment_id}`;

        const fromStatus = order.status;
        let toStatus: OrderStatus = order.status;
        if (order.status === "CANCELLED") {
          await tx`
            update orders
            set custody_status = 'WITH_STORE', custody_driver_id = null,
                driver_account_id = null, updated_at = ${now}
            where id = ${order.id}`;
        } else {
          // PICKED_UP/ARRIVED cannot stay WITH_STORE — move to READY_FOR_PICKUP.
          toStatus = "READY_FOR_PICKUP";
          await this.orders.applyOpsStatusTransition(
            tx,
            order,
            "READY_FOR_PICKUP",
            {
              ...actor,
              custody: { status: "WITH_STORE", driverId: null },
            },
            now,
          );
          await tx`
            update orders
            set driver_account_id = null,
                store_ready_marked_at = coalesce(store_ready_marked_at, ${now}),
                updated_at = ${now}
            where id = ${order.id}`;
        }
        await insertCustodyHistory(tx, {
          ...actor,
          orderId,
          assignmentId: workflow.assignment_id,
          fromStatus: "WITH_DRIVER",
          toStatus: "WITH_STORE",
          fromDriverId: workflow.driver_id,
          toDriverId: null,
          createdAt: now,
        });
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: workflow.assignment_id,
          returnWorkflowId: workflow.id,
          eventType: "STORE_CONFIRMED_RETURN",
          fromOrderStatus: fromStatus,
          toOrderStatus: toStatus,
          fromCustodyStatus: "WITH_DRIVER",
          toCustodyStatus: "WITH_STORE",
          metadata: { note },
          createdAt: now,
        });
        await insertOrderEvent(tx, {
          ...actor,
          orderId,
          assignmentId: workflow.assignment_id,
          returnWorkflowId: workflow.id,
          eventType: "RETURN_COMPLETED",
          fromOrderStatus: fromStatus,
          toOrderStatus: toStatus,
          fromCustodyStatus: "WITH_DRIVER",
          toCustodyStatus: "WITH_STORE",
          createdAt: now,
        });
        const effect = this.emptyEffect(cityId);
        await this.trackDriver(tx, effect, workflow.driver_id, cityId);
        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.confirmStoreReturn,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async reopenOrder(
    identity: AuthIdentity,
    orderId: string,
    input: {
      reason: string;
      note?: string;
      nextAction: "KEEP_CANCELLED" | "PREPARE" | "REOFFER" | "ASSIGN_DRIVER";
      driverId?: string;
      idempotencyKey: string;
    },
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(input.idempotencyKey);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.assign",
    );
    if (input.nextAction === "REOFFER")
      await requireCityPermission(this.client, identity, "orders.reoffer");
    const reason = reasonOf(input.reason);
    const note = noteOf(input.note);
    const requestHash = hashOrderCommandPayload({
      orderId,
      action: "reopenOrder",
      reason,
      note,
      nextAction: input.nextAction,
      driverId: input.driverId ?? null,
    });

    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.reopenOrder,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay")
        return { response: gate.payload, effect: this.emptyEffect(cityId) };
      try {
        const order = await this.lockOrder(tx, orderId, cityId);
        if (order.custody_status !== "WITH_STORE")
          throw new AppError(
            409,
            "ORDER_CUSTODY_NOT_WITH_STORE",
            "Order is not eligible for reopen",
          );
        const [completedReturn] = await tx<{ id: string }[]>`
          select id::text from order_return_workflows
          where order_id = ${orderId} and status = 'COMPLETED'
          order by completed_at desc nulls last limit 1`;
        const eligible =
          order.status === "CANCELLED" ||
          (order.status === "READY_FOR_PICKUP" && !!completedReturn);
        if (!eligible)
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Order is not eligible for reopen",
          );
        await this.lockAssignmentsForOrder(tx, orderId);
        const [activeReturn] = await tx<{ id: string }[]>`
          select id::text from order_return_workflows
          where order_id = ${orderId}
            and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
          for update`;
        if (activeReturn)
          throw new AppError(
            409,
            "ORDER_INVALID_STATE",
            "Return workflow must be completed first",
          );
        const now = new Date();
        const actor = this.staffActor(identity, reason);
        const effect = this.emptyEffect(cityId);

        if (input.nextAction === "KEEP_CANCELLED") {
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            eventType: "ORDER_REOPENED",
            fromOrderStatus: order.status,
            toOrderStatus: order.status,
            metadata: { note, nextAction: "KEEP_CANCELLED" },
            createdAt: now,
          });
        } else if (input.nextAction === "PREPARE") {
          await this.orders.applyOpsStatusTransition(
            tx,
            order,
            "PENDING_STORE_APPROVAL",
            actor,
            now,
          );
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            eventType: "ORDER_REOPENED",
            fromOrderStatus: order.status,
            toOrderStatus: "PENDING_STORE_APPROVAL",
            metadata: { note, nextAction: "PREPARE" },
            createdAt: now,
          });
        } else if (input.nextAction === "REOFFER") {
          const lockedFee =
            order.locked_driver_fee ??
            (
              await tx<{ driver_fee: number }[]>`
                select driver_fee from order_driver_assignments
                where order_id = ${orderId}
                order by assigned_at desc limit 1`
            )[0]?.driver_fee;
          if (!lockedFee)
            throw new AppError(
              409,
              "ORDER_INVALID_STATE",
              "Locked driver fee is required",
            );
          await tx`
            update orders set locked_driver_fee = ${lockedFee}, updated_at = ${now}
            where id = ${order.id}`;
          await this.orders.applyOpsStatusTransition(
            tx,
            order,
            "SEARCHING_DRIVER",
            actor,
            now,
          );
          const roundId = await this.openLockedOfferRound(tx, {
            orderId,
            cityId,
            actorAccountId: identity.accountId,
            roundKind: "INITIAL",
            reofferReason: reason,
            lockedFee,
            now,
          });
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            eventType: "ORDER_REOPENED",
            fromOrderStatus: order.status,
            toOrderStatus: "SEARCHING_DRIVER",
            metadata: { note, nextAction: "REOFFER", roundId },
            createdAt: now,
          });
          const cityRecon = await enqueueCityOpenOffersRecon(tx, cityId);
          effect.cityRevision = cityRecon.revision;
          effect.jobIds.push(cityRecon.jobId);
        } else {
          if (!input.driverId)
            throw new AppError(422, "VALIDATION_FAILED", "driverId is required");
          const lockedFee =
            order.locked_driver_fee ??
            (
              await tx<{ driver_fee: number }[]>`
                select driver_fee from order_driver_assignments
                where order_id = ${orderId}
                order by assigned_at desc limit 1`
            )[0]?.driver_fee;
          if (!lockedFee)
            throw new AppError(
              409,
              "ORDER_INVALID_STATE",
              "Locked driver fee is required",
            );
          await this.lockDriverIds(tx, [input.driverId]);
          const sequence = await this.assertEligibleDriver(
            tx,
            input.driverId,
            cityId,
            2,
          );
          const previous =
            (
              await tx<AssignmentRow[]>`
                select id::text, driver_id::text, city_id::text, status::text,
                       driver_fee, assignment_sequence, picked_up_at,
                       arrived_at_customer_at, completed_at, cancelled_at,
                       offer_round_id::text, pricing_base_snapshot,
                       rounding_unit_snapshot, pricing_stages_snapshot,
                       pricing_version_snapshot, pricing_stage_after_seconds,
                       pricing_stage_increase_percentage
                from order_driver_assignments
                where order_id = ${orderId}
                order by assigned_at desc limit 1`
            )[0] ?? null;
          const pricing = await this.loadCityPricing(tx, cityId);
          const [assignment] = await tx<{ id: string }[]>`
            insert into order_driver_assignments (
              order_id, driver_id, city_id, assignment_source, status,
              assignment_sequence, assigned_by_account_id, assignment_reason,
              driver_fee, original_driver_fee, fee_locked_from_assignment_id,
              replaces_assignment_id, assigned_at,
              pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
              pricing_version_snapshot, pricing_stage_after_seconds,
              pricing_stage_increase_percentage
            ) values (
              ${orderId}, ${input.driverId}, ${cityId}, 'DASHBOARD_MANUAL',
              'ASSIGNED', ${sequence}, ${identity.accountId}, ${reason},
              ${lockedFee}, ${lockedFee}, ${previous?.id ?? null},
              ${previous?.id ?? null}, ${now},
              ${previous?.pricing_base_snapshot ?? lockedFee},
              ${previous?.rounding_unit_snapshot ?? pricing.rounding_unit},
              ${parseStages(previous?.pricing_stages_snapshot) ?? pricing.pricing_stages},
              ${previous?.pricing_version_snapshot ?? pricing.version},
              ${previous?.pricing_stage_after_seconds ?? 0},
              ${previous?.pricing_stage_increase_percentage ?? 0}
            ) returning id::text`;
          const nextStatus: OrderStatus = order.store_ready_marked_at
            ? "READY_FOR_PICKUP"
            : "DRIVER_ASSIGNED";
          if (order.status !== nextStatus) {
            await this.orders.applyOpsStatusTransition(
              tx,
              order,
              nextStatus,
              actor,
              now,
            );
          }
          await tx`
            update orders
            set driver_account_id = ${input.driverId},
                locked_driver_fee = ${lockedFee}, updated_at = ${now}
            where id = ${order.id}`;
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            assignmentId: assignment!.id,
            eventType: "ORDER_REOPENED",
            fromOrderStatus: order.status,
            toOrderStatus: nextStatus,
            metadata: { note, nextAction: "ASSIGN_DRIVER" },
            createdAt: now,
          });
          await insertOrderEvent(tx, {
            ...actor,
            orderId,
            assignmentId: assignment!.id,
            eventType: "DRIVER_MANUALLY_ASSIGNED",
            fromOrderStatus: nextStatus,
            toOrderStatus: nextStatus,
            createdAt: now,
          });
          await this.trackDriver(tx, effect, input.driverId, cityId);
        }

        const response = await this.orderResponse(tx, orderId, cityId);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload: response as unknown as Record<string, unknown>,
        });
        return { response, effect };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, {
          scope: ORDER_COMMAND_SCOPES.reopenOrder,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey,
        });
        throw error;
      }
    });
    await this.applyRuntime(committed.effect);
    return committed.response;
  }

  async getDriverOps(identity: AuthIdentity, orderId: string) {
    const { cityId } = requireTrustedDriverCity(identity);
    const [order] = await this.client<Record<string, unknown>[]>`
      select o.id::text, o.order_number, o.status::text, o.custody_status::text,
             o.custody_driver_id::text, o.driver_account_id::text, o.version,
             o.locked_driver_fee, o.store_ready_marked_at
      from orders o
      where o.id = ${orderId} and o.city_id = ${cityId}`;
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const assignments = await this.client<Record<string, unknown>[]>`
      select id::text, driver_id::text, status::text, assignment_source::text,
             driver_fee, assignment_sequence, replaces_assignment_id::text,
             replaced_by_assignment_id::text, closing_reason::text,
             assigned_at, picked_up_at, arrived_at_customer_at, completed_at,
             cancelled_at
      from order_driver_assignments
      where order_id = ${orderId} and city_id = ${cityId}
        and driver_id = ${identity.accountId}
      order by assigned_at desc, id desc`;
    if (assignments.length === 0)
      throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const [handoff] = await this.client<Record<string, unknown>[]>`
      select id::text, status::text, from_assignment_id::text, to_assignment_id::text,
             from_driver_id::text, to_driver_id::text, reason, started_at,
             completed_at, cancelled_at
      from order_driver_handoffs
      where order_id = ${orderId} and city_id = ${cityId}
        and (from_driver_id = ${identity.accountId} or to_driver_id = ${identity.accountId})
      order by started_at desc limit 1`;
    const [ret] = await this.client<Record<string, unknown>[]>`
      select id::text, status::text, assignment_id::text, driver_id::text,
             reason, started_at, driver_returned_at, store_confirmed_at, completed_at
      from order_return_workflows
      where order_id = ${orderId} and city_id = ${cityId}
        and driver_id = ${identity.accountId}
      order by started_at desc limit 1`;
    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: order.status,
      custodyStatus: order.custody_status,
      custodyDriverId: order.custody_driver_id,
      lockedDriverFee:
        order.locked_driver_fee == null ? null : Number(order.locked_driver_fee),
      assignments: assignments.map((row) => ({
        id: row.id,
        driverId: row.driver_id,
        status: row.status,
        assignmentSource: row.assignment_source,
        driverFee: Number(row.driver_fee),
        assignmentSequence: Number(row.assignment_sequence),
        replacesAssignmentId: row.replaces_assignment_id,
        replacedByAssignmentId: row.replaced_by_assignment_id,
        closingReason: row.closing_reason,
        assignedAt: dateValue(row.assigned_at),
        pickedUpAt: dateValue(row.picked_up_at),
        arrivedAtCustomerAt: dateValue(row.arrived_at_customer_at),
        completedAt: dateValue(row.completed_at),
        cancelledAt: dateValue(row.cancelled_at),
      })),
      handoff: handoff
        ? {
            id: handoff.id,
            status: handoff.status,
            fromAssignmentId: handoff.from_assignment_id,
            toAssignmentId: handoff.to_assignment_id,
            fromDriverId: handoff.from_driver_id,
            toDriverId: handoff.to_driver_id,
            reason: handoff.reason,
            startedAt: dateValue(handoff.started_at),
            completedAt: dateValue(handoff.completed_at),
            cancelledAt: dateValue(handoff.cancelled_at),
          }
        : null,
      returnWorkflow: ret
        ? {
            id: ret.id,
            status: ret.status,
            assignmentId: ret.assignment_id,
            driverId: ret.driver_id,
            reason: ret.reason,
            startedAt: dateValue(ret.started_at),
            driverReturnedAt: dateValue(ret.driver_returned_at),
            storeConfirmedAt: dateValue(ret.store_confirmed_at),
            completedAt: dateValue(ret.completed_at),
          }
        : null,
    };
  }

  async listStorePendingReturns(identity: AuthIdentity, page = 1, limit = 20) {
    const { storeId, cityId } = requireTrustedMerchantStore(identity);
    const p = pageOf(page, limit);
    const offset = (p.page - 1) * p.limit;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total
      from order_return_workflows r
      join orders o on o.id = r.order_id
      where o.store_id = ${storeId} and o.city_id = ${cityId}
        and r.status = 'WAITING_FOR_STORE_CONFIRMATION'`;
    const rows = await this.client<Record<string, unknown>[]>`
      select r.id::text, r.order_id::text, r.status::text, r.driver_id::text,
             r.assignment_id::text, r.reason, r.driver_returned_at, r.started_at,
             o.order_number
      from order_return_workflows r
      join orders o on o.id = r.order_id
      where o.store_id = ${storeId} and o.city_id = ${cityId}
        and r.status = 'WAITING_FOR_STORE_CONFIRMATION'
      order by r.driver_returned_at asc nulls last, r.id asc
      limit ${p.limit} offset ${offset}`;
    return {
      data: rows.map((row) => ({
        returnWorkflowId: row.id,
        orderId: row.order_id,
        orderNumber: row.order_number,
        status: row.status,
        driverId: row.driver_id,
        assignmentId: row.assignment_id,
        reason: row.reason,
        driverReturnedAt: dateValue(row.driver_returned_at),
        startedAt: dateValue(row.started_at),
      })),
      page: p.page,
      limit: p.limit,
      total: count?.total ?? 0,
    };
  }
}
