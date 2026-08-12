import type { SQL } from "bun";
import type { OrderStatus } from "./order-state-machine";

export type OrderActor = {
  accountId: string | null;
  actorType: "CUSTOMER" | "MERCHANT" | "STAFF" | "SYSTEM" | "DRIVER";
  source:
    | "CUSTOMER_APP"
    | "MERCHANT_APP"
    | "DASHBOARD"
    | "DASHBOARD_OVERRIDE"
    | "SYSTEM"
    | "DRIVER_APP";
  actedOnBehalfOf?: "STORE" | "DRIVER" | null;
  reason?: string | null;
};

export type OrderEventType =
  | "ORDER_CREATED"
  | "ORDER_ITEM_ADDED"
  | "ORDER_ITEM_REMOVED"
  | "ORDER_ITEM_REPLACED"
  | "ORDER_ITEM_QUANTITY_CHANGED"
  | "STORE_APPROVED"
  | "DRIVER_ASSIGNED"
  | "STORE_MARKED_READY"
  | "DRIVER_PICKED_UP"
  | "DRIVER_ARRIVED_AT_CUSTOMER"
  | "ORDER_DELIVERED"
  | "DRIVER_REMOVAL_REQUESTED"
  | "DRIVER_REMOVED_BEFORE_PICKUP"
  | "ORDER_REOFFERED"
  | "DRIVER_MANUALLY_ASSIGNED"
  | "HANDOFF_STARTED"
  | "HANDOFF_COMPLETED"
  | "HANDOFF_CANCELLED"
  | "ORDER_CANCELLED_BY_DASHBOARD"
  | "RETURN_STARTED"
  | "DRIVER_RETURN_PROOF_SUBMITTED"
  | "STORE_CONFIRMED_RETURN"
  | "RETURN_COMPLETED"
  | "ORDER_REOPENED";

export async function insertOrderEvent(
  tx: SQL,
  input: OrderActor & {
    orderId: string;
    assignmentId?: string | null;
    handoffId?: string | null;
    returnWorkflowId?: string | null;
    eventType: OrderEventType;
    fromOrderStatus?: OrderStatus | null;
    toOrderStatus?: OrderStatus | null;
    fromCustodyStatus?: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER" | null;
    toCustodyStatus?: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER" | null;
    proofId?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: Date;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into order_events (
      order_id, assignment_id, handoff_id, return_workflow_id, event_type,
      from_order_status, to_order_status, from_custody_status, to_custody_status,
      actor_type, actor_account_id, source, acted_on_behalf_of, reason, proof_id,
      metadata, created_at
    ) values (
      ${input.orderId}, ${input.assignmentId ?? null}, ${input.handoffId ?? null},
      ${input.returnWorkflowId ?? null}, ${input.eventType},
      ${input.fromOrderStatus ?? null}, ${input.toOrderStatus ?? null},
      ${input.fromCustodyStatus ?? null}, ${input.toCustodyStatus ?? null},
      ${input.actorType}, ${input.accountId}, ${input.source},
      ${input.actedOnBehalfOf ?? null}, ${input.reason ?? null},
      ${input.proofId ?? null},
      ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
      ${input.createdAt ?? new Date()}
    ) returning id::text`;
  return row!.id;
}

export async function insertCustodyHistory(
  tx: SQL,
  input: OrderActor & {
    orderId: string;
    assignmentId?: string | null;
    fromStatus: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER" | null;
    toStatus: "WITH_STORE" | "WITH_DRIVER" | "WITH_CUSTOMER";
    fromDriverId?: string | null;
    toDriverId?: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  await tx`
    insert into order_custody_history (
      order_id, assignment_id, from_status, to_status, from_driver_id,
      to_driver_id, actor_account_id, actor_type, source, reason, created_at
    ) values (
      ${input.orderId}, ${input.assignmentId ?? null}, ${input.fromStatus},
      ${input.toStatus}, ${input.fromDriverId ?? null}, ${input.toDriverId ?? null},
      ${input.accountId}, ${input.actorType}, ${input.source},
      ${input.reason ?? null}, ${input.createdAt ?? new Date()}
    )`;
}
