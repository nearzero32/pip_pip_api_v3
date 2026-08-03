import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { AppConfig } from "../../src/config/env";
import { applyMigrations } from "../../src/db/migration-runner";
import { AuthService } from "../../src/modules/auth/auth-service";
import { TestOtpDelivery } from "../../src/modules/auth/phone/delivery";
import { InMemoryRateLimiter } from "../../src/modules/auth/rate-limit/rate-limiter";
import { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";

const adminUrl=process.env.TEST_ADMIN_DATABASE_URL;
if(!adminUrl) throw new Error("TEST_ADMIN_DATABASE_URL is required for integration tests");
const parsed=new URL(adminUrl); if(!["localhost","127.0.0.1"].includes(parsed.hostname)||/prod/i.test(parsed.pathname)) throw new Error("Unsafe integration database");
const privateKey="MC4CAQAwBQYDK2VwBCIEIOhYjslG5wawzghWHcQbYCMjFp8kzMYLVFZoKEOBzTA4";
const publicKey="MCowBQYDK2VwAyEA+ly2CeP4N1AQ5vNUEt226L6GtOMU/uLE2rjFfo4OBCE=";
const config:AppConfig={nodeEnv:"test",host:"127.0.0.1",port:3000,logLevel:"error",databaseUrl:adminUrl,databasePoolSize:5,databaseConnectionTimeoutMs:5000,gracefulShutdownTimeoutMs:5000,redisUrl:"redis://localhost:6379",otpDeliveryAdapter:"test",secretVerifierKey:"integration-verifier-key-at-least-32-characters",secretVerifierKeyVersion:"v1",jwtIssuer:"integration",jwtKeyId:"integration-v1",jwtPrivateKeyBase64:privateKey,jwtPublicKeyBase64:publicKey,accessTokenLifetimeSeconds:600,argon2MemoryCost:19456,argon2TimeCost:2,argon2Parallelism:1};

describe("M2 authentication PostgreSQL behavior",()=>{
  const databaseName=`pip_pip_v3_test_${crypto.randomUUID().replaceAll("-","")}`; let admin:SQL; let client:SQL; let delivery:TestOtpDelivery; let service:AuthService; let limiterClock=Date.now();
  const advanceRateWindows=()=>{limiterClock+=3_600_001;};
  beforeAll(async()=>{admin=new SQL(adminUrl,{max:1});await admin.unsafe(`create database "${databaseName}"`);const url=new URL(adminUrl);url.pathname=`/${databaseName}`;client=new SQL(url.toString(),{max:10});await applyMigrations(client);delivery=new TestOtpDelivery();service=new AuthService(client,new InMemoryRateLimiter(()=>limiterClock),delivery,config);},30000);
  afterAll(async()=>{if(client)await client.close();if(admin){await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);await admin.close();}});

  test("OTP request creates no account and replacement invalidates the predecessor",async()=>{
    const first=await service.requestOtp({phone:"+9647701000000",applicationType:"CUSTOMER_APP",ip:"1",requestId:"otp-request-1"});
    expect(Number((await client<{count:string}[]>`select count(*)::text count from accounts`)[0]!.count)).toBe(0);
    advanceRateWindows();
    const second=await service.requestOtp({phone:"+9647701000000",applicationType:"CUSTOMER_APP",ip:"2",requestId:"otp-request-2"});
    const [old]=await client<{invalidated_at:Date|null;replacement_challenge_id:string|null}[]>`select invalidated_at,replacement_challenge_id from otp_challenges where id=${first}`;
    expect(old!.invalidated_at).not.toBeNull();expect(old!.replacement_challenge_id).toBe(second);
  });

  test("failed attempts persist atomically and the fifth exhausts the challenge",async()=>{
    const id=await service.requestOtp({phone:"+9647701000001",applicationType:"CUSTOMER_APP",ip:"3",requestId:"attempt-request"});
    for(let n=0;n<5;n++) await expect(service.verifyOtp({challengeId:id,otp:"000000",applicationType:"CUSTOMER_APP",deviceId:undefined,deviceName:"phone",ip:`attempt-${n}`,requestId:`attempt-${n}`})).rejects.toThrow();
    const [row]=await client<{attempt_count:number;invalidated_at:Date|null}[]>`select attempt_count,invalidated_at from otp_challenges where id=${id}`;expect(row!.attempt_count).toBe(5);expect(row!.invalidated_at).not.toBeNull();
  });

  test("only one concurrent verification consumes a challenge",async()=>{
    const id=await service.requestOtp({phone:"+9647701000010",applicationType:"CUSTOMER_APP",ip:"concurrent-request",requestId:"concurrent-request"});
    const otp=delivery.deliveries.at(-1)!.otp;
    const results=await Promise.allSettled([0,1].map(n=>service.verifyOtp({challengeId:id,otp,applicationType:"CUSTOMER_APP",deviceId:`concurrent-${n}`,deviceName:"phone",ip:`concurrent-${n}`,requestId:`concurrent-${n}`})));
    expect(results.filter(result=>result.status==="fulfilled").length).toBe(1);
    const [challenge]=await client<{consumed_at:Date|null;attempt_count:number}[]>`select consumed_at,attempt_count from otp_challenges where id=${id}`;
    expect(challenge!.consumed_at).not.toBeNull();expect(challenge!.attempt_count).toBe(0);
  });

  test("successful customer verification creates one account/profile and enforces five sessions",async()=>{
    const phone="+9647701000002";let lastAccount="";
    for(let n=0;n<6;n++){if(n)advanceRateWindows();const id=await service.requestOtp({phone,applicationType:"CUSTOMER_APP",ip:`customer-request-${n}`,requestId:`customer-request-${n}`});const otp=delivery.deliveries.at(-1)!.otp;const result=await service.verifyOtp({challengeId:id,otp,applicationType:"CUSTOMER_APP",deviceId:`d${n}`,deviceName:`phone ${n}`,ip:`customer-verify-${n}`,requestId:`customer-verify-${n}`});const [session]=await client<{account_id:string}[]>`select account_id from sessions where id=${result.session_id}`;lastAccount=session!.account_id;}
    expect(Number((await client<{count:string}[]>`select count(*)::text count from account_phones where phone_e164=${phone}`)[0]!.count)).toBe(1);
    expect(Number((await client<{count:string}[]>`select count(*)::text count from customer_profiles where account_id=${lastAccount}`)[0]!.count)).toBe(1);
    expect(Number((await client<{count:string}[]>`select count(*)::text count from sessions where account_id=${lastAccount} and application_type='CUSTOMER_APP' and revoked_at is null`)[0]!.count)).toBe(5);
  });

  test("driver eligibility and replacement preserve customer sessions",async()=>{
    const phone="+9647701000003";const [account]=await client<{id:string}[]>`insert into accounts default values returning id`;await client`insert into account_phones(account_id,phone_e164,verified_at,is_primary)values(${account!.id},${phone},now(),true)`;
    const denied=await service.requestOtp({phone,applicationType:"DRIVER_APP",ip:"driver-denied",requestId:"driver-denied"});await expect(service.verifyOtp({challengeId:denied,otp:delivery.deliveries.at(-1)!.otp,applicationType:"DRIVER_APP",deviceId:undefined,deviceName:"driver",ip:"driver-denied-v",requestId:"driver-denied-v"})).rejects.toThrow();
    const [reviewer]=await client<{id:string}[]>`insert into accounts default values returning id`;const [application]=await client<{id:string}[]>`insert into driver_applications(account_id,status,decided_at,decided_by_account_id)values(${account!.id},'APPROVED',now(),${reviewer!.id})returning id`;await client`insert into driver_profiles(account_id,approved_application_id,operational_status,driver_photo_object_key)values(${account!.id},${application!.id},'ACTIVE','photo')`;
    await client`insert into sessions(account_id,application_type,authentication_method,device_name,absolute_expires_at)values(${account!.id},'CUSTOMER_APP','PHONE_OTP','customer',now()+interval '1 day')`;
    for(let n=0;n<2;n++){advanceRateWindows();const id=await service.requestOtp({phone,applicationType:"DRIVER_APP",ip:`driver-${n}`,requestId:`driver-${n}`});await service.verifyOtp({challengeId:id,otp:delivery.deliveries.at(-1)!.otp,applicationType:"DRIVER_APP",deviceId:undefined,deviceName:"driver",ip:`driver-v-${n}`,requestId:`driver-v-${n}`});}
    expect(Number((await client<{count:string}[]>`select count(*)::text count from sessions where account_id=${account!.id} and application_type='DRIVER_APP' and revoked_at is null`)[0]!.count)).toBe(1);expect(Number((await client<{count:string}[]>`select count(*)::text count from sessions where account_id=${account!.id} and application_type='CUSTOMER_APP' and revoked_at is null`)[0]!.count)).toBe(1);
  });

  test("staff password login is enumeration-safe and limits dashboard sessions to three",async()=>{
    const [account]=await client<{id:string}[]>`insert into accounts default values returning id`;await client`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${account!.id},'Staff@Example.com','staff@example.com',now(),true)`;await client`insert into staff_profiles(account_id,status)values(${account!.id},'ACTIVE')`;const [role]=await client<{id:string}[]>`select id from roles where code='SUPPORT'`;await client`insert into account_roles(account_id,role_id,granted_by_account_id)values(${account!.id},${role!.id},${account!.id})`;
    const hasher=new Argon2PasswordHasher({memoryCost:19456,timeCost:2,parallelism:1});await client`insert into password_credentials(account_id,argon2id_hash)values(${account!.id},${await hasher.hash("fixed staff password")})`;
    await expect(service.staffLogin({email:"missing@example.com",password:"wrong password value",deviceId:undefined,deviceName:"x",ip:"staff-missing",requestId:"staff-missing"})).rejects.toThrow();
    let lastStaffSession!:Awaited<ReturnType<AuthService["staffLogin"]>>;
    for(let n=0;n<4;n++)lastStaffSession=await service.staffLogin({email:"STAFF@example.com",password:"fixed staff password",deviceId:`s${n}`,deviceName:`staff ${n}`,ip:`staff-${n}`,requestId:`staff-${n}`});
    expect(Number((await client<{count:string}[]>`select count(*)::text count from sessions where account_id=${account!.id} and application_type='DASHBOARD' and revoked_at is null`)[0]!.count)).toBe(3);
    await service.authenticate(lastStaffSession.access_token,"staff-role-active");
    await client`update account_roles set revoked_at=now() where account_id=${account!.id}`;
    await expect(service.authenticate(lastStaffSession.access_token,"staff-role-revoked")).rejects.toThrow();
    await expect(service.refresh(lastStaffSession.refresh_token,"staff-role-refresh","staff-role-refresh")).rejects.toThrow();
  });

  test("refresh rotates once, reuse revokes, logout is idempotent, and ownership is enforced",async()=>{
    const id=await service.requestOtp({phone:"+9647701000004",applicationType:"CUSTOMER_APP",ip:"refresh-request",requestId:"refresh-request"});const initial=await service.verifyOtp({challengeId:id,otp:delivery.deliveries.at(-1)!.otp,applicationType:"CUSTOMER_APP",deviceId:undefined,deviceName:"phone",ip:"refresh-verify",requestId:"refresh-verify"});
    const [initialState]=await client<{application_type:string;account_status:string;profile_status:string}[]>`select s.application_type::text application_type,a.status::text account_status,c.status::text profile_status from sessions s join accounts a on a.id=s.account_id join customer_profiles c on c.account_id=s.account_id where s.id=${initial.session_id}`;
    expect(initialState).toEqual({application_type:"CUSTOMER_APP",account_status:"ACTIVE",profile_status:"ACTIVE"});
    const next=await service.refresh(initial.refresh_token,"refresh-ip","refresh-1");expect(next.refresh_token).not.toBe(initial.refresh_token);await expect(service.refresh(initial.refresh_token,"refresh-ip-2","refresh-reuse")).rejects.toThrow();const logoutIdentity=await service.identifyAccessToken(initial.access_token);await service.logout(logoutIdentity,"logout-1");await service.logout(await service.identifyAccessToken(initial.access_token),"logout-2");
    const [other]=await client<{id:string}[]>`insert into accounts default values returning id`;await expect(service.revokeSession({accountId:other!.id,sessionId:crypto.randomUUID()},initial.session_id,"ownership-request")).rejects.toThrow();
  });

  test("concurrent refresh has one winner and reuse revokes the affected session",async()=>{
    advanceRateWindows();
    const id=await service.requestOtp({phone:"+9647701000011",applicationType:"CUSTOMER_APP",ip:"race-request",requestId:"race-request"});
    const initial=await service.verifyOtp({challengeId:id,otp:delivery.deliveries.at(-1)!.otp,applicationType:"CUSTOMER_APP",deviceId:"race-device",deviceName:"phone",ip:"race-verify",requestId:"race-verify"});
    const outcomes=await Promise.allSettled([
      service.refresh(initial.refresh_token,"race-refresh-1","race-refresh-1"),
      service.refresh(initial.refresh_token,"race-refresh-2","race-refresh-2"),
    ]);
    expect(outcomes.filter(result=>result.status==="fulfilled").length).toBe(1);
    expect(outcomes.filter(result=>result.status==="rejected").length).toBe(1);
    const [session]=await client<{revoked_at:Date|null;revocation_reason:string|null}[]>`select revoked_at,revocation_reason from sessions where id=${initial.session_id}`;
    expect(session!.revoked_at).not.toBeNull();expect(session!.revocation_reason).toBe("TOKEN_REUSE_DETECTED");
    expect(Number((await client<{count:string}[]>`select count(*)::text count from session_refresh_tokens where session_id=${initial.session_id} and generation=1`)[0]!.count)).toBe(1);
  });

  test("current account, profile, and session state blocks access and refresh immediately",async()=>{
    advanceRateWindows();
    const id=await service.requestOtp({phone:"+9647701000012",applicationType:"CUSTOMER_APP",ip:"state-request",requestId:"state-request"});
    const issued=await service.verifyOtp({challengeId:id,otp:delivery.deliveries.at(-1)!.otp,applicationType:"CUSTOMER_APP",deviceId:"state-device",deviceName:"phone",ip:"state-verify",requestId:"state-verify"});
    const auth=await service.authenticate(issued.access_token,"state-valid");
    await client`update customer_profiles set status='SUSPENDED' where account_id=${auth.accountId}`;
    await expect(service.authenticate(issued.access_token,"state-profile-denied")).rejects.toThrow();
    await expect(service.refresh(issued.refresh_token,"state-refresh-profile","state-refresh-profile")).rejects.toThrow();
    await client`update customer_profiles set status='ACTIVE' where account_id=${auth.accountId}`;
    await client`update accounts set status='SUSPENDED' where id=${auth.accountId}`;
    await expect(service.authenticate(issued.access_token,"state-account-denied")).rejects.toThrow();
    await client`update accounts set status='ACTIVE' where id=${auth.accountId}`;
    await client`update sessions set revoked_at=now(),revocation_reason='TEST' where id=${issued.session_id}`;
    await expect(service.authenticate(issued.access_token,"state-session-denied")).rejects.toThrow();
  });

  test("audit request IDs remain textual and metadata contains no credentials",async()=>{const [row]=await client<{request_correlation_id:string;redacted_metadata:Record<string,unknown>}[]>`select request_correlation_id,redacted_metadata from audit_logs where request_correlation_id='otp-request-1'`;expect(row!.request_correlation_id).toBe("otp-request-1");expect(JSON.stringify(row!.redacted_metadata)).not.toMatch(/otp|token|password/i);});
});
