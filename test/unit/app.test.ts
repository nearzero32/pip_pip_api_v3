import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { silentLogger } from "../../src/observability/logger";
import type { AuthModule } from "../../src/modules/auth/auth-module";
import { AppError } from "../../src/errors/app-error";
import type { GeographyService } from "../../src/modules/geography/service";

function appWith(readinessCheck: () => Promise<void> = async () => undefined) {
  return createApp({ logger: silentLogger, production: false, readinessCheck });
}
const fakeModule = (overrides: Partial<AuthModule> = {}): AuthModule => {
  const empty = new Proxy({}, { get: () => async () => ({}) });
  return {
    customer: empty,
    driver: empty,
    dashboard: empty,
    sessions: empty,
    roles: empty,
    staff: empty,
    client: empty,
    ...overrides,
  } as AuthModule;
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

  test("registers M3-A geography routes without prohibited request fields", async () => {
    const app=createApp({logger:silentLogger,production:false,readinessCheck:async()=>undefined,authModule:fakeModule(),geographyService:{} as GeographyService});
    const document=await (await app.handle(new Request("http://localhost/openapi/json"))).json() as {paths:Record<string,unknown>};
    for(const path of ["/api/v1/dashboard/governorates","/api/v1/dashboard/governorates/{governorateId}","/api/v1/dashboard/cities","/api/v1/dashboard/cities/{cityId}","/api/v1/dashboard/cities/{cityId}/activate","/api/v1/dashboard/cities/{cityId}/suspend","/api/v1/dashboard/cities/{cityId}/archive","/api/v1/public/cities","/api/v1/dashboard/zones","/api/v1/dashboard/zones/{zoneId}","/api/v1/public/zones","/api/v1/public/zones/resolve"]) expect(document.paths[path]).toBeDefined();
    expect(document.paths["/api/v1/mobile/customer/cities"]).toBeUndefined();
    expect(document.paths["/api/v1/mobile/driver/cities"]).toBeUndefined();
    expect(document.paths["/api/v1/public/governorates"]).toBeUndefined();
    const geographyText=JSON.stringify(Object.fromEntries(Object.entries(document.paths).filter(([path])=>path.includes("governorates")||path.includes("/cities")).map(([path,operations])=>[path,Object.fromEntries(Object.entries(operations as Record<string,unknown>).map(([method,operation])=>[method,{requestBody:(operation as {requestBody?:unknown}).requestBody,parameters:(operation as {parameters?:unknown}).parameters}]))])));
    for(const field of ["code","slug","isVisible","isDisplay","boundary","polygon","geometry","zoneId"]) expect(geographyText.includes(`\"${field}\"`)).toBeFalse();
  });

  test("M3-A OpenAPI contracts are typed without Any and document endpoint-specific errors", async () => {
    const app = createApp({
      logger: silentLogger,
      production: false,
      readinessCheck: async () => undefined,
      authModule: fakeModule(),
      geographyService: {} as GeographyService,
    });
    const document = (await (
      await app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as {
      components?: { schemas?: Record<string, unknown> };
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: { content?: Record<string, { schema?: unknown }> };
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >;
            security?: unknown;
          }
        >
      >;
    };

    type JsonSchema = Record<string, unknown>;

    const resolveLocalRef = (
      schema: unknown,
      seen: Set<string>,
    ): unknown => {
      if (!schema || typeof schema !== "object" || Array.isArray(schema))
        return schema;
      const ref = (schema as JsonSchema).$ref;
      if (typeof ref !== "string") return schema;
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
      if (!match) throw new Error(`Unsupported OpenAPI $ref: ${ref}`);
      if (seen.has(ref)) throw new Error(`Cyclic OpenAPI $ref: ${ref}`);
      const target = document.components?.schemas?.[match[1]!];
      if (target == null) throw new Error(`Unresolved OpenAPI $ref: ${ref}`);
      seen.add(ref);
      return resolveLocalRef(target, seen);
    };

    /** True when a schema node itself is unconstrained (not composition wrappers). */
    const isUnconstrainedSchemaNode = (schema: unknown): boolean => {
      if (schema === true) return true;
      if (schema == null || typeof schema !== "object" || Array.isArray(schema))
        return false;
      const record = schema as JsonSchema;
      const keys = Object.keys(record);
      if (keys.length === 0) return true;
      if (record.type === "Any" || record.type === "any") return true;
      const hasShape =
        "type" in record ||
        "properties" in record ||
        "items" in record ||
        "anyOf" in record ||
        "oneOf" in record ||
        "allOf" in record ||
        "$ref" in record ||
        "enum" in record ||
        "const" in record ||
        "additionalProperties" in record;
      return !hasShape;
    };

    const assertConstrainedGeographySuccessSchema = (
      schema: unknown,
      path: string,
      seenRefs = new Set<string>(),
    ) => {
      const resolved = resolveLocalRef(schema, new Set(seenRefs));
      if (isUnconstrainedSchemaNode(resolved)) {
        throw new Error(`Unconstrained OpenAPI success schema at ${path}`);
      }
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved))
        return;
      const record = resolved as JsonSchema;
      if (record.type === "Any" || record.type === "any") {
        throw new Error(`Unexpected Any schema at ${path}`);
      }
      if (Array.isArray(record.anyOf)) {
        for (const [i, child] of record.anyOf.entries()) {
          assertConstrainedGeographySuccessSchema(
            child,
            `${path}.anyOf[${i}]`,
            seenRefs,
          );
        }
      }
      if (Array.isArray(record.oneOf)) {
        for (const [i, child] of record.oneOf.entries()) {
          assertConstrainedGeographySuccessSchema(
            child,
            `${path}.oneOf[${i}]`,
            seenRefs,
          );
        }
      }
      if (Array.isArray(record.allOf)) {
        for (const [i, child] of record.allOf.entries()) {
          assertConstrainedGeographySuccessSchema(
            child,
            `${path}.allOf[${i}]`,
            seenRefs,
          );
        }
      }
      if (record.properties && typeof record.properties === "object") {
        for (const [key, child] of Object.entries(
          record.properties as Record<string, unknown>,
        )) {
          assertConstrainedGeographySuccessSchema(
            child,
            `${path}.properties.${key}`,
            seenRefs,
          );
        }
      }
      if ("items" in record) {
        assertConstrainedGeographySuccessSchema(
          record.items,
          `${path}.items`,
          seenRefs,
        );
      }
      if (
        "additionalProperties" in record &&
        typeof record.additionalProperties === "object"
      ) {
        assertConstrainedGeographySuccessSchema(
          record.additionalProperties,
          `${path}.additionalProperties`,
          seenRefs,
        );
      }
    };

    const schemaTypes = (schema: unknown): string[] => {
      const resolved = resolveLocalRef(schema, new Set());
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved))
        return [];
      const record = resolved as JsonSchema;
      if (typeof record.type === "string") return [record.type];
      if (Array.isArray(record.type))
        return record.type.filter((value): value is string => typeof value === "string");
      const collected: string[] = [];
      for (const key of ["anyOf", "oneOf"] as const) {
        const variants = record[key];
        if (!Array.isArray(variants)) continue;
        for (const variant of variants) {
          collected.push(...schemaTypes(variant));
        }
      }
      if (record.nullable === true && collected.length === 0 && !record.type) {
        // OpenAPI 3.0 nullable without composition is handled by callers via type+nullable
      }
      return collected;
    };

    const isNumberOrNullSchema = (schema: unknown): boolean => {
      const resolved = resolveLocalRef(schema, new Set());
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved))
        return false;
      const record = resolved as JsonSchema;
      const types = schemaTypes(resolved);
      if (types.includes("number") && types.includes("null")) return true;
      if (record.type === "number" && record.nullable === true) return true;
      return false;
    };

    const publicSuccessSchema = resolveLocalRef(
      document.paths["/api/v1/public/cities"]!.get!.responses!["200"]!
        .content!["application/json"]!.schema,
      new Set(),
    ) as JsonSchema;
    const publicItems = resolveLocalRef(
      (publicSuccessSchema.properties as JsonSchema)?.data &&
        ((publicSuccessSchema.properties as JsonSchema).data as JsonSchema)
          .items,
      new Set(),
    ) as JsonSchema;
    const publicCityProperties = (publicItems.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(isNumberOrNullSchema(publicCityProperties.latitude)).toBeTrue();
    expect(isNumberOrNullSchema(publicCityProperties.longitude)).toBeTrue();
    expect(publicCityProperties).not.toHaveProperty("archivedAt");
    expect(publicCityProperties).not.toHaveProperty("createdAt");
    expect(publicCityProperties).not.toHaveProperty("updatedAt");
    expect(publicCityProperties).not.toHaveProperty("displayOrder");
    expect(publicCityProperties).not.toHaveProperty("status");

    const geographyPaths = Object.entries(document.paths).filter(
      ([path]) => path.includes("governorates") || path.includes("cities"),
    );
    for (const [path, methods] of geographyPaths) {
      for (const [method, operation] of Object.entries(methods)) {
        const success =
          operation.responses?.["200"]?.content?.["application/json"]?.schema;
        expect(success).toBeDefined();
        assertConstrainedGeographySuccessSchema(
          success,
          `${path}.${method}.responses.200`,
        );
      }
    }

    const cityPost =
      document.paths["/api/v1/dashboard/cities"]!.post!.responses!["200"]!
        .content!["application/json"]!.schema as Record<string, unknown>;
    expect(JSON.stringify(cityPost)).toContain("latitude");
    expect(JSON.stringify(cityPost)).toContain("longitude");
    expect(JSON.stringify(cityPost)).toMatch(/"type"\s*:\s*"number"/);

    // Elysia currently emits empty requestBody.content; required:true still marks the body mandatory.
    // Empty PATCH rejection is proven by the runtime validation test below.
    const cityPatchBody = document.paths["/api/v1/dashboard/cities/{cityId}"]!
      .patch!.requestBody as { required?: boolean; content?: unknown };
    expect(cityPatchBody.required).toBeTrue();

    const responseKeys = (path: string, method: string) =>
      Object.keys(document.paths[path]![method]!.responses ?? {}).sort();

    expect(responseKeys("/api/v1/dashboard/governorates", "get")).not.toContain("403");
    expect(responseKeys("/api/v1/dashboard/governorates", "get")).not.toContain("404");
    expect(responseKeys("/api/v1/dashboard/governorates", "get")).not.toContain("409");
    expect(responseKeys("/api/v1/dashboard/governorates/{governorateId}", "patch")).toContain("403");
    expect(responseKeys("/api/v1/dashboard/governorates/{governorateId}", "patch")).toContain("404");
    expect(responseKeys("/api/v1/dashboard/cities", "get")).not.toContain("409");
    expect(responseKeys("/api/v1/dashboard/cities/{cityId}", "get")).toContain("404");
    expect(responseKeys("/api/v1/dashboard/cities", "post")).toContain("403");
    expect(responseKeys("/api/v1/dashboard/cities", "post")).not.toContain("404");
    expect(responseKeys("/api/v1/dashboard/cities/{cityId}/activate", "post")).toEqual(
      expect.arrayContaining(["403", "404", "409"]),
    );
    expect(responseKeys("/api/v1/public/cities", "get")).toEqual(["200", "422", "500"]);
    expect(responseKeys("/api/v1/public/cities", "get")).not.toContain("401");
    expect(responseKeys("/api/v1/public/cities", "get")).not.toContain("403");
    expect(responseKeys("/api/v1/public/cities", "get")).not.toContain("404");
    expect(responseKeys("/api/v1/public/cities", "get")).not.toContain("409");
    expect(responseKeys("/api/v1/public/cities", "get")).not.toContain("503");
    expect(document.paths["/api/v1/public/cities"]!.get!.security).toBeUndefined();
    expect(document.paths["/api/v1/mobile/customer/cities"]).toBeUndefined();
    expect(document.paths["/api/v1/mobile/driver/cities"]).toBeUndefined();
  });

  test("empty City PATCH is invalid at runtime", async () => {
    const app = createApp({
      logger: silentLogger,
      production: false,
      readinessCheck: async () => undefined,
      authModule: fakeModule({
        sessions: {
          authenticate: async () => ({
            accountId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            applicationType: "DASHBOARD",
            roles: ["SUPER_ADMIN"],
            scopeType: "GLOBAL",
            cityId: null,
          }),
          requireSuperAdmin: () => undefined,
        } as never,
      }),
      geographyService: {
        cities: {
          update: async () => {
            throw new Error("should not be called");
          },
        },
      } as unknown as GeographyService,
    });
    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/dashboard/cities/11111111-1111-4111-8111-111111111111",
        {
          method: "PATCH",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: "{}",
        },
      ),
    );
    expect(response.status).toBe(422);
  });

  test("registers every application route under /api/v1 with no unprefixed aliases", async () => {
    const app = createApp({ logger: silentLogger, production: false, readinessCheck: async () => undefined, authModule: fakeModule() });
    const document = await (await app.handle(new Request("http://localhost/openapi/json"))).json() as { paths: Record<string,Record<string,{requestBody?:unknown;responses?:unknown;security?:unknown}>> };
    const applicationPaths=Object.keys(document.paths).filter(path=>path.includes("auth"));
    expect(applicationPaths.length).toBe(26);
    expect(applicationPaths.every(path=>path.startsWith("/api/v1/mobile/customer/")||path.startsWith("/api/v1/mobile/driver/")||path.startsWith("/api/v1/mobile/merchant/")||path.startsWith("/api/v1/dashboard/"))).toBeTrue();
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
    expect(document.paths["/api/v1/mobile/merchant/auth/sessions"]?.get?.security).toEqual([{bearerAuth:[]}]);
    expect(document.paths["/api/v1/mobile/merchant/auth/login"]?.post?.requestBody).toBeDefined();
    expect(document.paths["/api/v1/mobile/merchant/auth/me"]?.get?.security).toEqual([{bearerAuth:[]}]);
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
