import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { normalizeEmail } from "../shared/normalization";
import type { Argon2PasswordHasher } from "./password";
import type { AuthIdentity } from "../sessions/session-service";
import { requireCityAdmin, requireSuperAdmin } from "./authorization";
import { assertActiveCity } from "./dashboard-scope";
import {
  isEmployeeRoleCode,
  isGrantablePermissionCode,
  type EmployeeRoleCode,
  type GrantablePermissionCode,
} from "./permissions";

const cleanName = (value: string, field: string) => {
  const result = value.trim();
  if (!result)
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return result;
};

export class StaffOrganizationService {
  constructor(
    private client: SQL,
    private password: Argon2PasswordHasher,
  ) {}

  private async revokeAccounts(tx: SQL, accountIds: string[], reason: string) {
    if (!accountIds.length) return;
    await tx`update sessions set revoked_at=now(),revocation_reason=${reason},updated_at=now() where account_id in ${tx(accountIds)} and application_type='DASHBOARD' and revoked_at is null`;
  }

  private adminDto(row: Record<string, unknown>): any {
    return {
      accountId: row.account_id,
      email: row.email_normalized,
      displayName: row.display_name ?? null,
      status: row.staff_status,
      cityId: row.city_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }

  private employeeDto(row: Record<string, unknown>): any {
    const asList = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === "string") {
        const trimmed = value.replace(/^\{|\}$/g, "");
        if (!trimmed) return [];
        return trimmed.split(",").map((part) => part.replaceAll('"', "").trim());
      }
      return [];
    };
    return {
      accountId: row.account_id,
      email: row.email_normalized,
      displayName: row.display_name ?? null,
      status: row.staff_status,
      roles: asList(row.roles),
      permissions: asList(row.permissions),
      cityId: row.city_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }

  async createAdmin(
    identity: AuthIdentity,
    input: {
      email: string;
      password: string;
      cityId: string;
      displayName?: string;
    },
  ) {
    requireSuperAdmin(identity);
    const email = normalizeEmail(input.email);
    if (input.password.length < 12)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid password");
    await assertActiveCity(this.client, input.cityId);
    const hash = await this.password.hash(input.password);
    return this.client.begin(async (tx) => {
      const [existing] = await tx<
        { id: string }[]
      >`select account_id as id from account_emails where email_normalized=${email}`;
      if (existing)
        throw new AppError(409, "EMAIL_ALREADY_USED", "Email already used");
      const [account] = await tx<
        { id: string }[]
      >`insert into accounts default values returning id`;
      await tx`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${account!.id},${email},${email},now(),true)`;
      await tx`insert into staff_profiles(account_id,status,display_name,managed_by_account_id)values(${account!.id},'ACTIVE',${input.displayName === undefined ? null : cleanName(input.displayName, "display name")},null)`;
      await tx`insert into password_credentials(account_id,argon2id_hash)values(${account!.id},${hash})`;
      const [role] = await tx<
        { id: string }[]
      >`select id from roles where code='ADMIN' and status='ACTIVE'`;
      const [accountRole] = await tx<
        { id: string }[]
      >`insert into account_roles(account_id,role_id,granted_by_account_id,reason)values(${account!.id},${role!.id},${identity.accountId},'ADMIN_CREATED') returning id`;
      await tx`insert into account_role_scopes(account_role_id,scope_type,scope_reference_id,created_by_account_id)values(${accountRole!.id},'CITY',${input.cityId},${identity.accountId})`;
      return this.getAdmin(identity, account!.id, tx);
    });
  }

  async listAdmins(identity: AuthIdentity) {
    requireSuperAdmin(identity);
    const rows = await this.client<Record<string, unknown>[]>`
      select a.id as account_id, e.email_normalized, sp.display_name, sp.status as staff_status,
        s.scope_reference_id::text as city_id, sp.created_at, sp.updated_at
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join roles r on r.id = ar.role_id and r.code = 'ADMIN'
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where sp.managed_by_account_id is null
      order by e.email_normalized asc, a.id asc`;
    return { data: rows.map((row) => this.adminDto(row)) };
  }

  async getAdmin(identity: AuthIdentity, adminId: string, client: SQL = this.client) {
    requireSuperAdmin(identity);
    const [row] = await client<Record<string, unknown>[]>`
      select a.id as account_id, e.email_normalized, sp.display_name, sp.status as staff_status,
        s.scope_reference_id::text as city_id, sp.created_at, sp.updated_at
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join roles r on r.id = ar.role_id and r.code = 'ADMIN'
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where a.id = ${adminId} and sp.managed_by_account_id is null`;
    if (!row) throw new AppError(404, "ADMIN_NOT_FOUND", "Admin not found");
    return this.adminDto(row);
  }

  async updateAdmin(
    identity: AuthIdentity,
    adminId: string,
    input: { displayName?: string; cityId?: string; status?: "ACTIVE" | "DISABLED" },
  ) {
    requireSuperAdmin(identity);
    if (Object.keys(input).length === 0)
      throw new AppError(422, "VALIDATION_FAILED", "At least one field is required");
    return this.client.begin(async (tx) => {
      const [current] = await tx<
        {
          account_id: string;
          city_id: string;
          staff_status: string;
        }[]
      >`select a.id as account_id, s.scope_reference_id::text as city_id, sp.status as staff_status
        from staff_profiles sp
        join accounts a on a.id = sp.account_id
        join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
        join roles r on r.id = ar.role_id and r.code = 'ADMIN'
        join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
        where a.id = ${adminId} and sp.managed_by_account_id is null
        for update of sp`;
      if (!current) throw new AppError(404, "ADMIN_NOT_FOUND", "Admin not found");

      if (input.displayName !== undefined) {
        await tx`update staff_profiles set display_name=${cleanName(input.displayName, "display name")},updated_at=now() where account_id=${adminId}`;
      }
      if (input.status !== undefined && input.status !== current.staff_status) {
        await tx`update staff_profiles set status=${input.status}::staff_profile_status,status_changed_at=now(),updated_at=now() where account_id=${adminId}`;
        const employees = await tx<
          { account_id: string }[]
        >`select account_id from staff_profiles where managed_by_account_id=${adminId} for update`;
        if (input.status === "DISABLED") {
          if (employees.length)
            await tx`update staff_profiles set status='DISABLED',status_changed_at=now(),updated_at=now() where managed_by_account_id=${adminId}`;
          await this.revokeAccounts(
            tx,
            [adminId, ...employees.map((row) => row.account_id)],
            "ADMIN_DISABLED",
          );
        }
      }
      if (input.cityId !== undefined && input.cityId !== current.city_id) {
        await assertActiveCity(tx, input.cityId);
        await tx`update account_role_scopes set scope_reference_id=${input.cityId}
          where account_role_id = (
            select ar.id from account_roles ar
            join roles r on r.id = ar.role_id
            where ar.account_id = ${adminId} and ar.revoked_at is null and r.code = 'ADMIN'
          ) and scope_type = 'CITY'`;
        const employees = await tx<
          { account_id: string }[]
        >`select account_id from staff_profiles where managed_by_account_id=${adminId}`;
        for (const employee of employees) {
          await tx`update account_role_scopes set scope_reference_id=${input.cityId}
            where account_role_id in (
              select ar.id from account_roles ar
              where ar.account_id = ${employee.account_id} and ar.revoked_at is null
            ) and scope_type = 'CITY'`;
        }
        await this.revokeAccounts(
          tx,
          [adminId, ...employees.map((row) => row.account_id)],
          "ADMIN_CITY_CHANGED",
        );
      }
      return this.getAdmin(identity, adminId, tx);
    });
  }

  async createEmployee(
    identity: AuthIdentity,
    input: {
      email: string;
      password: string;
      role: EmployeeRoleCode;
      displayName?: string;
    },
  ) {
    const cityId = requireCityAdmin(identity);
    if (!isEmployeeRoleCode(input.role))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid role code");
    const email = normalizeEmail(input.email);
    if (input.password.length < 12)
      throw new AppError(422, "VALIDATION_FAILED", "Invalid password");
    const hash = await this.password.hash(input.password);
    return this.client.begin(async (tx) => {
      const [existing] = await tx<
        { id: string }[]
      >`select account_id as id from account_emails where email_normalized=${email}`;
      if (existing)
        throw new AppError(409, "EMAIL_ALREADY_USED", "Email already used");
      const [account] = await tx<
        { id: string }[]
      >`insert into accounts default values returning id`;
      await tx`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${account!.id},${email},${email},now(),true)`;
      await tx`insert into staff_profiles(account_id,status,display_name,managed_by_account_id)values(${account!.id},'ACTIVE',${input.displayName === undefined ? null : cleanName(input.displayName, "display name")},${identity.accountId})`;
      await tx`insert into password_credentials(account_id,argon2id_hash)values(${account!.id},${hash})`;
      const [role] = await tx<
        { id: string }[]
      >`select id from roles where code=${input.role}::staff_role_code and status='ACTIVE'`;
      const [accountRole] = await tx<
        { id: string }[]
      >`insert into account_roles(account_id,role_id,granted_by_account_id,reason)values(${account!.id},${role!.id},${identity.accountId},'EMPLOYEE_CREATED') returning id`;
      await tx`insert into account_role_scopes(account_role_id,scope_type,scope_reference_id,created_by_account_id)values(${accountRole!.id},'CITY',${cityId},${identity.accountId})`;
      return this.getOwnedEmployee(identity, account!.id, tx);
    });
  }

  async listEmployees(identity: AuthIdentity) {
    requireCityAdmin(identity);
    const rows = await this.client<Record<string, unknown>[]>`
      select a.id as account_id, e.email_normalized, sp.display_name, sp.status as staff_status,
        s.scope_reference_id::text as city_id, sp.created_at, sp.updated_at,
        coalesce((select array_agg(r2.code::text order by r2.code) from account_roles ar2 join roles r2 on r2.id=ar2.role_id where ar2.account_id=a.id and ar2.revoked_at is null), '{}') as roles,
        coalesce((select array_agg(p.code order by p.code) from account_permission_grants g join permissions p on p.id=g.permission_id where g.account_id=a.id and g.revoked_at is null), '{}') as permissions
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where sp.managed_by_account_id = ${identity.accountId}
      order by e.email_normalized asc, a.id asc`;
    return { data: rows.map((row) => this.employeeDto(row)) };
  }

  private async getOwnedEmployee(
    identity: AuthIdentity,
    employeeId: string,
    client: SQL = this.client,
  ) {
    requireCityAdmin(identity);
    const [row] = await client<Record<string, unknown>[]>`
      select a.id as account_id, e.email_normalized, sp.display_name, sp.status as staff_status,
        s.scope_reference_id::text as city_id, sp.created_at, sp.updated_at,
        coalesce((select array_agg(r2.code::text order by r2.code) from account_roles ar2 join roles r2 on r2.id=ar2.role_id where ar2.account_id=a.id and ar2.revoked_at is null), '{}') as roles,
        coalesce((select array_agg(p.code order by p.code) from account_permission_grants g join permissions p on p.id=g.permission_id where g.account_id=a.id and g.revoked_at is null), '{}') as permissions
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where a.id = ${employeeId} and sp.managed_by_account_id = ${identity.accountId}`;
    if (!row)
      throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
    return this.employeeDto(row);
  }

  async getEmployee(identity: AuthIdentity, employeeId: string) {
    return this.getOwnedEmployee(identity, employeeId);
  }

  async updateEmployee(
    identity: AuthIdentity,
    employeeId: string,
    input: { displayName?: string; status?: "ACTIVE" | "DISABLED" },
  ) {
    requireCityAdmin(identity);
    if (Object.keys(input).length === 0)
      throw new AppError(422, "VALIDATION_FAILED", "At least one field is required");
    return this.client.begin(async (tx) => {
      const [current] = await tx<
        { account_id: string; staff_status: string }[]
      >`select account_id, status as staff_status from staff_profiles where account_id=${employeeId} and managed_by_account_id=${identity.accountId} for update`;
      if (!current)
        throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
      if (input.displayName !== undefined)
        await tx`update staff_profiles set display_name=${cleanName(input.displayName, "display name")},updated_at=now() where account_id=${employeeId}`;
      if (input.status !== undefined && input.status !== current.staff_status) {
        await tx`update staff_profiles set status=${input.status}::staff_profile_status,status_changed_at=now(),updated_at=now() where account_id=${employeeId}`;
        if (input.status === "DISABLED")
          await this.revokeAccounts(tx, [employeeId], "EMPLOYEE_DISABLED");
      }
      return this.getOwnedEmployee(identity, employeeId, tx);
    });
  }

  async grantEmployeePermission(
    identity: AuthIdentity,
    employeeId: string,
    permission: string,
  ) {
    requireCityAdmin(identity);
    if (!isGrantablePermissionCode(permission))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid permission");
    return this.client.begin(async (tx) => {
      const [employee] = await tx<
        { account_id: string }[]
      >`select account_id from staff_profiles where account_id=${employeeId} and managed_by_account_id=${identity.accountId} for update`;
      if (!employee)
        throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
      const [perm] = await tx<
        { id: string }[]
      >`select id from permissions where code=${permission} and status='ACTIVE'`;
      if (!perm)
        throw new AppError(422, "VALIDATION_FAILED", "Invalid permission");
      const [existing] = await tx<
        { id: string }[]
      >`select id from account_permission_grants where account_id=${employeeId} and permission_id=${perm.id} and revoked_at is null`;
      if (!existing) {
        await tx`insert into account_permission_grants(account_id,permission_id,granted_by_account_id)values(${employeeId},${perm.id},${identity.accountId})`;
      }
      return this.getOwnedEmployee(identity, employeeId, tx);
    });
  }

  async revokeEmployeePermission(
    identity: AuthIdentity,
    employeeId: string,
    permission: GrantablePermissionCode | string,
  ) {
    requireCityAdmin(identity);
    if (!isGrantablePermissionCode(permission))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid permission");
    return this.client.begin(async (tx) => {
      const [employee] = await tx<
        { account_id: string }[]
      >`select account_id from staff_profiles where account_id=${employeeId} and managed_by_account_id=${identity.accountId} for update`;
      if (!employee)
        throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found");
      await tx`update account_permission_grants g
        set revoked_at=now(),revoked_by_account_id=${identity.accountId},updated_at=now()
        from permissions p
        where g.permission_id = p.id
          and g.account_id = ${employeeId}
          and p.code = ${permission}
          and g.revoked_at is null`;
      return this.getOwnedEmployee(identity, employeeId, tx);
    });
  }
}
