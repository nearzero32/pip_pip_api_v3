import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { SecurityAuditWriter } from "../audit/audit-writer";
import { dashboardContext } from "../core/context";
import type { RateLimiter } from "../rate-limit/rate-limiter";
import { rateLimitKey } from "../rate-limit/rate-limiter";
import { normalizeEmail } from "../shared/normalization";
import type { HmacSecretVerifier } from "../shared/secret-verifier";
import type { Argon2PasswordHasher } from "../staff/password";
import type {
  SessionResult,
  SessionService,
} from "../sessions/session-service";
export class DashboardAuthService {
  private dummyHash: Promise<string> | undefined;
  constructor(
    private client: SQL,
    private limiter: RateLimiter,
    private password: Argon2PasswordHasher,
    private key: HmacSecretVerifier,
    private sessions: SessionService,
    private audit: SecurityAuditWriter,
  ) {}
  private dummyVerificationHash() {
    return (this.dummyHash ??= this.password.hash(
      "dummy-password-not-a-real-credential",
    ));
  }
  
  async login(input: {
    email: string;
    password: string;
    deviceId?: string;
    deviceName: string;
    ip: string;
    requestId: string;
  }): Promise<SessionResult> {
    const email = normalizeEmail(input.email),
      emailKey = await this.key.create(email);
    for (const [key, limit] of [
      [rateLimitKey("dashboard", "login", "email", emailKey), 12],
      [rateLimitKey("dashboard", "login", "ip", input.ip), 30],
    ] as const) {
      const result = await this.limiter.consume(key, {
        limit,
        windowSeconds: 900,
      });
      if (!result.allowed) {
        await this.audit.write({
          event: "STAFF_LOGIN_FAILED",
          outcome: "DENIED",
          requestId: input.requestId,
          applicationType: "DASHBOARD",
          reasonCode: "RATE_LIMITED",
        });
        throw new AppError(
          429,
          "RATE_LIMITED",
          "Too many requests",
          result.retryAfterSeconds,
        );
      }
    }
    const [record] = await this.client<
      {
        account_id: string;
        argon2id_hash: string;
        account_status: string;
        staff_status: string;
        verified_at: Date | null;
      }[]
    >`select a.id account_id,p.argon2id_hash,a.status account_status,s.status staff_status,e.verified_at from account_emails e join accounts a on a.id=e.account_id left join password_credentials p on p.account_id=a.id left join staff_profiles s on s.account_id=a.id where e.email_normalized=${email} limit 1`;
    const valid = await this.password
        .verify(
          input.password,
          record?.argon2id_hash ?? (await this.dummyVerificationHash()),
        )
        .catch(() => false),
      role = record
        ? await this
            .client`select 1 from account_roles ar join roles r on r.id=ar.role_id where ar.account_id=${record.account_id} and ar.revoked_at is null and r.status='ACTIVE' and ar.valid_from<=now() and(ar.valid_until is null or ar.valid_until>now())`
        : [];
    if (
      !record ||
      !valid ||
      record.account_status !== "ACTIVE" ||
      record.staff_status !== "ACTIVE" ||
      !record.verified_at ||
      !role.length
    ) {
      await this.audit.write({
        event: "STAFF_LOGIN_FAILED",
        outcome: "FAILURE",
        requestId: input.requestId,
        applicationType: "DASHBOARD",
        reasonCode: "INVALID_CREDENTIALS",
      });
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    }
    if (this.password.needsRehash(record.argon2id_hash))
      await this
        .client`update password_credentials set argon2id_hash=${await this.password.hash(input.password)},updated_at=now() where account_id=${record.account_id}`;
    const created = await this.client.begin((tx) =>
      this.sessions.create(
        tx,
        record.account_id,
        dashboardContext,
        "PASSWORD",
        input.deviceId,
        input.deviceName,
      ),
    );
    await this.audit.write({
      event: "STAFF_LOGIN_SUCCEEDED",
      outcome: "SUCCESS",
      requestId: input.requestId,
      accountId: record.account_id,
      sessionId: created.sessionId,
      applicationType: "DASHBOARD",
    });
    return this.sessions.result(record.account_id, created, dashboardContext);
  }
}
