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

export const hashOrderCommandPayload = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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
} as const;
