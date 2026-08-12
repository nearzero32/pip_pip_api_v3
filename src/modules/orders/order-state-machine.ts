import { AppError } from "../../errors/app-error";

export const ORDER_STATUSES = [
  "PENDING_STORE_APPROVAL",
  "APPROVED_BY_STORE",
  "SEARCHING_DRIVER",
  "DRIVER_ASSIGNED",
  "READY_FOR_PICKUP",
  "ACCEPTED_BY_DRIVER",
  "PICKED_UP",
  "ARRIVED_AT_CUSTOMER",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * M4-C1 happy path:
 * PENDING_STORE_APPROVAL → SEARCHING_DRIVER → DRIVER_ASSIGNED → READY_FOR_PICKUP
 * → PICKED_UP → ARRIVED_AT_CUSTOMER → DELIVERED
 *
 * Legacy statuses APPROVED_BY_STORE / ACCEPTED_BY_DRIVER remain readable and
 * forward-only so historical rows can still advance.
 */
const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_STORE_APPROVAL: ["SEARCHING_DRIVER", "CANCELLED"],
  APPROVED_BY_STORE: ["SEARCHING_DRIVER", "CANCELLED"],
  SEARCHING_DRIVER: ["DRIVER_ASSIGNED", "CANCELLED"],
  DRIVER_ASSIGNED: ["READY_FOR_PICKUP", "CANCELLED"],
  READY_FOR_PICKUP: ["PICKED_UP", "CANCELLED"],
  ACCEPTED_BY_DRIVER: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["ARRIVED_AT_CUSTOMER", "CANCELLED"],
  ARRIVED_AT_CUSTOMER: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export const isTerminalStatus = (status: OrderStatus) =>
  status === "DELIVERED" || status === "CANCELLED";

export const assertTransition = (from: OrderStatus, to: OrderStatus) => {
  if (!ALLOWED[from].includes(to))
    throw new AppError(
      409,
      "ORDER_INVALID_TRANSITION",
      "Order state transition is not allowed",
    );
};

/** Customer may cancel only while awaiting store approval. */
export const customerMayCancel = (status: OrderStatus) =>
  status === "PENDING_STORE_APPROVAL";

/** Dashboard may cancel any non-terminal state. */
export const dashboardMayCancel = (status: OrderStatus) =>
  !isTerminalStatus(status);

/** Item mutations allowed until store marks ready (lock at READY_FOR_PICKUP). */
export const mayMutateItems = (status: OrderStatus) =>
  status === "PENDING_STORE_APPROVAL" ||
  status === "APPROVED_BY_STORE" ||
  status === "SEARCHING_DRIVER" ||
  status === "DRIVER_ASSIGNED";

/** @deprecated use mayMutateItems */
export const mayReplaceItems = mayMutateItems;

export const mayApprove = (status: OrderStatus) =>
  status === "PENDING_STORE_APPROVAL";

export const mayMarkReady = (status: OrderStatus) =>
  status === "DRIVER_ASSIGNED";

export const mayConfirmPickup = (status: OrderStatus) =>
  status === "READY_FOR_PICKUP" || status === "ACCEPTED_BY_DRIVER";

export const mayConfirmArrival = (status: OrderStatus) =>
  status === "PICKED_UP";

export const mayConfirmDelivery = (status: OrderStatus) =>
  status === "ARRIVED_AT_CUSTOMER";
