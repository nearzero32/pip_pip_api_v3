import type { SQL } from "bun";
import { AppError } from "../../../../errors/app-error";

export type TrustedDriverContext = {
  driverId: string;
  cityId: string;
  approvalStatus: string;
  operationalStatus: string;
};

/** Trusted driver City from driver_profiles — never from the client. */
export async function loadTrustedDriverContext(
  client: SQL,
  accountId: string,
): Promise<TrustedDriverContext> {
  const [row] = await client<
    {
      account_id: string;
      city_id: string | null;
      approval_status: string;
      operational_status: string;
    }[]
  >`select
      account_id::text as account_id,
      city_id::text as city_id,
      approval_status::text as approval_status,
      operational_status::text as operational_status
    from driver_profiles
    where account_id = ${accountId}`;
  if (!row) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (
    row.approval_status !== "APPROVED" ||
    row.operational_status !== "ACTIVE" ||
    !row.city_id
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  return {
    driverId: row.account_id,
    cityId: row.city_id,
    approvalStatus: row.approval_status,
    operationalStatus: row.operational_status,
  };
}

export function requireTrustedDriverCity(identity: {
  applicationType: string;
  cityId: string | null;
  accountId: string;
}): { driverId: string; cityId: string } {
  if (identity.applicationType !== "DRIVER_APP" || !identity.cityId) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  return { driverId: identity.accountId, cityId: identity.cityId };
}
