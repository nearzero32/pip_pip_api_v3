import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { DashboardRoleCode } from "../tokens/access-token";
import { DASHBOARD_ROLE_CODES } from "../tokens/access-token";

export type RoleAssignmentResult = {
  changed: boolean;
  sessionsRevoked: boolean;
};

const isRoleCode = (value: string): value is DashboardRoleCode =>
  (DASHBOARD_ROLE_CODES as readonly string[]).includes(value);

/**
 * Canonical Dashboard role-assignment mutations.
 * Role row changes and Dashboard session revocation always share one transaction.
 * SUPER_ADMIN assignments receive a GLOBAL scope automatically.
 */
export class DashboardRoleService {
  constructor(private client: SQL) {}

  async assignRole(input: {
    accountId: string;
    roleCode: string;
    grantedByAccountId: string;
    reason?: string;
    /** Required for CITY-scoped roles when attaching scope in the same call. */
    cityId?: string;
  }): Promise<RoleAssignmentResult> {
    if (!isRoleCode(input.roleCode))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid role code");
    return this.client.begin(async (tx) => {
      const [role] = await tx<
        { id: string }[]
      >`select id from roles where code=${input.roleCode}::staff_role_code and status='ACTIVE'`;
      if (!role) throw new AppError(422, "VALIDATION_FAILED", "Invalid role code");
      const [existing] = await tx<
        { id: string }[]
      >`select id from account_roles where account_id=${input.accountId} and role_id=${role.id} and revoked_at is null for update`;
      let accountRoleId = existing?.id;
      let changed = false;
      if (!existing) {
        const [inserted] = await tx<
          { id: string }[]
        >`insert into account_roles(account_id,role_id,granted_by_account_id,reason)values(${input.accountId},${role.id},${input.grantedByAccountId},${input.reason ?? null}) returning id`;
        accountRoleId = inserted!.id;
        changed = true;
      }
      if (input.roleCode === "SUPER_ADMIN") {
        await tx`update staff_profiles set managed_by_account_id=null,updated_at=now() where account_id=${input.accountId}`;
        const [scope] = await tx<
          { id: string }[]
        >`select id from account_role_scopes where account_role_id=${accountRoleId!} and scope_type='GLOBAL'`;
        if (!scope) {
          await tx`insert into account_role_scopes(account_role_id,scope_type,scope_reference_id,created_by_account_id)values(${accountRoleId!},'GLOBAL',null,${input.grantedByAccountId})`;
          changed = true;
        }
      } else if (input.cityId) {
        const [scope] = await tx<
          { id: string; scope_reference_id: string }[]
        >`select id,scope_reference_id::text from account_role_scopes where account_role_id=${accountRoleId!} and scope_type='CITY'`;
        if (!scope) {
          await tx`insert into account_role_scopes(account_role_id,scope_type,scope_reference_id,created_by_account_id)values(${accountRoleId!},'CITY',${input.cityId},${input.grantedByAccountId})`;
          changed = true;
        } else if (scope.scope_reference_id !== input.cityId) {
          throw new AppError(
            409,
            "CITY_SCOPE_CONFLICT",
            "Account already has a different City scope",
          );
        }
      }
      if (!changed) return { changed: false, sessionsRevoked: false };
      await this.revokeDashboardSessions(tx, input.accountId);
      return { changed: true, sessionsRevoked: true };
    });
  }

  async revokeRole(input: {
    accountId: string;
    roleCode: string;
    revokedByAccountId: string;
    reason?: string;
  }): Promise<RoleAssignmentResult> {
    if (!isRoleCode(input.roleCode))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid role code");
    return this.client.begin(async (tx) => {
      const [role] = await tx<
        { id: string }[]
      >`select id from roles where code=${input.roleCode}::staff_role_code`;
      if (!role) throw new AppError(422, "VALIDATION_FAILED", "Invalid role code");
      const rows = await tx<{ id: string }[]>`update account_roles set revoked_at=now(),revoked_by_account_id=${input.revokedByAccountId},reason=coalesce(${input.reason ?? null},reason),updated_at=now() where account_id=${input.accountId} and role_id=${role.id} and revoked_at is null returning id`;
      if (!rows.length) return { changed: false, sessionsRevoked: false };
      await this.revokeDashboardSessions(tx, input.accountId);
      return { changed: true, sessionsRevoked: true };
    });
  }

  private async revokeDashboardSessions(tx: SQL, accountId: string) {
    await tx`update sessions set revoked_at=now(),revocation_reason='ROLE_ASSIGNMENT_CHANGED',updated_at=now() where account_id=${accountId} and application_type='DASHBOARD' and revoked_at is null`;
  }
}
