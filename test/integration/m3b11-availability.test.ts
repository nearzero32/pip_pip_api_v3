import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardContext } from "../../src/modules/auth/core/context";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  seededGovernorateId,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const square = (west: number, south: number, east: number, north: number) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } })
    .error;

const login = async (
  harness: IntegrationHarness,
  email: string,
  requestId: string,
) =>
  harness.auth.dashboard.login({
    email,
    password,
    deviceName: requestId,
    ip: requestId,
    requestId,
  });

const expectRefreshDenied = async (
  harness: IntegrationHarness,
  refreshToken: string,
  tag: string,
) => {
  await expect(
    harness.auth.sessions.refresh(refreshToken, dashboardContext, tag, tag),
  ).rejects.toMatchObject({
    publicCode: "INVALID_REFRESH_TOKEN",
    statusCode: 401,
  });
};

describe("M3-B1.1 City availability and session revocation", () => {
  let harness: IntegrationHarness;
  let superToken = "";
  let cityA = "";
  let cityB = "";
  let otherGovId = "";
  let adminAToken = "";
  let adminARefresh = "";
  let employeeAToken = "";
  let employeeARefresh = "";
  let employeeAId = "";
  let adminBToken = "";
  let employeeBToken = "";
  let adminOtherToken = "";
  let employeeOtherToken = "";
  let zoneAId = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3b11",
    });
    cityA = await createActiveCity(harness.client, "Avail City A");
    cityB = await createActiveCity(harness.client, "Avail City B");

    const [otherGov] = await harness.client<{ id: string }[]>`
      insert into governorates(id,name_ar,name_en,status,display_order)
      values(${crypto.randomUUID()},'Other Gov','Other Gov','ACTIVE',99)
      returning id::text as id`;
    otherGovId = otherGov!.id;
    const [otherCity] = await harness.client<{ id: string }[]>`
      insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order)
      values(${otherGovId},'Other City','Other City',33.1,44.1,'ACTIVE',1)
      returning id::text as id`;
    const cityOtherGov = otherCity!.id;

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    const adminAId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-admin-a@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    employeeAId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-emp-a@example.com",
      password,
      roles: ["OPERATIONS"],
      cityId: cityA,
      managedByAccountId: adminAId,
    });
    const adminBId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    const employeeBId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-emp-b@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityB,
      managedByAccountId: adminBId,
    });
    const adminOtherId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-admin-other@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityOtherGov,
    });
    const empOtherId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-emp-other@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityOtherGov,
      managedByAccountId: adminOtherId,
    });

    const grantAll = async (adminEmail: string, employeeId: string) => {
      const token = (await login(harness, adminEmail, `grant-${employeeId}`))
        .access_token;
      for (const permission of [
        "zones.read",
        "zones.create",
        "zones.update",
        "zones.archive",
      ] as const) {
        const response = await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
            method: "POST",
            token,
            body: { permission },
          }),
        );
        expect(response.status).toBe(200);
      }
    };
    await grantAll("m3b11-admin-a@example.com", employeeAId);
    await grantAll("m3b11-admin-b@example.com", employeeBId);
    await grantAll("m3b11-admin-other@example.com", empOtherId);

    superToken = (
      await login(harness, "m3b11-super@example.com", "super")
    ).access_token;

    const adminA = await login(harness, "m3b11-admin-a@example.com", "admin-a");
    adminAToken = adminA.access_token;
    adminARefresh = adminA.refresh_token;
    const empA = await login(harness, "m3b11-emp-a@example.com", "emp-a");
    employeeAToken = empA.access_token;
    employeeARefresh = empA.refresh_token;
    adminBToken = (
      await login(harness, "m3b11-admin-b@example.com", "admin-b")
    ).access_token;
    employeeBToken = (
      await login(harness, "m3b11-emp-b@example.com", "emp-b")
    ).access_token;
    adminOtherToken = (
      await login(harness, "m3b11-admin-other@example.com", "admin-o")
    ).access_token;
    employeeOtherToken = (
      await login(harness, "m3b11-emp-other@example.com", "emp-o")
    ).access_token;

    const zone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: adminAToken,
        body: { name: "Avail Zone", boundary: square(70.0, 40.0, 70.2, 40.2) },
      }),
    );
    expect(zone.status).toBe(200);
    zoneAId = ((await zone.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("architecture keeps City/Governorate transition and session revocation in one transaction", () => {
    const citySource = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/city/city.service.ts",
      ),
      "utf8",
    );
    expect(citySource).toContain("this.client.begin(async (tx) =>");
    expect(citySource).toContain("revokeDashboardSessionsForCities");
    expect(citySource).toContain("CITY_UNAVAILABLE");
    const govSource = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/governorate/governorate.service.ts",
      ),
      "utf8",
    );
    expect(govSource).toContain("this.client.begin(async (tx) =>");
    expect(govSource).toContain("GOVERNORATE_UNAVAILABLE");
  });

  test("City suspend revokes ADMIN/employee tokens; unrelated City remains valid", async () => {
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeAToken }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${cityA}/suspend`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);

    const adminDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
    );
    const empDenied = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/zones/${zoneAId}`, {
        token: employeeAToken,
      }),
    );
    expect(adminDenied.status).toBe(401);
    expect((await errorOf(adminDenied)).code).toBe("UNAUTHENTICATED");
    expect(empDenied.status).toBe(401);
    expect((await errorOf(empDenied)).code).toBe("UNAUTHENTICATED");

    await expectRefreshDenied(harness, adminARefresh, "ra");
    await expectRefreshDenied(harness, employeeARefresh, "re");

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminBToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeBToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/cities", { token: superToken }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${cityA}/activate`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeAToken }),
        )
      ).status,
    ).toBe(401);

    const fresh = await login(harness, "m3b11-admin-a@example.com", "admin-a2");
    adminAToken = fresh.access_token;
    adminARefresh = fresh.refresh_token;
    const freshEmp = await login(harness, "m3b11-emp-a@example.com", "emp-a2");
    employeeAToken = freshEmp.access_token;
    employeeARefresh = freshEmp.refresh_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
        )
      ).status,
    ).toBe(200);
  });

  test("City archive revokes operational sessions", async () => {
    const archiveCity = await createActiveCity(
      harness.client,
      "Archive Target City",
    );
    const adminId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-archive-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: archiveCity,
    });
    const empId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-archive-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: archiveCity,
      managedByAccountId: adminId,
    });
    const grantTok = (
      await login(harness, "m3b11-archive-admin@example.com", "ga")
    ).access_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/employees/${empId}/permissions`, {
            method: "POST",
            token: grantTok,
            body: { permission: "zones.read" },
          }),
        )
      ).status,
    ).toBe(200);
    const adminTok = (
      await login(harness, "m3b11-archive-admin@example.com", "aa")
    ).access_token;
    const empTok = (
      await login(harness, "m3b11-archive-emp@example.com", "ae")
    ).access_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminTok }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${archiveCity}/archive`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminTok }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: empTok }),
        )
      ).status,
    ).toBe(401);
  });

  test("Governorate INACTIVE revokes child City sessions only", async () => {
    const adminTokA = (
      await login(harness, "m3b11-admin-a@example.com", "ga2")
    ).access_token;
    const empTokA = (
      await login(harness, "m3b11-emp-a@example.com", "ge2")
    ).access_token;
    const adminTokB = (
      await login(harness, "m3b11-admin-b@example.com", "gb2")
    ).access_token;
    const empTokB = (
      await login(harness, "m3b11-emp-b@example.com", "geb2")
    ).access_token;
    const adminAFresh = await login(
      harness,
      "m3b11-admin-a@example.com",
      "ref-a",
    );

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
            method: "PATCH",
            token: superToken,
            body: { status: "INACTIVE" },
          }),
        )
      ).status,
    ).toBe(200);

    for (const token of [adminTokA, empTokA, adminTokB, empTokB]) {
      expect(
        (
          await harness.app.handle(
            jsonRequest("/api/v1/dashboard/zones", { token }),
          )
        ).status,
      ).toBe(401);
    }
    await expectRefreshDenied(harness, adminAFresh.refresh_token, "x");

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminOtherToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeOtherToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/cities", { token: superToken }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
            method: "PATCH",
            token: superToken,
            body: { status: "ACTIVE" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminTokA }),
        )
      ).status,
    ).toBe(401);

    const freshOther = await login(
      harness,
      "m3b11-admin-other@example.com",
      "other-fresh",
    );
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/governorates/${otherGovId}`, {
            method: "PATCH",
            token: superToken,
            body: { displayOrder: 42 },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            token: freshOther.access_token,
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("Zone ops reject when trusted City is suspended (defense in depth)", async () => {
    const city = await createActiveCity(harness.client, "Depth City");
    const adminId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b11-depth-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: city,
    });
    const session = await login(
      harness,
      "m3b11-depth-admin@example.com",
      "depth",
    );
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: session.access_token,
            body: {
              name: "Depth Zone",
              boundary: square(71.0, 41.0, 71.1, 41.1),
            },
          }),
        )
      ).status,
    ).toBe(200);

    await harness.client`
      update cities set status='SUSPENDED',updated_at=now() where id=${city}`;
    await harness.client`
      update sessions set revoked_at=null,revocation_reason=null,updated_at=now()
      where account_id=${adminId} and application_type='DASHBOARD'`;

    const denied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: session.access_token }),
    );
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).code).toBe("CITY_NOT_ACTIVE");
  });
});
