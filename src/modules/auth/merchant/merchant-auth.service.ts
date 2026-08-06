import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type { SecurityAuditWriter } from "../audit/audit-writer";
import { merchantContext } from "../core/context";
import type { RateLimiter } from "../rate-limit/rate-limiter";
import { rateLimitKey } from "../rate-limit/rate-limiter";
import { normalizePhone } from "../shared/normalization";
import type { HmacSecretVerifier } from "../shared/secret-verifier";
import type { Argon2PasswordHasher } from "../staff/password";
import type {
  AuthIdentity,
  SessionResult,
  SessionService,
} from "../sessions/session-service";
import { loadTrustedMerchantContext } from "./merchant-scope";

export class MerchantAuthService {
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
    phone: string;
    password: string;
    deviceId?: string;
    deviceName: string;
    ip: string;
    requestId: string;
  }): Promise<SessionResult> {
    const phone = normalizePhone(input.phone);
    const phoneKey = await this.key.create(phone);
    for (const [key, limit] of [
      [rateLimitKey("merchant", "login", "phone", phoneKey), 12],
      [rateLimitKey("merchant", "login", "ip", input.ip), 30],
    ] as const) {
      const result = await this.limiter.consume(key, {
        limit,
        windowSeconds: 900,
      });
      if (!result.allowed) {
        await this.audit.write({
          event: "MERCHANT_LOGIN_FAILED",
          outcome: "DENIED",
          requestId: input.requestId,
          applicationType: "MERCHANT_APP",
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
        argon2id_hash: string | null;
        account_status: string;
        merchant_status: string;
      }[]
    >`select
        a.id as account_id,
        p.argon2id_hash,
        a.status::text as account_status,
        m.status::text as merchant_status
      from account_phones ph
      join accounts a on a.id = ph.account_id
      join merchant_profiles m on m.account_id = a.id
      left join password_credentials p on p.account_id = a.id
      where ph.phone_e164 = ${phone}
        and ph.verified_at is not null
      limit 1`;

    const valid = await this.password
      .verify(
        input.password,
        record?.argon2id_hash ?? (await this.dummyVerificationHash()),
      )
      .catch(() => false);

    if (
      !record ||
      !valid ||
      record.account_status !== "ACTIVE" ||
      record.merchant_status !== "ACTIVE"
    ) {
      await this.audit.write({
        event: "MERCHANT_LOGIN_FAILED",
        outcome: "FAILURE",
        requestId: input.requestId,
        applicationType: "MERCHANT_APP",
        reasonCode: "INVALID_CREDENTIALS",
      });
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    }

    if (
      record.argon2id_hash &&
      this.password.needsRehash(record.argon2id_hash)
    ) {
      await this.client`
        update password_credentials
        set argon2id_hash = ${await this.password.hash(input.password)},
            updated_at = now()
        where account_id = ${record.account_id}`;
    }

    const created = await this.client.begin((tx) =>
      this.sessions.create(
        tx,
        record.account_id,
        merchantContext,
        "PASSWORD",
        input.deviceId,
        input.deviceName,
      ),
    );

    await this.audit.write({
      event: "MERCHANT_LOGIN_SUCCEEDED",
      outcome: "SUCCESS",
      requestId: input.requestId,
      accountId: record.account_id,
      sessionId: created.sessionId,
      applicationType: "MERCHANT_APP",
    });

    return this.sessions.result(record.account_id, created, merchantContext);
  }

  async me(identity: AuthIdentity) {
    if (identity.applicationType !== "MERCHANT_APP") {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
    const merchant = await loadTrustedMerchantContext(
      this.client,
      identity.accountId,
    );
    const [phone] = await this.client<{ phone_e164: string }[]>`
      select phone_e164 from account_phones
      where account_id = ${identity.accountId}
        and verified_at is not null
      order by is_primary desc, created_at asc
      limit 1`;
    const [store] = await this.client<
      {
        id: string;
        name: string;
        status: string;
        order_acceptance_status: string;
      }[]
    >`
      select
        id::text as id,
        name,
        status::text as status,
        order_acceptance_status::text as order_acceptance_status
      from stores
      where id = ${merchant.storeId}
        and city_id = ${merchant.cityId}`;
    if (!store) {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
    return {
      accountId: identity.accountId,
      phone: phone?.phone_e164 ?? null,
      displayName: merchant.displayName,
      status: merchant.status,
      cityId: merchant.cityId,
      store: {
        id: store.id,
        name: store.name,
        status: store.status,
        orderAcceptanceStatus: store.order_acceptance_status,
      },
    };
  }

  async changePassword(
    identity: AuthIdentity,
    body: unknown,
    requestId: string,
  ) {
    if (identity.applicationType !== "MERCHANT_APP") {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.currentPassword !== "string" ||
      typeof input.newPassword !== "string"
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if (
      input.newPassword.length < 12 ||
      input.newPassword.length > 128
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }

    await this.client.begin(async (tx) => {
      const [cred] = await tx<{ argon2id_hash: string }[]>`
        select argon2id_hash from password_credentials
        where account_id = ${identity.accountId}
        for update`;
      if (!cred) {
        throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
      }
      const ok = await this.password
        .verify(input.currentPassword as string, cred.argon2id_hash)
        .catch(() => false);
      if (!ok) {
        throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
      }
      await tx`
        update password_credentials set
          argon2id_hash = ${await this.password.hash(input.newPassword as string)},
          password_changed_at = now(),
          updated_at = now()
        where account_id = ${identity.accountId}`;
      await tx`
        update sessions set
          revoked_at = now(),
          revocation_reason = 'PASSWORD_CHANGED',
          updated_at = now()
        where account_id = ${identity.accountId}
          and application_type = 'MERCHANT_APP'
          and revoked_at is null`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MERCHANT_PASSWORD_CHANGED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ application_type: "MERCHANT_APP" })}::jsonb
      )`;

    return { changed: true, request_id: requestId };
  }
}
