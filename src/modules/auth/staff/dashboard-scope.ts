import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { isCityOperational } from "../../geography/geography-locks";
import type { DashboardScopeClaims } from "../tokens/access-token";
import { isEmployeeRoleCode } from "./permissions";

export type TrustedDashboardContext = {
  roles: string[];
} & DashboardScopeClaims;

type ScopeRow = {
  role_code: string;
  account_role_id: string;
  scope_type: "GLOBAL" | "CITY" | null;
  city_id: string | null;
  city_status: string | null;
  governorate_status: string | null;
  managed_by_account_id: string | null;
};

/**
 * Reconstructs trusted Dashboard roles and City/Global scope from current DB state.
 * Used by login and refresh — never copies stale claims from a prior token.
 */
export async function loadTrustedDashboardContext(
  client: SQL,
  accountId: string,
): Promise<TrustedDashboardContext> {
  const rows = await client<ScopeRow[]>`
    select
      r.code::text as role_code,
      ar.id as account_role_id,
      s.scope_type::text as scope_type,
      s.scope_reference_id::text as city_id,
      c.status::text as city_status,
      g.status::text as governorate_status,
      sp.managed_by_account_id::text as managed_by_account_id
    from account_roles ar
    join roles r on r.id = ar.role_id
    left join account_role_scopes s on s.account_role_id = ar.id
    left join cities c on c.id = s.scope_reference_id
    left join governorates g on g.id = c.governorate_id
    left join staff_profiles sp on sp.account_id = ar.account_id
    where ar.account_id = ${accountId}
      and ar.revoked_at is null
      and r.status = 'ACTIVE'
      and ar.valid_from <= now()
      and (ar.valid_until is null or ar.valid_until > now())
    order by r.code, s.scope_type
  `;
  if (!rows.length)
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const roles = [...new Set(rows.map((row) => row.role_code))];
  const hasSuper = roles.includes("SUPER_ADMIN");
  const hasAdmin = roles.includes("ADMIN");
  const employeeRoles = roles.filter(isEmployeeRoleCode);

  if (hasSuper) {
    if (roles.length !== 1 || hasAdmin || employeeRoles.length)
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    const global = rows.filter((row) => row.scope_type === "GLOBAL");
    const city = rows.filter((row) => row.scope_type === "CITY");
    if (global.length !== 1 || city.length)
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    return { roles, scopeType: "GLOBAL", cityId: null };
  }

  if (hasAdmin) {
    if (employeeRoles.length || roles.some((role) => role !== "ADMIN"))
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    if (rows[0]?.managed_by_account_id)
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    const cityScopes = rows.filter((row) => row.scope_type === "CITY");
    if (cityScopes.length !== 1)
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    const city = cityScopes[0]!;
    if (
      !city.city_id ||
      city.city_status !== "ACTIVE" ||
      city.governorate_status !== "ACTIVE"
    )
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    return { roles, scopeType: "CITY", cityId: city.city_id };
  }

  if (!employeeRoles.length)
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  if (roles.some((role) => !isEmployeeRoleCode(role)))
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const managedBy = rows[0]?.managed_by_account_id;
  if (!managedBy)
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const cityScopes = rows.filter((row) => row.scope_type === "CITY");
  const cityIds = [...new Set(cityScopes.map((row) => row.city_id).filter(Boolean))];
  if (cityIds.length !== 1)
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  const cityId = cityIds[0]!;
  const sample = cityScopes.find((row) => row.city_id === cityId)!;
  if (
    sample.city_status !== "ACTIVE" ||
    sample.governorate_status !== "ACTIVE"
  )
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const [owner] = await client<
    { city_id: string }[]
  >`select s.scope_reference_id::text as city_id
    from account_roles ar
    join roles r on r.id = ar.role_id
    join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
    where ar.account_id = ${managedBy}
      and ar.revoked_at is null
      and r.code = 'ADMIN'
      and r.status = 'ACTIVE'
      and ar.valid_from <= now()
      and (ar.valid_until is null or ar.valid_until > now())`;
  if (!owner || owner.city_id !== cityId)
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  return { roles, scopeType: "CITY", cityId };
}

/**
 * Authoritative City operability for City-scoped dashboard operations (e.g. Zones).
 * Requires the trusted City row to exist with status ACTIVE and its parent
 * Governorate status ACTIVE. Uses only a server-trusted cityId — never request input.
 *
 * Errors: CITY_NOT_FOUND (404), CITY_NOT_ACTIVE (409).
 */
export async function assertActiveCity(
  client: SQL,
  cityId: string,
): Promise<void> {
  const [row] = await client<
    { city_status: string; governorate_status: string }[]
  >`select c.status::text as city_status, g.status::text as governorate_status
    from cities c
    join governorates g on g.id = c.governorate_id
    where c.id = ${cityId}`;
  if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
  if (!isCityOperational(row.city_status, row.governorate_status))
    throw new AppError(409, "CITY_NOT_ACTIVE", "City is not active");
}
