import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { AuthIdentity } from "../sessions/session-service";
import {
  isGrantablePermissionCode,
  type GrantablePermissionCode,
} from "./permissions";

export const requireSuperAdmin = (identity: AuthIdentity): void => {
  if (
    identity.applicationType !== "DASHBOARD" ||
    !identity.roles.includes("SUPER_ADMIN") ||
    identity.scopeType !== "GLOBAL" ||
    identity.cityId !== null
  ) {
    throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  }
};

export const requireCityAdmin = (identity: AuthIdentity): string => {
  if (
    identity.applicationType !== "DASHBOARD" ||
    !identity.roles.includes("ADMIN") ||
    identity.scopeType !== "CITY" ||
    !identity.cityId
  ) {
    throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  }
  return identity.cityId;
};

/**
 * City-operational authorization.
 * ADMIN is allowed inside its signed City.
 * Employees require an active DB permission grant.
 * SUPER_ADMIN is never allowed.
 */
export const requireCityPermission = async (
  client: SQL,
  identity: AuthIdentity,
  permission: GrantablePermissionCode | string,
): Promise<string> => {
  if (!isGrantablePermissionCode(permission))
    throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  if (
    identity.applicationType !== "DASHBOARD" ||
    identity.scopeType !== "CITY" ||
    !identity.cityId ||
    identity.roles.includes("SUPER_ADMIN")
  ) {
    throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  }
  if (identity.roles.includes("ADMIN")) return identity.cityId;

  const [grant] = await client<
    { id: string }[]
  >`select g.id from account_permission_grants g
    join permissions p on p.id = g.permission_id
    where g.account_id = ${identity.accountId}
      and g.revoked_at is null
      and p.code = ${permission}
      and p.status = 'ACTIVE'
    limit 1`;
  if (!grant) throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
  return identity.cityId;
};

/** Export requires the matching read permission plus a dedicated export grant. ADMIN bypasses both. */
export const requireCityReadAndExport = async (
  client: SQL,
  identity: AuthIdentity,
  readPermission: GrantablePermissionCode | string,
  exportPermission: GrantablePermissionCode | string,
): Promise<string> => {
  await requireCityPermission(client, identity, readPermission);
  return requireCityPermission(client, identity, exportPermission);
};
