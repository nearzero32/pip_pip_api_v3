import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  requireCityAdmin,
  requireCityPermission,
  requireSuperAdmin,
} from "../../src/modules/auth/staff/authorization";
import { requirePublicCityContext } from "../../src/modules/auth/city/public-city-context";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  tokenClaims,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const identity = (
  partial: Partial<AuthIdentity> & Pick<AuthIdentity, "roles" | "scopeType" | "cityId">,
): AuthIdentity => ({
  accountId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  applicationType: "DASHBOARD",
  storeId: null,
  ...partial,
});

describe("M3-B0 trusted City context and staff authorization", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminAToken = "";
  let adminAId = "";
  let adminBToken = "";
  let adminBId = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3b0",
    });
    cityA = await createActiveCity(harness.client, "City A");
    cityB = await createActiveCity(harness.client, "City B");
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b0-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b0-admin-a@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    adminBId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b0-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    superToken = (
      await harness.auth.dashboard.login({
        email: "m3b0-super@example.com",
        password,
        deviceName: "s",
        ip: "s",
        requestId: "s",
      })
    ).access_token;
    adminAToken = (
      await harness.auth.dashboard.login({
        email: "m3b0-admin-a@example.com",
        password,
        deviceName: "a",
        ip: "a",
        requestId: "a",
      })
    ).access_token;
    adminBToken = (
      await harness.auth.dashboard.login({
        email: "m3b0-admin-b@example.com",
        password,
        deviceName: "b",
        ip: "b",
        requestId: "b",
      })
    ).access_token;
  }, 60000);

  afterAll(async () => {
    await harness.close();
  });

  describe("public X-City-Id context", () => {
    test("missing, malformed, unknown, and inactive cities are rejected", async () => {
      await expect(
        requirePublicCityContext(
          harness.client,
          new Request("http://localhost/"),
        ),
      ).rejects.toMatchObject({ publicCode: "CITY_CONTEXT_REQUIRED", statusCode: 400 });

      await expect(
        requirePublicCityContext(
          harness.client,
          new Request("http://localhost/", {
            headers: { "X-City-Id": "not-a-uuid" },
          }),
        ),
      ).rejects.toMatchObject({ publicCode: "INVALID_CITY_CONTEXT", statusCode: 400 });

      await expect(
        requirePublicCityContext(
          harness.client,
          new Request("http://localhost/", {
            headers: {
              "X-City-Id": `${cityA},${cityB}`,
            },
          }),
        ),
      ).rejects.toMatchObject({ publicCode: "INVALID_CITY_CONTEXT", statusCode: 400 });

      await expect(
        requirePublicCityContext(
          harness.client,
          new Request("http://localhost/", {
            headers: {
              "X-City-Id": "11111111-1111-4111-8111-999999999999",
            },
          }),
        ),
      ).rejects.toMatchObject({ publicCode: "CITY_NOT_FOUND", statusCode: 404 });

      const [draft] = await harness.client<
        { id: string }[]
      >`insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order)
        values('11111111-1111-4111-8111-000000000001','مسودة','Draft City',1,1,'DRAFT',9) returning id`;
      await expect(
        requirePublicCityContext(
          harness.client,
          new Request("http://localhost/", {
            headers: { "x-city-id": draft!.id },
          }),
        ),
      ).rejects.toMatchObject({ publicCode: "CITY_NOT_ACTIVE", statusCode: 409 });
    });

    test("active city under active governorate resolves; header is case-insensitive", async () => {
      const context = await requirePublicCityContext(
        harness.client,
        new Request("http://localhost/", {
          headers: { "X-CITY-ID": cityA },
        }),
      );
      expect(context).toEqual({ city: { id: cityA } });
    });
  });

  describe("authorization helpers", () => {
    test("SUPER_ADMIN cannot pass City operational helpers", async () => {
      const superIdentity = identity({
        roles: ["SUPER_ADMIN"],
        scopeType: "GLOBAL",
        cityId: null,
      });
      expect(() => requireSuperAdmin(superIdentity)).not.toThrow();
      expect(() => requireCityAdmin(superIdentity)).toThrow(
        "Insufficient privileges",
      );
      await expect(
        requireCityPermission(harness.client, superIdentity, "zones.read"),
      ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
    });

    test("ADMIN passes City permission automatically; employee requires grant", async () => {
      const adminIdentity = identity({
        accountId: adminAId,
        roles: ["ADMIN"],
        scopeType: "CITY",
        cityId: cityA,
      });
      expect(requireCityAdmin(adminIdentity)).toBe(cityA);
      expect(
        await requireCityPermission(harness.client, adminIdentity, "zones.read"),
      ).toBe(cityA);

      const employeeId = await createStaffAccount(harness.auth, harness.client, {
        email: "m3b0-ops@example.com",
        password,
        roles: ["OPERATIONS"],
        cityId: cityA,
        managedByAccountId: adminAId,
      });
      const employeeIdentity = identity({
        accountId: employeeId,
        roles: ["OPERATIONS"],
        scopeType: "CITY",
        cityId: cityA,
      });
      await expect(
        requireCityPermission(harness.client, employeeIdentity, "zones.read"),
      ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });

      await harness.auth.staff.grantEmployeePermission(
        {
          accountId: adminAId,
          sessionId: crypto.randomUUID(),
          applicationType: "DASHBOARD",
          roles: ["ADMIN"],
          scopeType: "CITY",
          cityId: cityA,
          storeId: null,
        },
        employeeId,
        "zones.read",
      );
      expect(
        await requireCityPermission(harness.client, employeeIdentity, "zones.read"),
      ).toBe(cityA);
    });
  });

  describe("ADMIN and employee management", () => {
    test("SUPER_ADMIN creates ADMIN; ADMIN creates employee inheriting City", async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/admins", {
          method: "POST",
          token: superToken,
          body: {
            email: "m3b0-admin-c@example.com",
            password,
            cityId: cityA,
            displayName: "Admin C",
          },
        }),
      );
      expect(created.status).toBe(200);
      const adminBody = (await created.json()) as { accountId: string; cityId: string };
      expect(adminBody.cityId).toBe(cityA);

      const employee = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminAToken,
          body: {
            email: "m3b0-support-a@example.com",
            password,
            role: "SUPPORT",
          },
        }),
      );
      expect(employee.status).toBe(200);
      const empBody = (await employee.json()) as {
        accountId: string;
        cityId: string;
        roles: string[];
      };
      expect(empBody.cityId).toBe(cityA);
      expect(empBody.roles).toEqual(["SUPPORT"]);

      const rejectedCity = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminAToken,
          body: {
            email: "m3b0-bad@example.com",
            password,
            role: "SUPPORT",
            cityId: cityB,
            adminId: adminBId,
            ownerId: adminBId,
          },
        }),
      );
      expect(rejectedCity.status).toBe(422);
    });

    test("ADMIN cannot access another ADMIN employee; foreign id is not found", async () => {
      const create = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminBToken,
          body: {
            email: "m3b0-support-b@example.com",
            password,
            role: "ACCOUNTANT",
          },
        }),
      );
      const foreignId = ((await create.json()) as { accountId: string }).accountId;
      const response = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${foreignId}`, {
          token: adminAToken,
        }),
      );
      expect(response.status).toBe(404);
      expect(
        (await response.json() as { error: { code: string } }).error.code,
      ).toBe("EMPLOYEE_NOT_FOUND");
    });

    test("permission grant and revoke take effect immediately on the same access token", async () => {
      const employeeSession = await harness.auth.dashboard.login({
        email: "m3b0-support-a@example.com",
        password,
        deviceName: "e",
        ip: "e",
        requestId: "e",
      });
      const claims = tokenClaims(employeeSession.access_token);
      expect(claims.scopeType).toBe("CITY");
      expect(claims.cityId).toBe(cityA);
      const employeeIdentity = await harness.auth.sessions.authenticate(
        employeeSession.access_token,
        {
          applicationType: "DASHBOARD",
          audience: "dashboard",
          namespace: "dashboard",
        },
        "emp-auth",
      );

      await expect(
        requireCityPermission(harness.client, employeeIdentity, "zones.create"),
      ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });

      const employeeId = employeeIdentity.accountId;
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminAToken,
          body: { permission: "zones.create" },
        }),
      );
      expect(
        await requireCityPermission(harness.client, employeeIdentity, "zones.create"),
      ).toBe(cityA);

      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/employees/${employeeId}/permissions/zones.create`,
          { method: "DELETE", token: adminAToken },
        ),
      );
      await expect(
        requireCityPermission(harness.client, employeeIdentity, "zones.create"),
      ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
    });

    test("changing ADMIN City revokes ADMIN and employee sessions; refresh cannot restore stale City", async () => {
      const adminEmail = "m3b0-admin-move@example.com";
      const createAdmin = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/admins", {
          method: "POST",
          token: superToken,
          body: { email: adminEmail, password, cityId: cityA },
        }),
      );
      const adminId = ((await createAdmin.json()) as { accountId: string }).accountId;
      const adminSession = await harness.auth.dashboard.login({
        email: adminEmail,
        password,
        deviceName: "m",
        ip: "m",
        requestId: "m",
      });
      const employee = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminSession.access_token,
          body: {
            email: "m3b0-move-emp@example.com",
            password,
            role: "SUPPORT",
          },
        }),
      );
      const employeeId = ((await employee.json()) as { accountId: string }).accountId;
      const employeeSession = await harness.auth.dashboard.login({
        email: "m3b0-move-emp@example.com",
        password,
        deviceName: "me",
        ip: "me",
        requestId: "me",
      });

      const moved = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/admins/${adminId}`, {
          method: "PATCH",
          token: superToken,
          body: { cityId: cityB },
        }),
      );
      expect(moved.status).toBe(200);
      expect(((await moved.json()) as { cityId: string }).cityId).toBe(cityB);

      expect(
        (
          await harness.app.handle(
            jsonRequest("/api/v1/dashboard/employees", {
              token: adminSession.access_token,
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await harness.app.handle(
            jsonRequest(`/api/v1/dashboard/employees/${employeeId}`, {
              token: employeeSession.access_token,
            }),
          )
        ).status,
      ).toBe(401);

      await expect(
        harness.auth.sessions.refresh(
          adminSession.refresh_token,
          {
            applicationType: "DASHBOARD",
            audience: "dashboard",
            namespace: "dashboard",
          },
          "stale-admin",
          "stale-admin",
        ),
      ).rejects.toMatchObject({ publicCode: "INVALID_REFRESH_TOKEN" });

      const relogin = await harness.auth.dashboard.login({
        email: adminEmail,
        password,
        deviceName: "m2",
        ip: "m2",
        requestId: "m2",
      });
      expect(tokenClaims(relogin.access_token).cityId).toBe(cityB);
    });

    test("Dashboard X-City-Id and body cityId cannot override signed City", async () => {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminAToken,
          headers: { "X-City-Id": cityB },
          body: {
            email: "m3b0-override@example.com",
            password,
            role: "SUPPORT",
            cityId: cityB,
          },
        }),
      );
      // unknown body key rejected
      expect(response.status).toBe(422);

      const ok = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/employees", {
          method: "POST",
          token: adminAToken,
          headers: { "X-City-Id": cityB },
          body: {
            email: "m3b0-override-ok@example.com",
            password,
            role: "SUPPORT",
          },
        }),
      );
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { cityId: string }).cityId).toBe(cityA);
    });
  });

  describe("OpenAPI M3-B0 contracts", () => {
    test("documents staff routes with bearerAuth and reusable X-City-Id parameter", async () => {
      const document = (await (
        await harness.app.handle(new Request("http://localhost/openapi/json"))
      ).json()) as {
        components?: { parameters?: Record<string, { name?: string }> };
        paths: Record<
          string,
          Record<string, { security?: unknown; parameters?: unknown }>
        >;
      };
      expect(document.components?.parameters?.CityIdHeader?.name).toBe("X-City-Id");
      expect(document.paths["/api/v1/dashboard/admins"]?.post?.security).toEqual([
        { bearerAuth: [] },
      ]);
      expect(document.paths["/api/v1/dashboard/employees"]?.post?.security).toEqual([
        { bearerAuth: [] },
      ]);
      const adminPost = JSON.stringify(document.paths["/api/v1/dashboard/admins"]!.post);
      expect(adminPost).toContain("cityId");
      const employeePost = JSON.stringify(
        document.paths["/api/v1/dashboard/employees"]!.post,
      );
      expect(employeePost).not.toContain('"adminId"');
      expect(employeePost).not.toContain('"ownerId"');
      // Response DTO includes trusted cityId; request must not accept client cityId
      // (Elysia currently emits empty requestBody.content; runtime allowlist is tested above).
      expect(employeePost).toContain('"cityId"');
    });
  });
});
