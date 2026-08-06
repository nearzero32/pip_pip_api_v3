import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";

export type TrustedMerchantContext = {
  storeId: string;
  cityId: string;
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  displayName: string | null;
};

/** Trusted Merchant Store/City from merchant_profiles — never from the client. */
export async function loadTrustedMerchantContext(
  client: SQL,
  accountId: string,
): Promise<TrustedMerchantContext> {
  const [row] = await client<
    {
      store_id: string;
      city_id: string;
      status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
      display_name: string | null;
    }[]
  >`select
      store_id::text as store_id,
      city_id::text as city_id,
      status::text as status,
      display_name
    from merchant_profiles
    where account_id = ${accountId}`;
  if (!row) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (row.status !== "ACTIVE") {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  return {
    storeId: row.store_id,
    cityId: row.city_id,
    status: row.status,
    displayName: row.display_name,
  };
}
