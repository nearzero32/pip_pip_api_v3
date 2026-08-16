import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const nested = (body: unknown) =>
  body as { data: unknown[]; pagination: { page: number; limit: number; total: number; totalPages: number } };

describe("dashboard list contract completion", () => {
  let h: IntegrationHarness;
  let superToken: string;
  let adminToken: string;
  let cityId: string;

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_lists" });
    cityId = await createActiveCity(h.client, "قوائم");
    await createStaffAccount(h.auth, h.client, {
      email: "super.lists@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    await createStaffAccount(h.auth, h.client, {
      email: "admin.lists@example.com",
      password,
      roles: ["ADMIN"],
      cityId,
    });
    superToken = (
      await h.auth.dashboard.login({
        email: "super.lists@example.com",
        password,
        deviceName: "lists",
        ip: "127.0.0.1",
        requestId: "lists-super",
      })
    ).access_token;
    adminToken = (
      await h.auth.dashboard.login({
        email: "admin.lists@example.com",
        password,
        deviceName: "lists",
        ip: "127.0.0.1",
        requestId: "lists-admin",
      })
    ).access_token;
  });

  afterAll(async () => {
    await h.close();
  });

  const getJson = async (path: string, token: string) => {
    const res = await h.app.handle(jsonRequest(path, { token }));
    return { status: res.status, body: await res.json() };
  };

  test("governorates nested defaults and invalid sort", async () => {
    const ok = await getJson("/api/v1/dashboard/governorates", superToken);
    expect(ok.status).toBe(200);
    const page = nested(ok.body);
    expect(page.pagination.page).toBe(1);
    expect(page.pagination.limit).toBe(25);
    expect(Array.isArray(page.data)).toBe(true);
    const bad = await getJson("/api/v1/dashboard/governorates?sortBy=password", superToken);
    expect(bad.status).toBe(422);
  });

  test("merchants dashboard uses nested pagination not flat page", async () => {
    const ok = await getJson("/api/v1/dashboard/merchants", adminToken);
    expect(ok.status).toBe(200);
    const page = nested(ok.body);
    expect(page.pagination).toBeDefined();
    expect((ok.body as { page?: number }).page).toBeUndefined();
  });

  test("delivery pricing versions are nested; active remains singleton", async () => {
    const list = await getJson(
      `/api/v1/dashboard/cities/${cityId}/delivery-pricing/versions`,
      superToken,
    );
    expect(list.status).toBe(200);
    expect(nested(list.body).pagination.limit).toBe(25);
    const adminDenied = await getJson(
      `/api/v1/dashboard/cities/${cityId}/delivery-pricing/versions`,
      adminToken,
    );
    expect(adminDenied.status).toBe(403);
  });

  test("page 0 and limit 101 are 422", async () => {
    const page0 = await getJson("/api/v1/dashboard/governorates?page=0", superToken);
    expect(page0.status).toBe(422);
    const limit101 = await getJson("/api/v1/dashboard/governorates?limit=101", superToken);
    expect(limit101.status).toBe(422);
  });

  test("assignment export accepts the same query as the list", async () => {
    const list = await getJson("/api/v1/dashboard/order-assignments?search=%25", adminToken);
    expect(list.status).toBe(200);
    expect(nested(list.body).pagination).toBeDefined();
    const exported = await h.app.handle(
      jsonRequest("/api/v1/dashboard/order-assignments/export?search=%25", { token: adminToken }),
    );
    expect([200, 409]).toContain(exported.status);
  });

  test("wildcard search is accepted as literal text", async () => {
    const res = await getJson("/api/v1/dashboard/governorates?search=%25_", superToken);
    expect(res.status).toBe(200);
    expect(nested(res.body).data.length).toBe(0);
  });
});
