import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { AppConfig } from "../../config/env";
import { SecurityAuditWriter } from "./audit/audit-writer";
import type { OtpDeliveryPort } from "./phone/delivery";
import { generateOtp } from "./phone/otp";
import type { RateLimiter } from "./rate-limit/rate-limiter";
import { rateLimitKey } from "./rate-limit/rate-limiter";
import { randomOpaqueToken } from "./shared/encoding";
import { normalizeEmail, normalizePhone } from "./shared/normalization";
import { HmacSecretVerifier } from "./shared/secret-verifier";
import { Argon2PasswordHasher } from "./staff/password";
import { Ed25519AccessTokenService, type AuthApplication } from "./tokens/access-token";

type SessionResult = { access_token: string; access_token_expires_at: string; refresh_token: string; session_id: string; application_type: AuthApplication };
type SessionRow = { id: string; account_id: string; application_type: AuthApplication; absolute_expires_at: Date; revoked_at: Date | null; authentication_method: string };

export class AuthService {
  private verifier: HmacSecretVerifier;
  private password: Argon2PasswordHasher;
  private tokens: Ed25519AccessTokenService;
  private audit: SecurityAuditWriter;
  constructor(private client: SQL, private rateLimiter: RateLimiter, private delivery: OtpDeliveryPort, config: AppConfig) {
    this.verifier = new HmacSecretVerifier(config.secretVerifierKeyVersion, config.secretVerifierKey);
    this.password = new Argon2PasswordHasher({ memoryCost: config.argon2MemoryCost, timeCost: config.argon2TimeCost, parallelism: config.argon2Parallelism });
    this.tokens = new Ed25519AccessTokenService({ issuer: config.jwtIssuer, keyId: config.jwtKeyId, privateKeyBase64: config.jwtPrivateKeyBase64, publicKeyBase64: config.jwtPublicKeyBase64, lifetimeSeconds: config.accessTokenLifetimeSeconds });
    this.audit = new SecurityAuditWriter(client);
  }

  private async limited(keys: Array<[string, number, number]>): Promise<boolean> {
    for (const [key, limit, windowSeconds] of keys) if (!(await this.rateLimiter.consume(key, { limit, windowSeconds })).allowed) return true;
    return false;
  }

  async requestOtp(input: { phone: string; applicationType: "CUSTOMER_APP" | "DRIVER_APP"; ip: string; requestId: string }): Promise<string> {
    const phone = normalizePhone(input.phone);
    if (await this.limited([[rateLimitKey("otp", "phone", phone), 5, 3600], [rateLimitKey("otp", "ip", input.ip), 20, 3600], [rateLimitKey("otp", "phone-ip", phone, input.ip), 5, 3600], [rateLimitKey("otp", "cooldown", phone), 1, 60]])) {
      await this.audit.write({ event: "OTP_REQUEST_RATE_LIMITED", outcome: "DENIED", requestId: input.requestId, applicationType: input.applicationType });
      throw new AppError(429, "RATE_LIMITED", "Too many requests");
    }
    const otp = generateOtp(); const verifier = await this.verifier.create(otp); const id = crypto.randomUUID(); const created = new Date();
    await this.client.begin(async (tx) => {
      const prior = await tx<{ id: string }[]>`select id from otp_challenges where phone_e164=${phone} and purpose='LOGIN' and consumed_at is null and invalidated_at is null for update`;
      if (prior.length) await tx`update otp_challenges set invalidated_at=${created} where id in ${tx(prior.map((row) => row.id))}`;
      await tx`insert into otp_challenges (id,purpose,application_type,phone_e164,otp_keyed_verifier,verifier_key_version,expires_at,resend_available_at,last_sent_at,created_at) values (${id},'LOGIN',${input.applicationType}::application_type,${phone},${verifier},${this.verifier.keyVersion},${new Date(created.getTime()+300000)},${new Date(created.getTime()+60000)},${created},${created})`;
      if (prior.length) await tx`update otp_challenges set replacement_challenge_id=${id} where id in ${tx(prior.map((row) => row.id))}`;
    });
    try { await this.delivery.deliver(phone, otp); } catch { await this.client`update otp_challenges set invalidated_at=now() where id=${id}`; throw new AppError(503, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable"); }
    await this.audit.write({ event: "OTP_REQUESTED", outcome: "SUCCESS", requestId: input.requestId, applicationType: input.applicationType });
    return id;
  }

  private async createSessionInTransaction(tx: SQL, accountId: string, applicationType: AuthApplication, authMethod: "PHONE_OTP" | "PASSWORD", deviceId: string | undefined, deviceName: string): Promise<{ sessionId: string; refreshToken: string }> {
    const limit = applicationType === "DRIVER_APP" ? 1 : applicationType === "CUSTOMER_APP" ? 5 : 3;
    const active = await tx<{ id: string }[]>`select id from sessions where account_id=${accountId} and application_type=${applicationType}::application_type and revoked_at is null order by created_at asc for update`;
    const revokeCount = Math.max(0, active.length - limit + 1); const revokeIds = active.slice(0, revokeCount).map((row) => row.id);
    if (revokeIds.length) await tx`update sessions set revoked_at=now(),revocation_reason='SESSION_LIMIT_REPLACED',updated_at=now() where id in ${tx(revokeIds)}`;
    const sessionId = crypto.randomUUID(); const refreshToken = randomOpaqueToken(32); const refreshVerifier = await this.verifier.create(refreshToken);
    await tx`insert into sessions (id,account_id,application_type,authentication_method,device_id,device_name,absolute_expires_at) values (${sessionId},${accountId},${applicationType}::application_type,${authMethod}::authentication_method,${deviceId ?? null},${deviceName},now()+interval '30 days')`;
    await tx`insert into session_refresh_tokens (session_id,generation,token_verifier,verifier_key_version) values (${sessionId},0,${refreshVerifier},${this.verifier.keyVersion})`;
    return { sessionId, refreshToken };
  }

  private async result(accountId: string, sessionId: string, refreshToken: string, applicationType: AuthApplication): Promise<SessionResult> {
    const access = await this.tokens.sign({ accountId, sessionId, applicationType });
    return { access_token: access.token, access_token_expires_at: new Date(access.expiresAt * 1000).toISOString(), refresh_token: refreshToken, session_id: sessionId, application_type: applicationType };
  }

  async verifyOtp(input: { challengeId: string; otp: string; applicationType: "CUSTOMER_APP" | "DRIVER_APP"; deviceId: string | undefined; deviceName: string; ip: string; requestId: string }): Promise<SessionResult> {
    if (!/^\d{6}$/.test(input.otp)) throw new AppError(401, "AUTHENTICATION_FAILED", "Authentication failed");
    if (await this.limited([[rateLimitKey("otp-verify", "ip", input.ip), 30, 300], [rateLimitKey("otp-verify", "challenge", input.challengeId), 7, 300]])) {
      await this.audit.write({event:"OTP_VERIFICATION_FAILED",outcome:"DENIED",requestId:input.requestId,reasonCode:"RATE_LIMITED",applicationType:input.applicationType});
      throw new AppError(429, "RATE_LIMITED", "Too many requests");
    }
    let accountId = ""; let createdSession!: { sessionId: string; refreshToken: string }; let replacedDriver = false; let verificationFailure: string | undefined;
    try {
      await this.client.begin(async (tx) => {
        const [challenge] = await tx<{ phone_e164: string; otp_keyed_verifier: string; verifier_key_version: string; attempt_count: number; max_attempts: number; expires_at: Date; consumed_at: Date|null; invalidated_at: Date|null; application_type: string }[]>`select * from otp_challenges where id=${input.challengeId} for update`;
        if (!challenge || challenge.application_type !== input.applicationType || challenge.consumed_at || challenge.invalidated_at || challenge.expires_at <= new Date() || challenge.attempt_count >= challenge.max_attempts) throw new Error("DENIED");
        if (challenge.verifier_key_version !== this.verifier.keyVersion || !await this.verifier.verify(input.otp, challenge.otp_keyed_verifier)) {
          const exhausted = challenge.attempt_count + 1 >= challenge.max_attempts;
          await tx`update otp_challenges set attempt_count=attempt_count+1,invalidated_at=case when ${exhausted} then now() else invalidated_at end where id=${input.challengeId}`;
          verificationFailure = exhausted ? "EXHAUSTED" : "FAILED";
          return;
        }
        // A row lock cannot lock an absent phone row. The transaction-scoped advisory
        // lock serializes first-account creation for the normalized phone instead.
        await tx`select pg_advisory_xact_lock(hashtextextended(${challenge.phone_e164}, 0))`;
        const [phone] = await tx<{ account_id: string }[]>`select account_id from account_phones where phone_e164=${challenge.phone_e164} and verified_at is not null for update`;
        if (input.applicationType === "CUSTOMER_APP") {
          if (phone) accountId = phone.account_id;
          else { const [account] = await tx<{ id: string }[]>`insert into accounts default values returning id`; accountId=account!.id; await tx`insert into account_phones (account_id,phone_e164,verified_at,is_primary) values (${accountId},${challenge.phone_e164},now(),true)`; }
          await tx`insert into customer_profiles (account_id) values (${accountId}) on conflict (account_id) do nothing`;
        } else {
          if (!phone) throw new Error("DENIED"); accountId=phone.account_id;
          const eligible = await tx`select 1 from accounts a join driver_profiles d on d.account_id=a.id where a.id=${accountId} and a.status='ACTIVE' and d.approval_status='APPROVED' and d.operational_status='ACTIVE'`;
          if (!eligible.length) throw new Error("DENIED");
          replacedDriver = Boolean((await tx`select 1 from sessions where account_id=${accountId} and application_type='DRIVER_APP' and revoked_at is null`).length);
        }
        createdSession = await this.createSessionInTransaction(tx, accountId, input.applicationType, "PHONE_OTP", input.deviceId, input.deviceName);
        await tx`update otp_challenges set consumed_at=now(),account_id=${accountId},resulting_session_id=${createdSession.sessionId} where id=${input.challengeId}`;
      });
      if (verificationFailure) throw new Error(verificationFailure);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "DENIED";
      await this.audit.write({ event: reason === "EXHAUSTED" ? "OTP_CHALLENGE_EXHAUSTED" : "OTP_VERIFICATION_FAILED", outcome: "FAILURE", requestId: input.requestId, reasonCode: "INVALID_OR_EXPIRED_CHALLENGE", applicationType: input.applicationType });
      throw new AppError(401, "AUTHENTICATION_FAILED", "Authentication failed");
    }
    await this.audit.write({ event: "OTP_VERIFICATION_SUCCEEDED", outcome: "SUCCESS", requestId: input.requestId, accountId, sessionId: createdSession.sessionId, applicationType: input.applicationType });
    if (input.applicationType === "CUSTOMER_APP") await this.audit.write({ event: "CUSTOMER_SESSION_CREATED", outcome: "SUCCESS", requestId: input.requestId, accountId, sessionId: createdSession.sessionId, applicationType: input.applicationType });
    else if (replacedDriver) await this.audit.write({ event: "DRIVER_SESSION_REPLACED", outcome: "SUCCESS", requestId: input.requestId, accountId, sessionId: createdSession.sessionId, applicationType: input.applicationType });
    return this.result(accountId, createdSession.sessionId, createdSession.refreshToken, input.applicationType);
  }

  async staffLogin(input: { email: string; password: string; deviceId: string | undefined; deviceName: string; ip: string; requestId: string }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    if (await this.limited([[rateLimitKey("staff-login", "email", email), 12, 900], [rateLimitKey("staff-login", "email-ip", email, input.ip), 8, 900], [rateLimitKey("staff-login", "ip", input.ip), 30, 900]])) {
      await this.audit.write({event:"STAFF_LOGIN_FAILED",outcome:"DENIED",requestId:input.requestId,reasonCode:"RATE_LIMITED"});
      throw new AppError(429, "RATE_LIMITED", "Too many requests");
    }
    const [record] = await this.client<{ account_id:string; argon2id_hash:string; account_status:string; staff_status:string; verified_at:Date|null }[]>`select a.id account_id,p.argon2id_hash,a.status account_status,s.status staff_status,e.verified_at from account_emails e join accounts a on a.id=e.account_id left join password_credentials p on p.account_id=a.id left join staff_profiles s on s.account_id=a.id where e.email_normalized=${email} limit 1`;
    const dummy = "$argon2id$v=19$m=65536,t=3,p=1$MTIzNDU2Nzg5MDEyMzQ1Ng$GQhB1D+jbJz3SzLI6oVZzNyY6jY6oCI9g8qlkX/KdF8";
    const valid = await this.password.verify(input.password, record?.argon2id_hash ?? dummy).catch(() => false);
    const role = record ? await this.client`select 1 from account_roles ar join roles r on r.id=ar.role_id where ar.account_id=${record.account_id} and ar.revoked_at is null and r.status='ACTIVE' and (ar.valid_until is null or ar.valid_until>now())` : [];
    if (!record || !valid || record.account_status!=="ACTIVE" || record.staff_status!=="ACTIVE" || !record.verified_at || !role.length) { await this.audit.write({ event:"STAFF_LOGIN_FAILED",outcome:"FAILURE",requestId:input.requestId,reasonCode:"INVALID_CREDENTIALS" }); throw new AppError(401,"AUTHENTICATION_FAILED","Authentication failed"); }
    if (this.password.needsRehash(record.argon2id_hash)) await this.client`update password_credentials set argon2id_hash=${await this.password.hash(input.password)},updated_at=now() where account_id=${record.account_id}`;
    const created = await this.client.begin((tx) => this.createSessionInTransaction(tx,record.account_id,"DASHBOARD","PASSWORD",input.deviceId,input.deviceName));
    await this.audit.write({event:"STAFF_LOGIN_SUCCEEDED",outcome:"SUCCESS",requestId:input.requestId,accountId:record.account_id,sessionId:created.sessionId,applicationType:"DASHBOARD"});
    return this.result(record.account_id,created.sessionId,created.refreshToken,"DASHBOARD");
  }

  private async hasAuthorizationState(client: SQL, row: SessionRow): Promise<boolean> {
    const allowed = await client`
      select 1
      where
        (${row.application_type}::application_type = 'CUSTOMER_APP' and exists (
          select 1 from customer_profiles where account_id=${row.account_id} and status='ACTIVE'
        )) or
        (${row.application_type}::application_type = 'DRIVER_APP' and exists (
          select 1 from driver_profiles where account_id=${row.account_id} and approval_status='APPROVED' and operational_status='ACTIVE'
        )) or
        (${row.application_type}::application_type = 'DASHBOARD' and exists (
          select 1 from staff_profiles where account_id=${row.account_id} and status='ACTIVE'
        ) and exists (
          select 1 from account_roles ar join roles r on r.id=ar.role_id
          where ar.account_id=${row.account_id} and ar.revoked_at is null and r.status='ACTIVE'
            and (ar.valid_until is null or ar.valid_until>now())
        ))`;
    return allowed.length > 0;
  }

  async identifyAccessToken(accessToken: string): Promise<{accountId:string;sessionId:string;applicationType:AuthApplication}> {
    let app: AuthApplication; try { const p=JSON.parse(Buffer.from(accessToken.split(".")[1]??"","base64url").toString()) as {app:AuthApplication}; app=p.app; } catch { throw new AppError(401,"UNAUTHENTICATED","Authentication required"); }
    let verified; try { verified=await this.tokens.verify(accessToken,app); } catch { throw new AppError(401,"UNAUTHENTICATED","Authentication required"); }
    return verified;
  }

  async authenticate(accessToken: string, requestId: string = crypto.randomUUID()): Promise<{accountId:string;sessionId:string;applicationType:AuthApplication}> {
    const verified=await this.identifyAccessToken(accessToken); const app=verified.applicationType;
    const [session]=await this.client<SessionRow[]>`select s.* from sessions s join accounts a on a.id=s.account_id where s.id=${verified.sessionId} and s.account_id=${verified.accountId} and s.application_type=${app}::application_type and s.revoked_at is null and s.absolute_expires_at>now() and a.status='ACTIVE'`;
    if (!session || !await this.hasAuthorizationState(this.client, session)) {
      await this.audit.write({event:"AUTHENTICATION_STATE_DENIED",outcome:"DENIED",requestId,accountId:verified.accountId,sessionId:verified.sessionId,applicationType:app,reasonCode:"INACTIVE_SECURITY_STATE"});
      throw new AppError(401,"UNAUTHENTICATED","Authentication required");
    }
    return verified;
  }

  async refresh(rawToken:string,ip:string,requestId:string):Promise<SessionResult>{
    if(await this.limited([[rateLimitKey("refresh","ip",ip),60,300]])) throw new AppError(429,"RATE_LIMITED","Too many requests");
    const verifier=await this.verifier.create(rawToken);
    const [candidate]=await this.client<{session_id:string}[]>`select session_id from session_refresh_tokens where token_verifier=${verifier}`;
    if(candidate && await this.limited([[rateLimitKey("refresh","session",candidate.session_id),30,300]])) throw new AppError(429,"RATE_LIMITED","Too many requests");
    let session!:SessionRow; let successor!:string; let successorId!:string; let reuseDetected=false;
    await this.client.begin(async tx=>{
      const [token]=await tx<{id:string;session_id:string;generation:number;rotated_at:Date|null;revoked_at:Date|null;verifier_key_version:string}[]>`select * from session_refresh_tokens where token_verifier=${verifier} for update`;
      if(!token) throw new AppError(401,"INVALID_REFRESH_TOKEN","Refresh denied");
      const [row]=await tx<SessionRow[]>`select * from sessions where id=${token.session_id} for update`; if(!row) throw new AppError(401,"INVALID_REFRESH_TOKEN","Refresh denied"); session=row;
      if(token.rotated_at){ await tx`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason='TOKEN_REUSE_DETECTED' where id=${row.id}`; if(row.application_type==="DASHBOARD") await tx`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason='TOKEN_REUSE_DETECTED' where account_id=${row.account_id} and application_type='DASHBOARD' and revoked_at is null`; reuseDetected=true; return; }
      if(token.revoked_at||row.revoked_at||row.absolute_expires_at<=new Date()) throw new AppError(401,"INVALID_REFRESH_TOKEN","Refresh denied");
      const [activeAccount]=await tx`select 1 from accounts where id=${row.account_id} and status='ACTIVE'`;
      if(!activeAccount) throw new AppError(401,"INVALID_REFRESH_TOKEN","Refresh denied");
      if(!await this.hasAuthorizationState(tx,row)) throw new AppError(401,"INVALID_REFRESH_TOKEN","Refresh denied");
      successor=randomOpaqueToken(32); successorId=crypto.randomUUID(); const nextVerifier=await this.verifier.create(successor);
      await tx`update session_refresh_tokens set rotated_at=now() where id=${token.id} and rotated_at is null`;
      await tx`insert into session_refresh_tokens (id,session_id,generation,token_verifier,verifier_key_version) values (${successorId},${row.id},${token.generation+1},${nextVerifier},${this.verifier.keyVersion})`;
      await tx`update session_refresh_tokens set replaced_by_id=${successorId} where id=${token.id}`;
      await tx`update sessions set last_used_at=now(),updated_at=now() where id=${row.id}`;
    });
    if(reuseDetected){ await this.audit.write({event:"REFRESH_TOKEN_REUSE_DETECTED",outcome:"DENIED",requestId,accountId:session.account_id,sessionId:session.id,applicationType:session.application_type}); throw new AppError(401,"TOKEN_REUSE_DETECTED","Refresh denied"); }
    await this.audit.write({event:"SESSION_REFRESHED",outcome:"SUCCESS",requestId,accountId:session.account_id,sessionId:session.id,applicationType:session.application_type}); return this.result(session.account_id,session.id,successor,session.application_type);
  }

  async listSessions(auth:{accountId:string;sessionId:string}) {
    const rows=await this.client<{id:string;application_type:AuthApplication;device_id:string|null;device_name:string;created_at:Date;last_used_at:Date|null;absolute_expires_at:Date;revoked_at:Date|null}[]>`select id,application_type,device_id,device_name,created_at,last_used_at,absolute_expires_at,revoked_at from sessions where account_id=${auth.accountId} order by created_at desc`;
    return rows.map(row=>({...row,created_at:row.created_at.toISOString(),last_used_at:row.last_used_at?.toISOString()??null,absolute_expires_at:row.absolute_expires_at.toISOString(),revoked_at:row.revoked_at?.toISOString()??null}));
  }
  async revokeSession(auth:{accountId:string;sessionId:string},target:string,requestId:string){ const rows=await this.client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'USER_REVOKED'),updated_at=now() where id=${target} and account_id=${auth.accountId} returning id`; if(!rows.length) throw new AppError(404,"SESSION_NOT_FOUND","Session not found"); await this.audit.write({event:"SESSION_REVOKED",outcome:"SUCCESS",requestId,accountId:auth.accountId,sessionId:target}); }
  async logout(auth:{accountId:string;sessionId:string},requestId:string){ await this.client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'LOGOUT'),updated_at=now() where id=${auth.sessionId} and account_id=${auth.accountId}`; await this.audit.write({event:"SESSION_REVOKED",outcome:"SUCCESS",requestId,accountId:auth.accountId,sessionId:auth.sessionId}); }
  async logoutAll(auth:{accountId:string;sessionId:string},requestId:string){ await this.client`update sessions set revoked_at=coalesce(revoked_at,now()),revocation_reason=coalesce(revocation_reason,'LOGOUT_ALL'),updated_at=now() where account_id=${auth.accountId}`; await this.audit.write({event:"ALL_SESSIONS_REVOKED",outcome:"SUCCESS",requestId,accountId:auth.accountId}); }
}
