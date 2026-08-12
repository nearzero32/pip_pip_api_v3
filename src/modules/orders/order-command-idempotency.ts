import { createHash } from "crypto";
import { AppError } from "../../errors/app-error";
import {
  abortOfferIdempotency,
  beginOfferIdempotency,
  completeOfferIdempotency,
} from "../driver-offers/offer-idempotency";

/**
 * Reuses `offer_idempotency_keys` for order lifecycle commands.
 * Scope strings isolate commands; uniqueness is (scope, actor, city, key).
 */
export const beginOrderCommandIdempotency = beginOfferIdempotency;
export const completeOrderCommandIdempotency = completeOfferIdempotency;
export const abortOrderCommandIdempotency = abortOfferIdempotency;

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) out[key] = sortKeysDeep(nested);
    return out;
  }
  return value;
};

export const hashOrderCommandPayload = (payload: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(payload)))
    .digest("hex");

export const requireOrderIdempotencyKey = (
  idempotencyKey: string | null | undefined,
) => {
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!key)
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "Idempotency-Key header is required",
    );
  if (key.length > 128)
    throw new AppError(422, "VALIDATION_FAILED", "Idempotency-Key is too long");
  return key;
};

export const ORDER_COMMAND_SCOPES = {
  approve: "v1:orders.approve",
  markReady: "v1:orders.mark-ready",
  confirmPickup: "v1:orders.confirm-pickup",
  confirmArrival: "v1:orders.confirm-arrival",
  confirmDelivery: "v1:orders.confirm-delivery",
  itemAdd: "v1:orders.items.add",
  itemRemove: "v1:orders.items.remove",
  itemReplace: "v1:orders.items.replace",
  itemQuantity: "v1:orders.items.quantity",
  removeDriver: "v1:orders.remove-driver",
  reoffer: "v1:orders.reoffer",
  assignReplacement: "v1:orders.assign-replacement",
  startHandoff: "v1:orders.handoff.start",
  cancelHandoff: "v1:orders.handoff.cancel",
  completeHandoff: "v1:orders.handoff.complete",
  cancelOrder: "v1:orders.cancel",
  startReturn: "v1:orders.return.start",
  confirmDriverReturn: "v1:orders.return.driver-confirm",
  confirmStoreReturn: "v1:orders.return.store-confirm",
  reopenOrder: "v1:orders.reopen",
} as const;
