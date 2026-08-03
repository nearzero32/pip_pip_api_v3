import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { DashboardRoleCode } from "../tokens/access-token";
import { DASHBOARD_ROLE_CODES } from "../tokens/access-token";

export type RoleAssignmentResult = {
  /** True when an assignment row was inserted or revoked. False when the request was a no-op. */
  changed: boolean;
  /**
   * Sessions are revoked only when `changed` is true.
   * Idempotent no-ops (already assigned / already revoked) do not revoke Dashboard sessions.
   */
  sessionsRevoked: boolean;
};

const isRoleCode = (value: string): value is DashboardRoleCode =>
  (DASHBOARD_ROLE_CODES as readonly string[]).includes(value);

/**
 * Canonical Dashboard role-assignment mutations.
 * Role row changes and Dashboard session revocation always share one transaction.
 * Callers must not update `account_roles` directly in application code.
 */
export class DashboardRoleService {
  constructor(private client: SQL) {}

  async assignRole(input: {
    accountId: string;
    roleCode: string;
    grantedByAccountId: string;
    reason?: string;
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
      if (existing) return { changed: false, sessionsRevoked: false };
      await tx`insert into account_roles(account_id,role_id,granted_by_account_id,reason)values(${input.accountId},${role.id},${input.grantedByAccountId},${input.reason ?? null})`;
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
