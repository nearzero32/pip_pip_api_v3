import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { silentLogger } from "../../src/observability/logger";
import type { AuthModule } from "../../src/modules/auth/auth-module";
import { SAMPLE } from "../../src/openapi/samples";

const stub = new Proxy({}, { get: () => async () => ({}) });
const authModule = {
  customer: stub,
  driver: stub,
  dashboard: stub,
  sessions: stub,
  roles: stub,
  staff: stub,
  client: stub,
  merchant: stub,
  merchants: stub,
} as unknown as AuthModule;

const documentedApp = () =>
  createApp({
    logger: silentLogger,
    production: false,
    readinessCheck: async () => undefined,
    authModule,
    geographyService: stub as never,
    mediaService: stub as never,
    mainCategoryService: stub as never,
    subcategoryService: stub as never,
    storeService: stub as never,
    storeCategoryService: stub as never,
    productService: stub as never,
    modifierService: stub as never,
    cartService: stub as never,
    customerAddressService: stub as never,
    deliveryPricingService: stub as never,
    orderService: stub as never,
    orderLifecycleService: stub as never,
    orderOpsService: stub as never,
    cityDriverPricingService: stub as never,
    offerService: stub as never,
    storeCommissionService: stub as never,
    dashboardExportService: stub as never,
    driverRuntime: stub as never,
  });

const mutating = new Set(["post", "put", "patch"]);

const resolve = (schema: any, components: any, seen = new Set<string>()): any => {
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return schema;
    seen.add(schema.$ref);
    const name = schema.$ref.slice(schema.$ref.lastIndexOf("/") + 1);
    return resolve(components?.[name], components, seen);
  }
  return schema;
};

const assertExampleMatches = (example: unknown, schema: any, components: any, path: string) => {
  const resolved = resolve(schema, components);
  if (!resolved) return;
  if (resolved.type === "object" || resolved.properties) {
    expect(example && typeof example === "object" && !Array.isArray(example)).toBeTrue();
    const object = example as Record<string, unknown>;
    for (const key of (resolved.required as string[] | undefined) ?? []) {
      expect(object, `${path} missing ${key}`).toHaveProperty(key);
    }
    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      for (const key of Object.keys(object)) {
        expect(allowed.has(key), `${path} extra ${key}`).toBeTrue();
      }
    }
    const properties = (resolved.properties ?? {}) as Record<string, any>;
    for (const [key, value] of Object.entries(object)) {
      const property = properties[key];
      if (!property) continue;
      const inner = resolve(property, components);
      if (Array.isArray(inner?.enum)) expect(inner.enum).toContain(value);
      if (inner?.format === "uuid")
        expect(String(value)).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
    }
  }
};

describe("OpenAPI request documentation", () => {
  test("every JSON body operation has a schema and a valid example", async () => {
    const document = (await (
      await documentedApp().handle(new Request("http://localhost/openapi/json"))
    ).json()) as {
      openapi: string;
      servers?: { url: string }[];
      paths: Record<string, Record<string, any>>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.0.3");
    expect(document.servers?.[0]?.url).toBe("http://localhost:3000");
    const components = document.components?.schemas;
    let operations = 0;
    let bodyOperations = 0;
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!mutating.has(method) && method !== "delete") continue;
        operations += 1;
        const body = operation.requestBody;
        if (!body) continue;
        bodyOperations += 1;
        const media = body.content?.["application/json"];
        expect(media?.schema, `${method.toUpperCase()} ${path} schema`).toBeDefined();
        expect(media?.example, `${method.toUpperCase()} ${path} example`).toBeDefined();
        assertExampleMatches(
          media.example,
          media.schema,
          components,
          `${method.toUpperCase()} ${path}`,
        );
        const serialized = JSON.stringify(media.example);
        expect(serialized).not.toMatch(/AKIA|r2-secret|BEGIN PRIVATE KEY/i);
      }
    }
    expect(bodyOperations).toBeGreaterThan(20);
    expect(operations).toBeGreaterThan(40);
  });

  test("Dashboard login documents a complete curl body and DASHBOARD session", async () => {
    const document = await (
      await documentedApp().handle(new Request("http://localhost/openapi/json"))
    ).json();
    const login = document.paths["/api/v1/dashboard/auth/login"].post;
    expect(login.requestBody.content["application/json"].example).toEqual({
      email: "superadmin@example.com",
      password: SAMPLE.password,
      device_id: "dashboard-browser-001",
      device_name: "Angular Dashboard",
    });
    expect(login.responses["200"].content["application/json"].example.application_type).toBe(
      "DASHBOARD",
    );
    expect(document.paths["/api/v1/mobile/driver/auth/login"].post.responses["200"].content["application/json"].example.application_type).toBe("DRIVER_APP");
    expect(document.paths["/api/v1/mobile/customer/auth/otp/verify"].post.responses["200"].content["application/json"].example.application_type).toBe("CUSTOMER_APP");
    expect(document.paths["/api/v1/mobile/merchant/auth/login"].post.responses["200"].content["application/json"].example.application_type).toBe("MERCHANT_APP");
  });

  test("Scalar-facing spec can reconstruct executable curl for core operations", async () => {
    const document = (await (
      await documentedApp().handle(new Request("http://localhost/openapi/json"))
    ).json()) as {
      servers: { url: string }[];
      paths: Record<string, Record<string, any>>;
    };
    const origin = document.servers?.[0]?.url ?? "";
    const curl = (method: string, path: string) => {
      const operation = document.paths[path]?.[method];
      const media = operation?.requestBody?.content?.["application/json"];
      const lines = [
        `curl '${origin}${path}'`,
        `--request ${method.toUpperCase()}`,
      ];
      if (media) {
        lines.push("--header 'Content-Type: application/json'");
        lines.push(`--data '${JSON.stringify(media.example)}'`);
      }
      if (operation?.security?.some((item: object) => "bearerAuth" in item)) {
        lines.push("--header 'Authorization: Bearer <access-token>'");
      }
      for (const parameter of operation?.parameters ?? []) {
        if (parameter.in === "header" && parameter.example) {
          lines.push(`--header '${parameter.name}: ${parameter.example}'`);
        }
      }
      return lines.join(" ");
    };
    const login = curl("post", "/api/v1/dashboard/auth/login");
    expect(login).toContain("http://localhost:3000/api/v1/dashboard/auth/login");
    expect(login).toContain("Content-Type: application/json");
    expect(login).toContain("superadmin@example.com");
    expect(login).toContain("StrongPassword123!");
    expect(curl("post", "/api/v1/mobile/driver/auth/login")).toContain("+9647700000000");
    expect(curl("post", "/api/v1/mobile/customer/auth/otp/request")).toContain("+9647700000000");
    expect(curl("post", "/api/v1/dashboard/cities")).toContain("Baghdad");
    expect(curl("post", "/api/v1/dashboard/zones")).toContain("Polygon");
    expect(curl("post", "/api/v1/dashboard/stores")).toContain("Demo Grill");
    expect(curl("post", "/api/v1/dashboard/stores/{storeId}/products")).toContain("images");
    expect(curl("post", "/api/v1/mobile/customer/cart/items")).toContain("X-City-Id");
    expect(curl("post", "/api/v1/mobile/customer/orders")).toContain("idempotencyKey");
    expect(curl("post", "/api/v1/dashboard/orders/{orderId}/cancel")).toContain(
      "Idempotency-Key",
    );
    expect(
      curl("post", "/api/v1/mobile/driver/orders/{orderId}/confirm-arrival-at-store"),
    ).toContain("Content-Type");
    expect(curl("post", "/api/v1/mobile/driver/orders/{orderId}/confirm-pickup")).toContain(
      "application/json",
    );
    expect(curl("post", "/api/v1/mobile/driver/orders/{orderId}/confirm-delivery")).toContain(
      "application/json",
    );
    expect(curl("patch", "/api/v1/dashboard/store-commissions/{storeId}")).toContain(
      "platformCommissionRate",
    );
    const cart =
      document.paths["/api/v1/mobile/customer/cart/items"]?.post?.requestBody?.content?.[
        "application/json"
      ];
    expect(Object.keys(cart?.examples ?? {})).toContain("Sized product");
    const estimate =
      document.paths["/api/v1/mobile/customer/delivery-pricing/estimate"]?.post?.requestBody
        ?.content?.["application/json"];
    expect(Object.keys(estimate?.examples ?? {})).toContain("Saved-address delivery");
  });
});
