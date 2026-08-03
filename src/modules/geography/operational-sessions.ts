import type { SQL } from "bun";
import type { SessionService } from "../auth/sessions/session-service";

/**
 * Revoke Dashboard sessions for every ADMIN scoped to the given Cities and
 * every employee owned by those ADMINs. SUPER_ADMIN (GLOBAL scope) is never selected.
 */
export async function revokeDashboardSessionsForCities(
  sessions: SessionService,
  tx: SQL,
  cityIds: string[],
  reason: string,
): Promise<void> {
  if (!cityIds.length) return;
  const rows = await tx<{ account_id: string }[]>`
    with city_admins as (
      select distinct ar.account_id as admin_id
      from account_roles ar
      join roles r on r.id = ar.role_id and r.code = 'ADMIN'
      join account_role_scopes s
        on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where ar.revoked_at is null
        and s.scope_reference_id in ${tx(cityIds)}
    )
    select admin_id::text as account_id from city_admins
    union
    select sp.account_id::text as account_id
    from staff_profiles sp
    join city_admins ca on ca.admin_id = sp.managed_by_account_id`;
  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  await sessions.revokeDashboardSessionsForAccounts(tx, accountIds, reason);
}
