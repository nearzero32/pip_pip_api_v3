import { AppError } from "../../errors/app-error";

export const ORDER_STATUSES = [
  "PENDING_STORE_APPROVAL",
  "APPROVED_BY_STORE",
  "SEARCHING_DRIVER",
  "DRIVER_ASSIGNED",
  "READY_FOR_PICKUP",
  "ARRIVED_AT_STORE",
  "ACCEPTED_BY_DRIVER",
  "PICKED_UP",
  "ARRIVED_AT_CUSTOMER",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Natural forward-only happy path + cancel.
 * C2-only transitions (reoffer skip-to-ready, handoff arrival reset, reopen,
 * operational return back to store) live in OPS_ALLOWED and require
 * assertOpsTransition / applyOpsStatusTransition.
 */
const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_STORE_APPROVAL: ["SEARCHING_DRIVER", "CANCELLED"],
  APPROVED_BY_STORE: ["SEARCHING_DRIVER", "CANCELLED"],
  SEARCHING_DRIVER: ["DRIVER_ASSIGNED", "CANCELLED"],
  DRIVER_ASSIGNED: ["READY_FOR_PICKUP", "ARRIVED_AT_STORE", "CANCELLED"],
  READY_FOR_PICKUP: ["ARRIVED_AT_STORE", "CANCELLED"],
  ARRIVED_AT_STORE: ["PICKED_UP", "CANCELLED"],
  ACCEPTED_BY_DRIVER: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["ARRIVED_AT_CUSTOMER", "CANCELLED"],
  ARRIVED_AT_CUSTOMER: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

/**
 * Restricted transitions used only by M4-C2/ops command paths.
 * Not reachable via merchant mark-ready, driver arrival/delivery, or generic APIs.
 */
const OPS_ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_STORE_APPROVAL: [],
  APPROVED_BY_STORE: [],
  SEARCHING_DRIVER: ["READY_FOR_PICKUP"],
  DRIVER_ASSIGNED: ["SEARCHING_DRIVER"],
  READY_FOR_PICKUP: [
    "SEARCHING_DRIVER",
    "PENDING_STORE_APPROVAL",
    "DRIVER_ASSIGNED",
  ],
  ARRIVED_AT_STORE: [
    "SEARCHING_DRIVER",
    "DRIVER_ASSIGNED",
    "READY_FOR_PICKUP",
  ],
  ACCEPTED_BY_DRIVER: [],
  PICKED_UP: ["READY_FOR_PICKUP", "PENDING_STORE_APPROVAL", "SEARCHING_DRIVER"],
  ARRIVED_AT_CUSTOMER: [
    "PICKED_UP",
    "READY_FOR_PICKUP",
    "PENDING_STORE_APPROVAL",
    "SEARCHING_DRIVER",
  ],
  DELIVERED: [],
  CANCELLED: [
    "PENDING_STORE_APPROVAL",
    "SEARCHING_DRIVER",
    "DRIVER_ASSIGNED",
    "READY_FOR_PICKUP",
  ],
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

/** Ops/admin/command-specific transitions (not part of natural app flows). */
export const assertOpsTransition = (from: OrderStatus, to: OrderStatus) => {
  if (ALLOWED[from].includes(to) || OPS_ALLOWED[from].includes(to)) return;
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
  status === "DRIVER_ASSIGNED" || status === "ARRIVED_AT_STORE";

export const mayConfirmArrivalAtStore = (status: OrderStatus) =>
  status === "DRIVER_ASSIGNED" || status === "READY_FOR_PICKUP";

export const mayConfirmPickup = (status: OrderStatus) =>
  status === "ARRIVED_AT_STORE";

export const mayConfirmArrival = (status: OrderStatus) =>
  status === "PICKED_UP";

export const mayConfirmDelivery = (status: OrderStatus) =>
  status === "ARRIVED_AT_CUSTOMER";
