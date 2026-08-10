import { AppError } from "../../errors/app-error";

export const ORDER_STATUSES = [
  "UNDER_STORE_REVIEW",
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

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  UNDER_STORE_REVIEW: ["APPROVED_BY_STORE", "CANCELLED"],
  APPROVED_BY_STORE: ["SEARCHING_DRIVER", "CANCELLED"],
  SEARCHING_DRIVER: ["DRIVER_ASSIGNED", "CANCELLED"],
  DRIVER_ASSIGNED: ["READY_FOR_PICKUP", "CANCELLED"],
  READY_FOR_PICKUP: ["ACCEPTED_BY_DRIVER", "CANCELLED"],
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
      "ORDER_INVALID_STATE",
      "Order state transition is not allowed",
    );
};

/** Customer may cancel only while UNDER_STORE_REVIEW. */
export const customerMayCancel = (status: OrderStatus) =>
  status === "UNDER_STORE_REVIEW";

/** Dashboard may cancel any non-terminal state. */
export const dashboardMayCancel = (status: OrderStatus) =>
  !isTerminalStatus(status);

export const mayReplaceItems = (status: OrderStatus) =>
  status === "UNDER_STORE_REVIEW";

export const mayApprove = (status: OrderStatus) =>
  status === "UNDER_STORE_REVIEW";
