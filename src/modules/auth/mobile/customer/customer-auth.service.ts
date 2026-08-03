import type { SQL } from "bun";
import { AppError } from "../../../../errors/app-error";
import type { SecurityAuditWriter } from "../../audit/audit-writer";
import { customerContext } from "../../core/context";
import type { OtpDeliveryPort } from "../../phone/delivery";
import { generateOtp } from "../../phone/otp";
import type { RateLimiter, RateLimitResult } from "../../rate-limit/rate-limiter";
import { rateLimitKey } from "../../rate-limit/rate-limiter";
import { normalizePhone } from "../../shared/normalization";
import type { HmacSecretVerifier } from "../../shared/secret-verifier";
import type { SessionResult, SessionService } from "../../sessions/session-service";

export class CustomerAuthService {
  constructor(
    private client: SQL,
    private limiter: RateLimiter,
    private delivery: OtpDeliveryPort,
    private verifier: HmacSecretVerifier,
    private sessions: SessionService,
    private audit: SecurityAuditWriter,
  ) {}

  private async limited(entries: Array<[string, number, number]>): Promise<RateLimitResult | null> {
    for (const [key, limit, windowSeconds] of entries) {
      const result = await this.limiter.consume(key, { limit, windowSeconds });
      if (!result.allowed) return result;
    }
    return null;
  }

  async requestOtp(input: { phone: string; ip: string; requestId: string }): Promise<string> {
    let phone: string;
    try { phone = normalizePhone(input.phone); } catch { throw new AppError(422, "VALIDATION_FAILED", "The request is invalid"); }
    const phoneKey = await this.verifier.create(phone);
    const ipKey = await this.verifier.create(input.ip);
    const limited = await this.limited([
      [rateLimitKey("customer", "otp", "phone", phoneKey), 5, 3600],
      [rateLimitKey("customer", "otp", "ip", ipKey), 20, 3600],
      [rateLimitKey("customer", "otp", "phone-ip", phoneKey, ipKey), 5, 3600],
      [rateLimitKey("customer", "otp", "cooldown", phoneKey), 1, 60],
    ]);
    if (limited) {
      await this.audit.write({ event: "OTP_REQUEST_RATE_LIMITED", outcome: "DENIED", requestId: input.requestId, applicationType: "CUSTOMER_APP" });
      throw new AppError(429, "RATE_LIMITED", "Too many requests", limited.retryAfterSeconds);
    }

    const otp = generateOtp();
    const otpVerifier = await this.verifier.create(otp);
    const id = crypto.randomUUID();
    const created = new Date();
    await this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`otp:${phone}:CUSTOMER_APP`},0))`;
      const prior = await tx<{ id: string }[]>`select id from otp_challenges where phone_e164=${phone} and purpose='LOGIN' and application_type='CUSTOMER_APP' and consumed_at is null and invalidated_at is null for update`;
      if (prior.length) await tx`update otp_challenges set invalidated_at=${created} where id in ${tx(prior.map((row) => row.id))}`;
      await tx`insert into otp_challenges(id,purpose,application_type,phone_e164,otp_keyed_verifier,verifier_key_version,expires_at,resend_available_at,last_sent_at,created_at) values(${id},'LOGIN','CUSTOMER_APP',${phone},${otpVerifier},${this.verifier.keyVersion},${new Date(created.getTime()+300_000)},${new Date(created.getTime()+60_000)},${created},${created})`;
      if (prior.length) await tx`update otp_challenges set replacement_challenge_id=${id} where id in ${tx(prior.map((row) => row.id))}`;
    });

    try { await this.delivery.deliver(phone, otp); }
    catch {
      await this.client`update otp_challenges set invalidated_at=now() where id=${id}`;
      throw new AppError(503, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable");
    }
    await this.audit.write({ event: "OTP_REQUESTED", outcome: "SUCCESS", requestId: input.requestId, applicationType: "CUSTOMER_APP" });
    return id;
  }

  async verifyOtp(input: { challengeId: string; otp: string; deviceId?: string; deviceName: string; ip: string; requestId: string }): Promise<SessionResult> {
    if (!/^[0-9]{6}$/.test(input.otp)) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    const ipKey = await this.verifier.create(input.ip);
    const challengeKey = await this.verifier.create(input.challengeId);
    const limited = await this.limited([
      [rateLimitKey("customer", "otp-verify", "ip", ipKey), 30, 300],
      [rateLimitKey("customer", "otp-verify", "challenge", challengeKey), 7, 300],
    ]);
    if (limited) throw new AppError(429, "RATE_LIMITED", "Too many requests", limited.retryAfterSeconds);

    let accountId = "";
    let created!: { sessionId: string; refreshToken: string };
    let failure = "";
    try {
      await this.client.begin(async (tx) => {
        const [challenge] = await tx<{ phone_e164: string; otp_keyed_verifier: string; verifier_key_version: string; attempt_count: number; max_attempts: number; expires_at: Date; consumed_at: Date|null; invalidated_at: Date|null; application_type: string }[]>`select * from otp_challenges where id=${input.challengeId} for update`;
        if (!challenge || challenge.application_type !== "CUSTOMER_APP" || challenge.consumed_at || challenge.invalidated_at || challenge.expires_at <= new Date() || challenge.attempt_count >= challenge.max_attempts) throw new Error("DENIED");
        if (challenge.verifier_key_version !== this.verifier.keyVersion || !await this.verifier.verify(input.otp, challenge.otp_keyed_verifier)) {
          const exhausted = challenge.attempt_count + 1 >= challenge.max_attempts;
          await tx`update otp_challenges set attempt_count=attempt_count+1,invalidated_at=case when ${exhausted} then now() else invalidated_at end where id=${input.challengeId}`;
          failure = exhausted ? "EXHAUSTED" : "FAILED";
          return;
        }
        await tx`select pg_advisory_xact_lock(hashtextextended(${challenge.phone_e164},0))`;
        const [phone] = await tx<{ account_id: string }[]>`select account_id from account_phones where phone_e164=${challenge.phone_e164} and verified_at is not null for update`;
        if (phone) accountId = phone.account_id;
        else {
          const [account] = await tx<{ id: string }[]>`insert into accounts default values returning id`;
          accountId = account!.id;
          await tx`insert into account_phones(account_id,phone_e164,verified_at,is_primary) values(${accountId},${challenge.phone_e164},now(),true)`;
        }
        await tx`insert into customer_profiles(account_id) values(${accountId}) on conflict(account_id) do nothing`;
        created = await this.sessions.create(tx, accountId, customerContext, "PHONE_OTP", input.deviceId, input.deviceName);
        await tx`update otp_challenges set consumed_at=now(),account_id=${accountId},resulting_session_id=${created.sessionId} where id=${input.challengeId}`;
      });
      if (failure) throw new Error(failure);
    } catch (error) {
      const exhausted = error instanceof Error && error.message === "EXHAUSTED";
      await this.audit.write({ event: exhausted ? "OTP_CHALLENGE_EXHAUSTED" : "OTP_VERIFICATION_FAILED", outcome: "FAILURE", requestId: input.requestId, applicationType: "CUSTOMER_APP", reasonCode: "INVALID_OR_EXPIRED_CHALLENGE" });
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    }
    await this.audit.write({ event: "OTP_VERIFICATION_SUCCEEDED", outcome: "SUCCESS", requestId: input.requestId, accountId, sessionId: created.sessionId, applicationType: "CUSTOMER_APP" });
    await this.audit.write({ event: "CUSTOMER_SESSION_CREATED", outcome: "SUCCESS", requestId: input.requestId, accountId, sessionId: created.sessionId, applicationType: "CUSTOMER_APP" });
    return this.sessions.result(accountId, created, customerContext);
  }
}
