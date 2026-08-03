import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { silentLogger } from "../../src/observability/logger";
import type { AuthModule } from "../../src/modules/auth/auth-module";
import { AppError } from "../../src/errors/app-error";

function appWith(readinessCheck: () => Promise<void> = async () => undefined) {
  return createApp({ logger: silentLogger, production: false, readinessCheck });
}
const fakeModule = (overrides: Partial<AuthModule> = {}): AuthModule => {
  const empty = new Proxy({}, { get: () => async () => ({}) });
  return { customer: empty, driver: empty, dashboard: empty, sessions: empty, ...overrides } as AuthModule;
};

describe("API foundation", () => {
  test("liveness has a stable response and does not call PostgreSQL", async () => {
    let called = false;
    const app = appWith(async () => { called = true; });
    const response = await app.handle(new Request("http://localhost/health/live"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "pip_pip_api_v3" });
    expect(called).toBeFalse();
  });

  test("readiness succeeds when PostgreSQL is reachable", async () => {
    const response = await appWith().handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { database: "up" } });
  });

  test("readiness returns 503 when PostgreSQL is unavailable", async () => {
    const response = await appWith(async () => { throw new Error("database detail must not leak"); })
      .handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", checks: { database: "down" } });
  });

  test("readiness reports Redis failure without misreporting PostgreSQL", async () => {
    const app=createApp({logger:silentLogger,production:false,readinessCheck:async()=>undefined,redisReadinessCheck:async()=>{throw new Error("redis credential detail");}});
    const response=await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({status:"not_ready",checks:{database:"up",redis:"down"}});
  });

  test("accepts a valid incoming request ID", async () => {
    const response = await appWith().handle(new Request("http://localhost/health/live", { headers: { "x-request-id": "client-request_123" } }));
    expect(response.headers.get("x-request-id")).toBe("client-request_123");
  });

  test("generates a request ID when absent or invalid", async () => {
    const app = appWith();
    const absent = await app.handle(new Request("http://localhost/health/live"));
    const invalid = await app.handle(new Request("http://localhost/health/live", { headers: { "x-request-id": "invalid request id" } }));
    const tooLong = await app.handle(new Request("http://localhost/health/live", { headers: { "x-request-id": `a${"b".repeat(128)}` } }));
    expect(absent.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(invalid.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(tooLong.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("returns a safe unexpected-error response", async () => {
    const app = appWith().get("/_test/error", () => { throw new Error("sensitive database detail"); });
    const response = await app.handle(new Request("http://localhost/_test/error"));
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string }; request_id: string };
    expect(body.error).toEqual({ code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" });
    const responseRequestId = response.headers.get("x-request-id");
    expect(responseRequestId).not.toBeNull();
    expect(body.request_id).toBe(responseRequestId!);
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
  });

  test("publishes the raw OpenAPI document", async () => {
    const response = await appWith().handle(new Request("http://localhost/openapi/json"));
    expect(response.status).toBe(200);
    const document = await response.json() as { info: { title: string }; paths: Record<string, unknown> };
    expect(document.info.title).toBe("pip_pip_api_v3");
    expect(document.paths["/health/live"]).toBeDefined();
  });

  test("registers every application route under /api/v1 with no unprefixed aliases", async () => {
    const app = createApp({ logger: silentLogger, production: false, readinessCheck: async () => undefined, authModule: fakeModule() });
    const document = await (await app.handle(new Request("http://localhost/openapi/json"))).json() as { paths: Record<string,Record<string,{requestBody?:unknown;responses?:unknown;security?:unknown}>> };
    const applicationPaths=Object.keys(document.paths).filter(path=>path.includes("auth"));
    expect(applicationPaths.length).toBe(18);
    expect(applicationPaths.every(path=>path.startsWith("/api/v1/mobile/customer/")||path.startsWith("/api/v1/mobile/driver/")||path.startsWith("/api/v1/dashboard/"))).toBeTrue();
    expect(applicationPaths.some(path=>path.startsWith("/api/v1/auth/")||path.startsWith("/v1/")||path.startsWith("/auth/"))).toBeFalse();
    for (const path of applicationPaths) {
      const operation = Object.values(document.paths[path]!).find(value=>value && typeof value==="object" && "responses" in value);
      expect(operation?.responses).toBeDefined();
    }
    expect(document.paths["/api/v1/mobile/customer/auth/otp/request"]?.post?.requestBody).toBeDefined();
    expect(document.paths["/api/v1/mobile/driver/auth/otp/request"]).toBeUndefined();
    expect(document.paths["/api/v1/mobile/customer/auth/sessions"]?.get?.security).toEqual([{bearerAuth:[]}]);
    expect(document.paths["/api/v1/mobile/driver/auth/sessions"]?.get?.security).toEqual([{bearerAuth:[]}]);
    expect(document.paths["/api/v1/dashboard/auth/sessions"]?.get?.security).toEqual([{bearerAuth:[]}]);
    const openApiText=JSON.stringify(document);
    for(const field of ["appType","applicationType","application","audience","clientType"]) expect(openApiText.includes(`\"${field}\"`)).toBeFalse();
  });

  test("returns a stable safe validation error", async () => {
    const app = createApp({ logger: silentLogger, production: true, readinessCheck: async () => undefined, authModule: fakeModule() });
    const response = await app.handle(new Request("http://localhost/api/v1/dashboard/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }) }));
    expect(response.status).toBe(422);
    const body = await response.json() as {error:{code:string;message:string};request_id:string};
    expect(body.error).toEqual({code:"VALIDATION_FAILED",message:"The request is invalid"});
    expect(body.request_id).toBe(response.headers.get("x-request-id")!);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  test("OTP request is generic 202 and staff failures are enumeration-safe", async () => {
    const challengeId=crypto.randomUUID();
    const customer=new Proxy({requestOtp:async()=>challengeId},{get:(target,property)=>Reflect.get(target,property)??(async()=>({}))});
    const dashboard=new Proxy({login:async()=>{throw new AppError(401,"INVALID_CREDENTIALS","Invalid credentials");}},{get:(target,property)=>Reflect.get(target,property)??(async()=>({}))});
    const app=createApp({logger:silentLogger,production:true,readinessCheck:async()=>undefined,authModule:fakeModule({customer,dashboard} as unknown as Partial<AuthModule>)});
    const otp=await app.handle(new Request("http://localhost/api/v1/mobile/customer/auth/otp/request",{method:"POST",headers:{"content-type":"application/json","x-request-id":"otp-public-request"},body:JSON.stringify({phone:"+9647700000000"})}));
    expect(otp.status).toBe(202);
    const otpBody=await otp.json() as Record<string,unknown>;
    expect(otpBody).toEqual({accepted:true,challenge_id:challengeId,request_id:"otp-public-request"});
    expect("otp" in otpBody).toBeFalse();
    expect(JSON.stringify(otpBody)).not.toMatch(/password|refresh_token|access_token/i);
    const staff=await app.handle(new Request("http://localhost/api/v1/dashboard/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"unknown@example.com",password:"a sufficiently long password",device_name:"browser"})}));
    expect(staff.status).toBe(401);
    expect((await staff.json() as {error:{code:string}}).error.code).toBe("INVALID_CREDENTIALS");
  });

  test("rejects obsolete routes and client-controlled authentication context", async () => {
    let called=0;const customer=new Proxy({requestOtp:async()=>{called++;return crypto.randomUUID();}},{get:(target,property)=>Reflect.get(target,property)??(async()=>({}))});
    const app=createApp({logger:silentLogger,production:false,readinessCheck:async()=>undefined,authModule:fakeModule({customer} as unknown as Partial<AuthModule>)});
    for(const path of["/api/v1/auth/phone/otp/request","/api/v1/mobile/driver/auth/otp/request","/v1/auth/phone/otp/request","/auth/phone/otp/request"]){const response=await app.handle(new Request(`http://localhost${path}`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}));expect(response.status).toBe(404);}
    const injected=await app.handle(new Request("http://localhost/api/v1/mobile/customer/auth/otp/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:"+9647700000000",applicationType:"DRIVER_APP"})}));
    expect(injected.status).toBe(422);expect(called).toBe(0);
  });
});
