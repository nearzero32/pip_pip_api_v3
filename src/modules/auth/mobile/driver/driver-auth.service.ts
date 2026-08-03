import type { SQL } from "bun";
import { AppError } from "../../../../errors/app-error";
import type { SecurityAuditWriter } from "../../audit/audit-writer";
import { driverContext } from "../../core/context";
import type { RateLimiter } from "../../rate-limit/rate-limiter";
import { rateLimitKey } from "../../rate-limit/rate-limiter";
import { normalizePhone } from "../../shared/normalization";
import type { HmacSecretVerifier } from "../../shared/secret-verifier";
import type { Argon2PasswordHasher } from "../../staff/password";
import type { SessionResult,SessionService } from "../../sessions/session-service";

export class DriverAuthService{
 private dummyHash:Promise<string>|undefined;
 constructor(private client:SQL,private limiter:RateLimiter,private password:Argon2PasswordHasher,private key:HmacSecretVerifier,private sessions:SessionService,private audit:SecurityAuditWriter){}
 private dummyVerificationHash(){return this.dummyHash??=this.password.hash("000000000000");}
 async login(input:{phone:string;code:string;deviceId?:string;deviceName:string;ip:string;requestId:string}):Promise<SessionResult>{if(!/^[0-9]{6,12}$/.test(input.code))throw new AppError(401,"INVALID_CREDENTIALS","Invalid credentials");const phone=normalizePhone(input.phone),phoneKey=await this.key.create(phone);for(const[key,limit]of[[rateLimitKey("driver","login","phone",phoneKey),12],[rateLimitKey("driver","login","ip",input.ip),30]]as const){const result=await this.limiter.consume(key,{limit,windowSeconds:900});if(!result.allowed){await this.audit.write({event:"DRIVER_LOGIN_FAILED",outcome:"DENIED",requestId:input.requestId,applicationType:"DRIVER_APP",reasonCode:"RATE_LIMITED"});throw new AppError(429,"RATE_LIMITED","Too many requests",result.retryAfterSeconds);}}
 const[record]=await this.client<{account_id:string;access_code_hash:string|null;account_status:string;approval_status:string;operational_status:string}[]>`select a.id account_id,d.access_code_hash,a.status account_status,d.approval_status,d.operational_status from account_phones p join accounts a on a.id=p.account_id join driver_profiles d on d.account_id=a.id where p.phone_e164=${phone} and p.verified_at is not null limit 1`;const valid=await this.password.verify(input.code,record?.access_code_hash??await this.dummyVerificationHash()).catch(()=>false);if(!record||!valid||record.account_status!=="ACTIVE"||record.approval_status!=="APPROVED"||record.operational_status!=="ACTIVE"){await this.audit.write({event:"DRIVER_LOGIN_FAILED",outcome:"FAILURE",requestId:input.requestId,applicationType:"DRIVER_APP",reasonCode:"INVALID_CREDENTIALS"});throw new AppError(401,"INVALID_CREDENTIALS","Invalid credentials");}let replaced=false;const created=await this.client.begin(async tx=>{replaced=Boolean((await tx`select 1 from sessions where account_id=${record.account_id} and application_type='DRIVER_APP' and revoked_at is null for update`).length);return this.sessions.create(tx,record.account_id,driverContext,"DRIVER_ACCESS_CODE",input.deviceId,input.deviceName);});await this.audit.write({event:"DRIVER_LOGIN_SUCCEEDED",outcome:"SUCCESS",requestId:input.requestId,accountId:record.account_id,sessionId:created.sessionId,applicationType:"DRIVER_APP"});if(replaced)await this.audit.write({event:"DRIVER_SESSION_REPLACED",outcome:"SUCCESS",requestId:input.requestId,accountId:record.account_id,sessionId:created.sessionId,applicationType:"DRIVER_APP"});return this.sessions.result(record.account_id,created,driverContext);}
}
