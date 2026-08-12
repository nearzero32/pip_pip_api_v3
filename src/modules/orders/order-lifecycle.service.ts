import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireTrustedDriverCity } from "../auth/mobile/driver/driver-scope";
import { requireCityPermission } from "../auth/staff/authorization";
import type {
  DriverRuntimeStoreLike,
  DriverWorkStatus,
} from "../driver-offers/driver-runtime";
import {
  applyRedisAfterCommit,
  bumpDriverRuntimeRevision,
  enqueueDriverRuntimeRecon,
} from "../driver-offers/redis-reconciliation";
import type { MediaService } from "../media/media.service";
import { dateValue } from "../geography/shared";
import {
  mayConfirmArrival,
  mayConfirmDelivery,
  mayConfirmPickup,
  mayMarkReady,
  type OrderStatus,
} from "./order-state-machine";
import type { OrderService } from "./order.service";
import { insertCustodyHistory, insertOrderEvent, type OrderActor } from "./order-events";
import {
  abortOrderCommandIdempotency,
  beginOrderCommandIdempotency,
  completeOrderCommandIdempotency,
  hashOrderCommandPayload,
  ORDER_COMMAND_SCOPES,
  requireOrderIdempotencyKey,
} from "./order-command-idempotency";

type MerchantScope = { kind: "MERCHANT"; storeId: string };
type DriverScope = { kind: "DRIVER" };
type DashboardScope = {
  kind: "DASHBOARD";
  reason: string;
  actedOnBehalfOf: "STORE" | "DRIVER";
};

type LockedOrder = {
  id: string;
  city_id: string;
  store_id: string;
  status: OrderStatus;
  version: number;
  custody_status: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER";
  custody_driver_id: string | null;
};

type Assignment = {
  id: string;
  driver_id: string;
  city_id: string;
  status: "ASSIGNED" | "PICKED_UP" | "ARRIVED_AT_CUSTOMER" | "COMPLETED";
  picked_up_at: Date | string | null;
  arrived_at_customer_at: Date | string | null;
  completed_at: Date | string | null;
};

const reasonOf = (value: unknown): string => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason || reason.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", "Invalid reason");
  return reason;
};

export class OrderLifecycleService {
  constructor(
    private client: SQL,
    private orders: OrderService,
    private media: MediaService,
    private runtime: DriverRuntimeStoreLike | null = null,
    private logger: Logger | null = null,
  ) {}

  private actor(identity: AuthIdentity, scope: MerchantScope | DriverScope | DashboardScope): OrderActor {
    if (scope.kind === "MERCHANT")
      return {
        accountId: identity.accountId,
        actorType: "MERCHANT",
        source: "MERCHANT_APP",
      };
    if (scope.kind === "DRIVER")
      return {
        accountId: identity.accountId,
        actorType: "DRIVER",
        source: "DRIVER_APP",
      };
    return {
      accountId: identity.accountId,
      actorType: "STAFF",
      source: "DASHBOARD_OVERRIDE",
      actedOnBehalfOf: scope.actedOnBehalfOf,
      reason: reasonOf(scope.reason),
    };
  }

  private async cityFor(
    identity: AuthIdentity,
    scope: MerchantScope | DriverScope | DashboardScope,
  ) {
    if (scope.kind === "DASHBOARD")
      return requireCityPermission(
        this.client,
        identity,
        "orders.lifecycle.override",
      );
    if (scope.kind === "DRIVER")
      return requireTrustedDriverCity(identity).cityId;
    if (
      identity.applicationType !== "MERCHANT_APP" ||
      !identity.cityId ||
      identity.storeId !== scope.storeId
    )
      throw new AppError(
        403,
        "STORE_ORDER_OWNERSHIP_REQUIRED",
        "Store order ownership is required",
      );
    return identity.cityId;
  }

  private async lockOrder(
    tx: SQL,
    orderId: string,
    cityId: string,
  ): Promise<LockedOrder> {
    const [order] = await tx<LockedOrder[]>`
      select id::text, city_id::text, store_id::text, status::text, version,
             custody_status::text, custody_driver_id::text
      from orders where id = ${orderId} and city_id = ${cityId} for update`;
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return order;
  }

  private async activeAssignment(
    tx: SQL,
    orderId: string,
    cityId: string,
  ): Promise<Assignment> {
    const [assignment] = await tx<Assignment[]>`
      select id::text, driver_id::text, city_id::text, status::text,
             picked_up_at, arrived_at_customer_at, completed_at
      from order_driver_assignments
      where order_id = ${orderId} and city_id = ${cityId}
        and completed_at is null and cancelled_at is null
        and status in ('ASSIGNED','PICKED_UP','ARRIVED_AT_CUSTOMER')
      for update`;
    if (!assignment)
      throw new AppError(
        409,
        "DRIVER_ASSIGNMENT_REQUIRED",
        "An active driver assignment is required",
      );
    return assignment;
  }

  private async assertDeliveryNotBlocked(tx: SQL, order: LockedOrder) {
    if (order.status === "CANCELLED")
      throw new AppError(
        409,
        "ORDER_ALREADY_CANCELLED",
        "Cancelled orders cannot be delivered",
      );
    const [handoff] = await tx<{ id: string }[]>`
      select id::text from order_driver_handoffs
      where order_id = ${order.id} and status = 'PENDING'`;
    if (handoff)
      throw new AppError(
        409,
        "DRIVER_HANDOFF_ALREADY_ACTIVE",
        "Pending handoff freezes delivery for the current driver",
      );
    const [ret] = await tx<{ id: string }[]>`
      select id::text from order_return_workflows
      where order_id = ${order.id}
        and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')`;
    if (ret)
      throw new AppError(
        409,
        "RETURN_WORKFLOW_ALREADY_ACTIVE",
        "Return workflow is active; delivery is not allowed",
      );
  }

  private assertScopeOwnership(
    identity: AuthIdentity,
    scope: MerchantScope | DriverScope | DashboardScope,
    order: LockedOrder,
    assignment: Assignment,
  ) {
    if (scope.kind === "MERCHANT" && order.store_id !== scope.storeId)
      throw new AppError(
        403,
        "STORE_ORDER_OWNERSHIP_REQUIRED",
        "Store order ownership is required",
      );
    if (scope.kind === "DRIVER" && assignment.driver_id !== identity.accountId)
      throw new AppError(
        409,
        "DRIVER_ASSIGNMENT_REQUIRED",
        "An active driver assignment is required",
      );
  }

  private async dto(orderId: string, cityId: string, executor: SQL = this.client) {
    const [row] = await executor<Record<string, unknown>[]>`
      select o.id::text, o.order_number, o.city_id::text, o.store_id::text,
             o.status::text, o.version, o.custody_status::text,
             o.custody_driver_id::text, o.status_changed_at, o.delivered_at,
             a.id::text assignment_id, a.driver_id::text, a.status::text assignment_status,
             a.picked_up_at, a.arrived_at_customer_at, a.completed_at
      from orders o
      left join order_driver_assignments a on a.order_id = o.id
        and a.cancelled_at is null
      where o.id = ${orderId} and o.city_id = ${cityId}
      order by a.assigned_at desc nulls last limit 1`;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return {
      id: row.id,
      orderNumber: row.order_number,
      cityId: row.city_id,
      storeId: row.store_id,
      status: row.status,
      version: Number(row.version),
      custodyStatus: row.custody_status,
      custodyDriverId: row.custody_driver_id,
      statusChangedAt: dateValue(row.status_changed_at),
      deliveredAt: dateValue(row.delivered_at),
      assignment: row.assignment_id
        ? {
            id: row.assignment_id,
            driverId: row.driver_id,
            status: row.assignment_status,
            pickedUpAt: dateValue(row.picked_up_at),
            arrivedAtCustomerAt: dateValue(row.arrived_at_customer_at),
            completedAt: dateValue(row.completed_at),
          }
        : null,
    };
  }

  async markReady(
    identity: AuthIdentity,
    orderId: string,
    scope: MerchantScope | DashboardScope,
    idempotencyKeyInput: string,
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(idempotencyKeyInput);
    const cityId = await this.cityFor(identity, scope);
    const actor = this.actor(identity, scope);
    const requestHash = hashOrderCommandPayload({
      orderId, action: "markReady", scopeKind: scope.kind,
      ...(scope.kind === "MERCHANT" ? { storeId: scope.storeId } : {
        reason: actor.reason, actedOnBehalfOf: scope.actedOnBehalfOf,
      }),
    });
    return this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.markReady,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, { ...idempotency, requestHash });
      if (gate.kind === "replay") return gate.payload;
      try {
      const order = await this.lockOrder(tx, orderId, cityId);
      const assignment = await this.activeAssignment(tx, orderId, cityId);
      this.assertScopeOwnership(identity, scope, order, assignment);
      if (order.status === "READY_FOR_PICKUP") {
        const response = await this.dto(orderId, cityId, tx);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency, httpStatus: 200, payload: response,
        });
        return response;
      }
      if (!mayMarkReady(order.status))
        throw new AppError(
          409,
          "ORDER_INVALID_TRANSITION",
          "Order state transition is not allowed",
        );
      const now = new Date();
      await this.orders.applyStatusTransition(
        tx,
        order,
        "READY_FOR_PICKUP",
        actor,
        now,
      );
      await tx`
        update orders
        set store_ready_marked_at = coalesce(store_ready_marked_at, ${now}),
            updated_at = ${now}
        where id = ${order.id}`;
      await insertOrderEvent(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        eventType: "STORE_MARKED_READY",
        fromOrderStatus: order.status,
        toOrderStatus: "READY_FOR_PICKUP",
        createdAt: now,
      });
      const response = await this.dto(orderId, cityId, tx);
      await completeOrderCommandIdempotency(tx, {
        ...idempotency, httpStatus: 200, payload: response,
      });
      return response;
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });
  }

  private async consumeProof(
    tx: SQL,
    input: {
      fileId: string | undefined;
      purpose: "PICKUP_PROOF" | "DELIVERY_PROOF";
      order: LockedOrder;
      assignment: Assignment;
      driverId: string | null;
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
    }[]>`
      select id::text, order_id::text, assignment_id::text, city_id::text,
             media_asset_id::text, purpose::text, uploaded_by_driver_id::text,
             consumed_at
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
      proof.order_id !== input.order.id ||
      proof.assignment_id !== input.assignment.id
    )
      throw new AppError(
        409,
        "PROOF_ASSIGNMENT_MISMATCH",
        "Proof assignment does not match",
      );
    if (
      proof.city_id !== input.order.city_id ||
      (input.driverId && proof.uploaded_by_driver_id !== input.driverId)
    )
      throw new AppError(404, "PROOF_NOT_FOUND", "Proof not found");
    await this.media.claimAsset(tx, {
      assetId: proof.media_asset_id,
      cityId: input.order.city_id,
      purpose: input.purpose,
      visibility: "PRIVATE",
    });
    return proof.id;
  }

  async confirmPickup(
    identity: AuthIdentity,
    orderId: string,
    input: { fileId?: string; reason?: string; note?: string },
    scope: DriverScope | DashboardScope,
    idempotencyKeyInput: string,
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(idempotencyKeyInput);
    const cityId = await this.cityFor(identity, scope);
    const actor = this.actor(identity, scope);
    const requestHash = hashOrderCommandPayload({
      orderId, action: "confirmPickup", scopeKind: scope.kind,
      fileId: input.fileId ?? null, reason: actor.reason ?? input.reason ?? null,
      note: input.note ?? null,
      ...(scope.kind === "DASHBOARD" ? { actedOnBehalfOf: scope.actedOnBehalfOf } : {}),
    });
    return this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.confirmPickup,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, { ...idempotency, requestHash });
      if (gate.kind === "replay") return gate.payload;
      try {
      const order = await this.lockOrder(tx, orderId, cityId);
      const assignment = await this.activeAssignment(tx, orderId, cityId);
      this.assertScopeOwnership(identity, scope, order, assignment);
      if (
        order.status === "PICKED_UP" &&
        assignment.status === "PICKED_UP" &&
        order.custody_driver_id === assignment.driver_id
      ) {
        const response = await this.dto(orderId, cityId, tx);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency, httpStatus: 200, payload: response,
        });
        return response;
      }
      if (!mayConfirmPickup(order.status))
        throw new AppError(
          409,
          "ORDER_INVALID_TRANSITION",
          "Order state transition is not allowed",
        );
      const proofId =
        scope.kind === "DRIVER"
          ? await this.consumeProof(tx, {
              fileId: input.fileId,
              purpose: "PICKUP_PROOF",
              order,
              assignment,
              driverId: identity.accountId,
            })
          : null;
      const now = new Date();
      await this.orders.applyStatusTransition(
        tx,
        order,
        "PICKED_UP",
        {
          ...actor,
          custody: { status: "WITH_DRIVER", driverId: assignment.driver_id },
        },
        now,
      );
      await tx`
        update order_driver_assignments set status = 'PICKED_UP',
          picked_up_at = ${now}, updated_at = ${now}
        where id = ${assignment.id}`;
      const eventId = await insertOrderEvent(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        eventType: "DRIVER_PICKED_UP",
        fromOrderStatus: order.status,
        toOrderStatus: "PICKED_UP",
        fromCustodyStatus: order.custody_status,
        toCustodyStatus: "WITH_DRIVER",
        proofId,
        metadata: input.note ? { note: input.note } : null,
        createdAt: now,
      });
      if (proofId)
        await tx`update order_proofs set consumed_at = ${now},
          consumed_by_event_id = ${eventId} where id = ${proofId}`;
      await insertCustodyHistory(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        fromStatus: order.custody_status,
        toStatus: "WITH_DRIVER",
        fromDriverId: order.custody_driver_id,
        toDriverId: assignment.driver_id,
        createdAt: now,
      });
      const response = await this.dto(orderId, cityId, tx);
      await completeOrderCommandIdempotency(tx, {
        ...idempotency, httpStatus: 200, payload: response,
      });
      return response;
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });
  }

  async confirmArrival(
    identity: AuthIdentity,
    orderId: string,
    input: { reason?: string; note?: string },
    scope: DriverScope | DashboardScope,
    idempotencyKeyInput: string,
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(idempotencyKeyInput);
    const cityId = await this.cityFor(identity, scope);
    const actor = this.actor(identity, scope);
    const requestHash = hashOrderCommandPayload({
      orderId, action: "confirmArrival", scopeKind: scope.kind,
      reason: actor.reason ?? input.reason ?? null, note: input.note ?? null,
      ...(scope.kind === "DASHBOARD" ? { actedOnBehalfOf: scope.actedOnBehalfOf } : {}),
    });
    return this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.confirmArrival,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, { ...idempotency, requestHash });
      if (gate.kind === "replay") return gate.payload;
      try {
      const order = await this.lockOrder(tx, orderId, cityId);
      const assignment = await this.activeAssignment(tx, orderId, cityId);
      this.assertScopeOwnership(identity, scope, order, assignment);
      await this.assertDeliveryNotBlocked(tx, order);
      if (
        order.status === "ARRIVED_AT_CUSTOMER" &&
        assignment.status === "ARRIVED_AT_CUSTOMER"
      ) {
        const response = await this.dto(orderId, cityId, tx);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency, httpStatus: 200, payload: response,
        });
        return response;
      }
      if (!mayConfirmArrival(order.status))
        throw new AppError(
          409,
          "ORDER_INVALID_TRANSITION",
          "Order state transition is not allowed",
        );
      if (
        scope.kind === "DRIVER" &&
        (order.custody_status !== "WITH_DRIVER" ||
          order.custody_driver_id !== identity.accountId)
      )
        throw new AppError(
          409,
          "DRIVER_NOT_CUSTODY_HOLDER",
          "Driver does not hold order custody",
        );
      const now = new Date();
      await this.orders.applyStatusTransition(
        tx,
        order,
        "ARRIVED_AT_CUSTOMER",
        actor,
        now,
      );
      await tx`
        update order_driver_assignments set status = 'ARRIVED_AT_CUSTOMER',
          arrived_at_customer_at = ${now}, updated_at = ${now}
        where id = ${assignment.id}`;
      await insertOrderEvent(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        eventType: "DRIVER_ARRIVED_AT_CUSTOMER",
        fromOrderStatus: order.status,
        toOrderStatus: "ARRIVED_AT_CUSTOMER",
        metadata: input.note ? { note: input.note } : null,
        createdAt: now,
      });
      const response = await this.dto(orderId, cityId, tx);
      await completeOrderCommandIdempotency(tx, {
        ...idempotency, httpStatus: 200, payload: response,
      });
      return response;
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });
  }

  async confirmDelivery(
    identity: AuthIdentity,
    orderId: string,
    input: { fileId?: string; reason?: string; note?: string },
    scope: DriverScope | DashboardScope,
    idempotencyKeyInput: string,
  ) {
    const idempotencyKey = requireOrderIdempotencyKey(idempotencyKeyInput);
    const cityId = await this.cityFor(identity, scope);
    const actor = this.actor(identity, scope);
    const requestHash = hashOrderCommandPayload({
      orderId, action: "confirmDelivery", scopeKind: scope.kind,
      fileId: input.fileId ?? null, reason: actor.reason ?? input.reason ?? null,
      note: input.note ?? null,
      ...(scope.kind === "DASHBOARD" ? { actedOnBehalfOf: scope.actedOnBehalfOf } : {}),
    });
    const committed = await this.client.begin(async (tx) => {
      const idempotency = {
        scope: ORDER_COMMAND_SCOPES.confirmDelivery,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, { ...idempotency, requestHash });
      if (gate.kind === "replay")
        return {
          response: gate.payload,
          driverId: null as string | null,
          revision: null as number | null,
          jobId: null as string | null,
        };
      try {
      const order = await this.lockOrder(tx, orderId, cityId);
      if (order.status === "DELIVERED") {
        const [done] = await tx<Assignment[]>`
          select id::text, driver_id::text, city_id::text, status::text,
                 picked_up_at, arrived_at_customer_at, completed_at
          from order_driver_assignments
          where order_id = ${orderId} and city_id = ${cityId}
            and status = 'COMPLETED' and completed_at is not null
          order by completed_at desc limit 1 for update`;
        if (done) {
          this.assertScopeOwnership(identity, scope, order, done);
          const response = await this.dto(orderId, cityId, tx);
          await completeOrderCommandIdempotency(tx, {
            ...idempotency, httpStatus: 200, payload: response,
          });
          return {
            response,
            driverId: done.driver_id,
            revision: null as number | null,
            jobId: null as string | null,
          };
        }
      }
      const assignment = await this.activeAssignment(tx, orderId, cityId);
      this.assertScopeOwnership(identity, scope, order, assignment);
      await this.assertDeliveryNotBlocked(tx, order);
      if (!mayConfirmDelivery(order.status))
        throw new AppError(
          409,
          "ORDER_INVALID_TRANSITION",
          "Order state transition is not allowed",
        );
      if (
        scope.kind === "DRIVER" &&
        (order.custody_status !== "WITH_DRIVER" ||
          order.custody_driver_id !== identity.accountId)
      )
        throw new AppError(
          409,
          "DRIVER_NOT_CUSTODY_HOLDER",
          "Driver does not hold order custody",
        );
      const proofId =
        scope.kind === "DRIVER"
          ? await this.consumeProof(tx, {
              fileId: input.fileId,
              purpose: "DELIVERY_PROOF",
              order,
              assignment,
              driverId: identity.accountId,
            })
          : null;
      const now = new Date();
      await this.orders.applyStatusTransition(
        tx,
        order,
        "DELIVERED",
        {
          ...actor,
          custody: { status: "WITH_CUSTOMER", driverId: null },
        },
        now,
      );
      await tx`
        update order_driver_assignments set status = 'COMPLETED',
          completed_at = ${now}, updated_at = ${now}
        where id = ${assignment.id}`;
      const eventId = await insertOrderEvent(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        eventType: "ORDER_DELIVERED",
        fromOrderStatus: order.status,
        toOrderStatus: "DELIVERED",
        fromCustodyStatus: order.custody_status,
        toCustodyStatus: "WITH_CUSTOMER",
        proofId,
        metadata: input.note ? { note: input.note } : null,
        createdAt: now,
      });
      if (proofId)
        await tx`update order_proofs set consumed_at = ${now},
          consumed_by_event_id = ${eventId} where id = ${proofId}`;
      await insertCustodyHistory(tx, {
        ...actor,
        orderId,
        assignmentId: assignment.id,
        fromStatus: order.custody_status,
        toStatus: "WITH_CUSTOMER",
        fromDriverId: assignment.driver_id,
        toDriverId: null,
        createdAt: now,
      });
      const revision = await bumpDriverRuntimeRevision(tx, assignment.driver_id);
      const jobId = await enqueueDriverRuntimeRecon(tx, {
        driverId: assignment.driver_id,
        expectedRevision: revision,
        cityId,
      });
      const response = await this.dto(orderId, cityId, tx);
      await completeOrderCommandIdempotency(tx, {
        ...idempotency, httpStatus: 200, payload: response,
      });
      return { response, driverId: assignment.driver_id, revision, jobId };
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });
    if (this.runtime && committed.driverId && committed.revision != null && committed.jobId) {
      const driverId = committed.driverId;
      await applyRedisAfterCommit({
        client: this.client,
        jobIds: [committed.jobId],
        ...(this.logger ? { logger: this.logger } : {}),
        event: "order_delivery_runtime_update_failed",
        apply: async () => {
          const current = await this.runtime!.getRuntime(driverId);
          const [count] = await this.client<{ count: number }[]>`
            select count(*)::int count from order_driver_assignments
            where driver_id = ${driverId}
              and completed_at is null and cancelled_at is null`;
          const activeOrderCount = count?.count ?? 0;
          if (!current) {
            await this.runtime!.invalidateRuntime(driverId);
            return;
          }
          const workStatus: DriverWorkStatus =
            activeOrderCount > 0
              ? "BUSY"
              : current.workStatus === "OFFLINE"
                ? "OFFLINE"
                : "AVAILABLE";
          await this.runtime!.setRuntime({
            ...current,
            activeOrderCount,
            workStatus,
            revision: committed.revision!,
            updatedAt: new Date().toISOString(),
          });
        },
      });
    }
    return committed.response;
  }

  async getDriverActiveAssignment(identity: AuthIdentity) {
    const { driverId, cityId } = requireTrustedDriverCity(identity);
    const [row] = await this.client<Record<string, unknown>[]>`
      select a.id::text assignment_id, a.status::text assignment_status,
             a.driver_fee, a.assigned_at, a.picked_up_at, a.arrived_at_customer_at,
             o.id::text order_id, o.order_number, o.status::text order_status,
             o.custody_status::text, o.custody_driver_id::text,
             o.store_id::text, o.products_subtotal, o.delivery_fee, o.total
      from order_driver_assignments a
      join orders o on o.id = a.order_id
      where a.driver_id = ${driverId} and a.city_id = ${cityId}
        and a.completed_at is null and a.cancelled_at is null
      order by a.assigned_at desc limit 1`;
    if (!row)
      throw new AppError(
        404,
        "DRIVER_ASSIGNMENT_REQUIRED",
        "An active driver assignment is required",
      );
    return {
      assignmentId: row.assignment_id,
      assignmentStatus: row.assignment_status,
      driverFee: Number(row.driver_fee),
      assignedAt: dateValue(row.assigned_at),
      pickedUpAt: dateValue(row.picked_up_at),
      arrivedAtCustomerAt: dateValue(row.arrived_at_customer_at),
      order: {
        id: row.order_id,
        orderNumber: row.order_number,
        status: row.order_status,
        custodyStatus: row.custody_status,
        custodyDriverId: row.custody_driver_id,
        storeId: row.store_id,
        productsSubtotal: Number(row.products_subtotal),
        deliveryFee: Number(row.delivery_fee),
        total: Number(row.total),
      },
    };
  }
}
