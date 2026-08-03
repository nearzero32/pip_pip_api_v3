import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { RateLimiter } from "../rate-limit/rate-limiter";
import { rateLimitKey } from "../rate-limit/rate-limiter";
import { randomOpaqueToken } from "../shared/encoding";
import type { HmacSecretVerifier } from "../shared/secret-verifier";
import type { Ed25519AccessTokenService } from "../tokens/access-token";
import type { AuthenticationContext, AuthApplication } from "../core/context";
import type { SecurityAuditWriter } from "../audit/audit-writer";

export type AuthIdentity = {
  accountId: string;
  sessionId: string;
  applicationType: AuthApplication;
  roles: string[];
};
export type SessionResult = {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  session_id: string;
  application_type: AuthApplication;
};
type SessionRow = {
  id: string;
  account_id: string;
  application_type: AuthApplication;
  absolute_expires_at: Date;
  revoked_at: Date | null;
};

export class SessionService {
  constructor(
    private client: SQL,
    private limiter: RateLimiter,
    private verifier: HmacSecretVerifier,
    private tokens: Ed25519AccessTokenService,
    private audit: SecurityAuditWriter,
  ) {}

  async create(
    tx: SQL,
    accountId: string,
    context: AuthenticationContext,
    method: "PHONE_OTP" | "DRIVER_ACCESS_CODE" | "PASSWORD",
    deviceId: string | undefined,
    deviceName: string,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const limit =
      context.applicationType === "CUSTOMER_APP"
        ? 5
        : context.applicationType === "DRIVER_APP"
          ? 1
          : 3;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:${context.applicationType}`},0))`;
    const active = await tx<
      { id: string }[]
    >`select id from sessions where account_id=${accountId} and application_type=${context.applicationType}::application_type and revoked_at is null order by created_at asc,id asc for update`;
    const revokeIds = active
      .slice(0, Math.max(0, active.length - limit + 1))
      .map((row) => row.id);
    if (revokeIds.length)
      await tx`update sessions set revoked_at=now(),revocation_reason='SESSION_LIMIT_REPLACED',updated_at=now() where id in ${tx(revokeIds)}`;
    const sessionId = crypto.randomUUID(),
      refreshToken = randomOpaqueToken(32),
      tokenVerifier = await this.verifier.create(refreshToken);
    await tx`insert into sessions(id,account_id,application_type,authentication_method,device_id,device_name,absolute_expires_at)values(${sessionId},${accountId},${context.applicationType}::application_type,${method}::authentication_method,${deviceId ?? null},${deviceName},now()+interval '30 days')`;
    await tx`insert into session_refresh_tokens(session_id,generation,token_verifier,verifier_key_version)values(${sessionId},0,${tokenVerifier},${this.verifier.keyVersion})`;
    return { sessionId, refreshToken };
  }

  private async loadDashboardRoles(
    client: SQL,
    accountId: string,
  ): Promise<string[]> {
    const rows = await client<
      { code: string }[]
    >`select r.code::text as code from account_roles ar join roles r on r.id=ar.role_id where ar.account_id=${accountId} and ar.revoked_at is null and r.status='ACTIVE' and ar.valid_from<=now() and (ar.valid_until is null or ar.valid_until>now()) order by r.code`;
    return rows.map((row) => row.code);
  }

  async result(
    accountId: string,
    created: { sessionId: string; refreshToken: string },
    context: AuthenticationContext,
  ): Promise<SessionResult> {
    const roles =
      context.applicationType === "DASHBOARD"
        ? await this.loadDashboardRoles(this.client, accountId)
        : [];
    const access = await this.tokens.sign({
      accountId,
      sessionId: created.sessionId,
      applicationType: context.applicationType,
      roles,
    });
    return {
      access_token: access.token,
      access_token_expires_at: new Date(access.expiresAt * 1000).toISOString(),
      refresh_token: created.refreshToken,
      session_id: created.sessionId,
      application_type: context.applicationType,
    };
  }

  private async stateAllowed(client: SQL, row: SessionRow): Promise<boolean> {
    const found =
      await client`select 1 where (${row.application_type}::application_type='CUSTOMER_APP' and exists(select 1 from customer_profiles where account_id=${row.account_id} and status='ACTIVE')) or (${row.application_type}::application_type='DRIVER_APP' and exists(select 1 from driver_profiles where account_id=${row.account_id} and approval_status='APPROVED' and operational_status='ACTIVE')) or (${row.application_type}::application_type='DASHBOARD' and exists(select 1 from staff_profiles where account_id=${row.account_id} and status='ACTIVE') and exists(select 1 from account_roles ar join roles r on r.id=ar.role_id where ar.account_id=${row.account_id} and ar.revoked_at is null and r.status='ACTIVE' and ar.valid_from<=now() and(ar.valid_until is null or ar.valid_until>now())))`;
    return found.length > 0;
  }

  async identify(
    raw: string,
    context: AuthenticationContext,
  ): Promise<AuthIdentity> {
    try {
      const verified = await this.tokens.verify(raw, context.applicationType);
      return {
        accountId: verified.accountId,
        sessionId: verified.sessionId,
        applicationType: verified.applicationType,
        roles: verified.roles,
      };
    } catch {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
  }

  async authenticate(
    raw: string,
    context: AuthenticationContext,
    requestId: string,
  ): Promise<AuthIdentity> {
    const identity = await this.identify(raw, context);
    const [session] = await this.client<
      SessionRow[]
    >`select s.* from sessions s join accounts a on a.id=s.account_id where s.id=${identity.sessionId} and s.account_id=${identity.accountId} and s.application_type=${context.applicationType}::application_type and s.revoked_at is null and s.absolute_expires_at>now() and a.status='ACTIVE'`;
    if (!session || !(await this.stateAllowed(this.client, session))) {
      await this.audit.write({
        event: "AUTHENTICATION_STATE_DENIED",
        outcome: "DENIED",
        requestId,
        accountId: identity.accountId,
        sessionId: identity.sessionId,
        applicationType: context.applicationType,
        reasonCode: "INACTIVE_SECURITY_STATE",
      });
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
    return identity;
  }

  async refresh(
    raw: string,
    context: AuthenticationContext,
    ip: string,
    requestId: string,
  ): Promise<SessionResult> {
    const ipLimit = await this.limiter.consume(
      rateLimitKey(context.namespace, "refresh", "ip", ip),
      { limit: 60, windowSeconds: 300 },
    );
    if (!ipLimit.allowed)
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests",
        ipLimit.retryAfterSeconds,
      );
    const verifier = await this.verifier.create(raw);
    const [candidate] = await this.client<
      { session_id: string; application_type: AuthApplication }[]
    >`select rt.session_id,s.application_type from session_refresh_tokens rt join sessions s on s.id=rt.session_id where rt.token_verifier=${verifier}`;
    if (candidate?.application_type !== context.applicationType)
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh denied");
    const sessionLimit = await this.limiter.consume(
      rateLimitKey(
        context.namespace,
        "refresh",
        "session",
        candidate.session_id,
      ),
      { limit: 30, windowSeconds: 300 },
    );
    if (!sessionLimit.allowed)
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests",
        sessionLimit.retryAfterSeconds,
      );
    let session!: SessionRow,
      successor = "",
      successorId = "",
      reuse = false;
    await this.client.begin(async (tx) => {
      const [token] = await tx<
        {
          id: string;
          session_id: string;
          generation: number;
          rotated_at: Date | null;
          revoked_at: Date | null;
        }[]
      >`select * from session_refresh_tokens where token_verifier=${verifier} for update`;
      if (!token)
        throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh denied");
      const [row] = await tx<
        SessionRow[]
      >`select * from sessions where id=${token.session_id} and application_type=${context.applicationType}::application_type for update`;
      if (!row)
        throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh denied");
      session = row;
      if (token.rotated_at) {
        await tx`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason='TOKEN_REUSE_DETECTED' where id=${row.id}`;
        if (context.applicationType === "DASHBOARD")
          await tx`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason='TOKEN_REUSE_DETECTED' where account_id=${row.account_id} and application_type='DASHBOARD' and revoked_at is null`;
        reuse = true;
        return;
      }
      if (
        token.revoked_at ||
        row.revoked_at ||
        row.absolute_expires_at <= new Date()
      )
        throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh denied");
      const [account] =
        await tx`select 1 from accounts where id=${row.account_id} and status='ACTIVE'`;
      if (!account || !(await this.stateAllowed(tx, row)))
        throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh denied");
      successor = randomOpaqueToken(32);
      successorId = crypto.randomUUID();
      const next = await this.verifier.create(successor);
      await tx`update session_refresh_tokens set rotated_at=now() where id=${token.id}`;
      await tx`insert into session_refresh_tokens(id,session_id,generation,token_verifier,verifier_key_version)values(${successorId},${row.id},${token.generation + 1},${next},${this.verifier.keyVersion})`;
      await tx`update session_refresh_tokens set replaced_by_id=${successorId} where id=${token.id}`;
      await tx`update sessions set last_used_at=now(),updated_at=now() where id=${row.id}`;
    });
    if (reuse) {
      await this.audit.write({
        event: "REFRESH_TOKEN_REUSE_DETECTED",
        outcome: "DENIED",
        requestId,
        accountId: session.account_id,
        sessionId: session.id,
        applicationType: context.applicationType,
      });
      throw new AppError(401, "TOKEN_REUSE_DETECTED", "Refresh denied");
    }
    await this.audit.write({
      event: "SESSION_REFRESHED",
      outcome: "SUCCESS",
      requestId,
      accountId: session.account_id,
      sessionId: session.id,
      applicationType: context.applicationType,
    });
    return this.result(
      session.account_id,
      { sessionId: session.id, refreshToken: successor },
      context,
    );
  }

  async list(identity: AuthIdentity, context: AuthenticationContext) {
    const rows = await this.client<
      {
        id: string;
        application_type: AuthApplication;
        device_id: string | null;
        device_name: string;
        created_at: Date;
        last_used_at: Date | null;
        absolute_expires_at: Date;
        revoked_at: Date | null;
      }[]
    >`select id,application_type,device_id,device_name,created_at,last_used_at,absolute_expires_at,revoked_at from sessions where account_id=${identity.accountId} and application_type=${context.applicationType}::application_type order by created_at desc`;
    return rows.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
      last_used_at: row.last_used_at?.toISOString() ?? null,
      absolute_expires_at: row.absolute_expires_at.toISOString(),
      revoked_at: row.revoked_at?.toISOString() ?? null,
    }));
  }

  async revoke(
    identity: AuthIdentity,
    target: string,
    context: AuthenticationContext,
    requestId: string,
  ) {
    const rows = await this
      .client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'USER_REVOKED'),updated_at=now() where id=${target} and account_id=${identity.accountId} and application_type=${context.applicationType}::application_type returning id`;
    if (!rows.length)
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found");
    await this.audit.write({
      event: "SESSION_REVOKED",
      outcome: "SUCCESS",
      requestId,
      accountId: identity.accountId,
      sessionId: target,
      applicationType: context.applicationType,
    });
  }

  async logout(
    identity: AuthIdentity,
    context: AuthenticationContext,
    requestId: string,
  ) {
    await this
      .client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'LOGOUT'),updated_at=now() where id=${identity.sessionId} and account_id=${identity.accountId} and application_type=${context.applicationType}::application_type`;
    await this.audit.write({
      event: "SESSION_REVOKED",
      outcome: "SUCCESS",
      requestId,
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      applicationType: context.applicationType,
    });
  }

  async logoutAll(
    identity: AuthIdentity,
    context: AuthenticationContext,
    requestId: string,
  ) {
    await this
      .client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'LOGOUT_ALL'),updated_at=now() where account_id=${identity.accountId} and application_type=${context.applicationType}::application_type`;
    await this.audit.write({
      event: "ALL_SESSIONS_REVOKED",
      outcome: "SUCCESS",
      requestId,
      accountId: identity.accountId,
      applicationType: context.applicationType,
    });
  }

  /** Revoke active Dashboard sessions after role assignment changes so stale role claims cannot be used. */
  async revokeDashboardSessionsForRoleChange(accountId: string): Promise<void> {
    await this
      .client`update sessions set revoked_at=now(),revocation_reason='ROLE_ASSIGNMENT_CHANGED',updated_at=now() where account_id=${accountId} and application_type='DASHBOARD' and revoked_at is null`;
  }

  requireSuperAdmin(identity: AuthIdentity): void {
    if (
      identity.applicationType !== "DASHBOARD" ||
      !identity.roles.includes("SUPER_ADMIN")
    ) {
      throw new AppError(403, "FORBIDDEN", "Insufficient privileges");
    }
  }
}
