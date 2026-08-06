import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { assertActiveCity } from "../staff/dashboard-scope";
import type { AuthIdentity } from "../sessions/session-service";

/**
 * City/Store scope for Merchant catalog and Store operations.
 * Never trusts client-supplied storeId as authorization — mismatches are hidden.
 */
export async function authorizeMerchantStoreScope(
  client: SQL,
  identity: AuthIdentity,
  storeId?: string,
): Promise<string> {
  if (identity.applicationType !== "MERCHANT_APP") {
    throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  }
  if (!identity.cityId || !identity.storeId) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (storeId !== undefined && storeId !== identity.storeId) {
    throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
  }
  await assertActiveCity(client, identity.cityId);
  return identity.cityId;
}

export function requireTrustedMerchantStore(identity: AuthIdentity): {
  cityId: string;
  storeId: string;
} {
  if (
    identity.applicationType !== "MERCHANT_APP" ||
    !identity.cityId ||
    !identity.storeId
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  return { cityId: identity.cityId, storeId: identity.storeId };
}
