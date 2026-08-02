import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { silentLogger } from "../../src/observability/logger";

function appWith(readinessCheck: () => Promise<void> = async () => undefined) {
  return createApp({ logger: silentLogger, production: false, readinessCheck });
}

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

  test("accepts a valid incoming request ID", async () => {
    const response = await appWith().handle(new Request("http://localhost/health/live", { headers: { "x-request-id": "client-request_123" } }));
    expect(response.headers.get("x-request-id")).toBe("client-request_123");
  });

  test("generates a request ID when absent or invalid", async () => {
    const app = appWith();
    const absent = await app.handle(new Request("http://localhost/health/live"));
    const invalid = await app.handle(new Request("http://localhost/health/live", { headers: { "x-request-id": "invalid request id" } }));
    expect(absent.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(invalid.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
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
});
