import { t } from "elysia";
import { AppError } from "../../../errors/app-error";

export const errorResponse=t.Object({error:t.Object({code:t.String(),message:t.String()}),request_id:t.String()});
export const sessionResponse=t.Object({access_token:t.String(),access_token_expires_at:t.String({format:"date-time"}),refresh_token:t.String(),session_id:t.String({format:"uuid"}),application_type:t.Union([t.Literal("CUSTOMER_APP"),t.Literal("DRIVER_APP"),t.Literal("DASHBOARD")])});
export const standardErrors={401:errorResponse,422:errorResponse,429:errorResponse,500:errorResponse,503:errorResponse};
export const deviceFields={device_id:t.Optional(t.String({maxLength:256})),device_name:t.String({minLength:1,maxLength:128})};
export const refreshBody=t.Object({refresh_token:t.String({minLength:43,maxLength:256})},{additionalProperties:false});
export const revokedResponse=t.Object({revoked:t.Boolean(),request_id:t.String()});
export const sessionsResponse=t.Object({sessions:t.Array(t.Object({id:t.String({format:"uuid"}),application_type:t.Union([t.Literal("CUSTOMER_APP"),t.Literal("DRIVER_APP"),t.Literal("DASHBOARD")]),device_id:t.Nullable(t.String()),device_name:t.String(),created_at:t.String(),last_used_at:t.Nullable(t.String()),absolute_expires_at:t.String(),revoked_at:t.Nullable(t.String())}))});
export const bearer=(request:Request)=>{const header=request.headers.get("authorization");if(!header?.startsWith("Bearer ")||header.length>8192)throw new AppError(401,"UNAUTHENTICATED","Authentication required");return header.slice(7);};
export const ipOf=(request:Request,server:{requestIP(request:Request):{address:string}|null}|null)=>(server?.requestIP(request)?.address??"unknown").slice(0,64);
export const requestIdOf=(set:{headers:Record<string,string|number|readonly string[]>})=>String(set.headers["x-request-id"]??crypto.randomUUID());
const forbiddenContextKeys=new Set(["apptype","applicationtype","application","audience","clienttype"]);
export const rejectAuthenticationContext=(body:unknown)=>{if(body&&typeof body==="object"&&Object.keys(body).some(key=>forbiddenContextKeys.has(key.replaceAll("_","").toLowerCase())))throw new Error("AUTH_CONTEXT_FIELD");};
export const parseAuthenticationBody=async({request,contentType}:{request:Request;contentType:string})=>{if(!contentType.toLowerCase().includes("application/json"))return;const body=await request.clone().json().catch(()=>undefined);rejectAuthenticationContext(body);return body;};
