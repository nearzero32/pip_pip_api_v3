import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardContext } from "../../src/modules/auth/core/context";
import {
  lockCityGeography,
  lockCityReassignment,
  lockGovernorateAndCities,
  lockZoneOverlap,
  readCityOperability,
} from "../../src/modules/geography/geography-locks";
import { revokeDashboardSessionsForCities } from "../../src/modules/geography/operational-sessions";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  seededGovernorateId,
  tokenClaims,
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

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out: ${label} (${ms}ms)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Observe a Lock wait on another backend — coordination is advisory locks, not sleep. */
const waitForLockWait = async (
  client: IntegrationHarness["client"],
  timeoutMs = 8_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await client<{ n: string }[]>`
      select count(*)::text as n
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`;
    if (Number(row?.n ?? 0) > 0) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for conflicting lock wait");
};

const grantZonePermissions = async (
  harness: IntegrationHarness,
  adminEmail: string,
  employeeId: string,
) => {
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

describe("M3-B1.2 City reassignment revocation and race-safe Zone mutations", () => {
  let harness: IntegrationHarness;
  let superToken = "";
  let govA = "";
  let govBInactive = "";
  let govC = "";
  let city = "";
  let cityUnrelated = "";
  let adminToken = "";
  let adminRefresh = "";
  let employeeToken = "";
  let employeeRefresh = "";
  let unrelatedAdminToken = "";
  let zoneId = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3b12",
    });

    // Dedicated parent for the City under test so Governorate deactivation
    // never revokes sessions belonging to unrelated Cities on the seeded gov.
    const [activeA] = await harness.client<{ id: string }[]>`
      insert into governorates(id,name_ar,name_en,status,display_order)
      values(${crypto.randomUUID()},'Active A','Active A','ACTIVE',49)
      returning id::text as id`;
    govA = activeA!.id;
    const [inactive] = await harness.client<{ id: string }[]>`
      insert into governorates(id,name_ar,name_en,status,display_order)
      values(${crypto.randomUUID()},'Inactive B','Inactive B','INACTIVE',50)
      returning id::text as id`;
    govBInactive = inactive!.id;
    const [activeC] = await harness.client<{ id: string }[]>`
      insert into governorates(id,name_ar,name_en,status,display_order)
      values(${crypto.randomUUID()},'Active C','Active C','ACTIVE',51)
      returning id::text as id`;
    govC = activeC!.id;

    const [cityRow] = await harness.client<{ id: string }[]>`
      insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order)
      values(${govA},'Reassign City','Reassign City',33.2,44.2,'ACTIVE',1)
      returning id::text as id`;
    city = cityRow!.id;
    cityUnrelated = await createActiveCity(harness.client, "Unrelated City");
    expect(seededGovernorateId).not.toBe(govA);

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b12-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    const adminId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b12-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: city,
    });
    const employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b12-emp@example.com",
      password,
      roles: ["OPERATIONS"],
      cityId: city,
      managedByAccountId: adminId,
    });
    const unrelatedAdminId = await createStaffAccount(
      harness.auth,
      harness.client,
      {
        email: "m3b12-admin-u@example.com",
        password,
        roles: ["ADMIN"],
        cityId: cityUnrelated,
      },
    );
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b12-emp-u@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityUnrelated,
      managedByAccountId: unrelatedAdminId,
    });

    await grantZonePermissions(
      harness,
      "m3b12-admin@example.com",
      employeeId,
    );

    superToken = (
      await login(harness, "m3b12-super@example.com", "super")
    ).access_token;
    const admin = await login(harness, "m3b12-admin@example.com", "admin");
    adminToken = admin.access_token;
    adminRefresh = admin.refresh_token;
    const emp = await login(harness, "m3b12-emp@example.com", "emp");
    employeeToken = emp.access_token;
    employeeRefresh = emp.refresh_token;
    unrelatedAdminToken = (
      await login(harness, "m3b12-admin-u@example.com", "admin-u")
    ).access_token;

    const zone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: adminToken,
        body: {
          name: "Reassign Zone",
          boundary: square(80.0, 50.0, 80.2, 50.2),
        },
      }),
    );
    expect(zone.status).toBe(200);
    zoneId = ((await zone.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("architecture: shared lock protocol and same-transaction revocation/guards", () => {
    const locks = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/geography-locks.ts",
      ),
      "utf8",
    );
    expect(locks).toContain("geo:gov:");
    expect(locks).toContain("geo:city:");
    expect(locks).toContain("zone:");
    expect(locks).toContain("Deterministic acquisition order");

    const citySource = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/city/city.service.ts",
      ),
      "utf8",
    );
    expect(citySource).toContain("beginWithGeographyRetry");
    expect(citySource).toContain("lockCityReassignment");
    expect(citySource).toContain("before.operational && !after.operational");
    expect(citySource).toContain("revokeDashboardSessionsForCities");
    expect(citySource).toContain("lockCityGeography");

    const govSource = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/governorate/governorate.service.ts",
      ),
      "utf8",
    );
    expect(govSource).toContain("lockGovernorateAndCities");
    expect(govSource).toContain("beginWithGeographyRetry");
    expect(govSource).toContain("revokeDashboardSessionsForCities");

    const zoneSource = readFileSync(
      join(
        import.meta.dir,
        "../../src/modules/geography/zone/zone.service.ts",
      ),
      "utf8",
    );
    expect(zoneSource).toContain("lockCityGeography");
    expect(zoneSource).toContain("assertCityOperability");
    expect(zoneSource).toContain("lockZoneOverlap");
    expect(zoneSource).toContain("beginWithGeographyRetry");
    const createIdx = zoneSource.indexOf("async create(");
    const updateIdx = zoneSource.indexOf("async update(");
    const archiveIdx = zoneSource.indexOf("async archive(");
    for (const idx of [createIdx, updateIdx, archiveIdx]) {
      expect(idx).toBeGreaterThan(-1);
      const slice = zoneSource.slice(idx, idx + 2500);
      expect(slice).toContain("lockCityGeography");
      expect(slice).toContain("assertCityOperability");
      expect(slice).toContain("beginWithGeographyRetry");
    }
    expect(zoneSource).toContain(
      "Early rejection only — authoritative operability is re-checked",
    );
  });

  test("operational → unavailable reassignment revokes ADMIN/employee sessions", async () => {
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
        )
      ).status,
    ).toBe(200);

    const moved = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}`, {
        method: "PATCH",
        token: superToken,
        body: { governorateId: govBInactive },
      }),
    );
    expect(moved.status).toBe(200);
    const movedBody = (await moved.json()) as {
      governorateId: string;
      governorate: { status: string };
    };
    expect(movedBody.governorateId).toBe(govBInactive);
    expect(movedBody.governorate.status).toBe("INACTIVE");

    const adminDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
    );
    const empDenied = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
        token: employeeToken,
      }),
    );
    expect(adminDenied.status).toBe(401);
    expect((await errorOf(adminDenied)).code).toBe("UNAUTHENTICATED");
    expect(empDenied.status).toBe(401);
    expect((await errorOf(empDenied)).code).toBe("UNAUTHENTICATED");

    await expectRefreshDenied(harness, adminRefresh, "admin-refresh-revoked");
    await expectRefreshDenied(harness, employeeRefresh, "emp-refresh-revoked");

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            token: unrelatedAdminToken,
          }),
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
  });

  test("returning to active Governorate does not restore revoked sessions", async () => {
    const restored = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}`, {
        method: "PATCH",
        token: superToken,
        body: { governorateId: govA },
      }),
    );
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { governorateId: string }).governorateId).toBe(
      govA,
    );

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
        )
      ).status,
    ).toBe(401);
    await expectRefreshDenied(harness, adminRefresh, "admin-still-revoked");
    await expectRefreshDenied(harness, employeeRefresh, "emp-still-revoked");

    const freshAdmin = await login(
      harness,
      "m3b12-admin@example.com",
      "admin-fresh",
    );
    const freshEmp = await login(harness, "m3b12-emp@example.com", "emp-fresh");
    adminToken = freshAdmin.access_token;
    adminRefresh = freshAdmin.refresh_token;
    employeeToken = freshEmp.access_token;
    employeeRefresh = freshEmp.refresh_token;

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
        )
      ).status,
    ).toBe(200);
  });

  test("operational → operational reassignment does not revoke sessions", async () => {
    const beforeClaims = tokenClaims(adminToken);
    expect(beforeClaims.cityId).toBe(city);

    const moved = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}`, {
        method: "PATCH",
        token: superToken,
        body: { governorateId: govC },
      }),
    );
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { governorateId: string }).governorateId).toBe(
      govC,
    );

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
        )
      ).status,
    ).toBe(200);
    expect(tokenClaims(adminToken).cityId).toBe(city);

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            token: unrelatedAdminToken,
          }),
        )
      ).status,
    ).toBe(200);

    // Move back to A for subsequent tests
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${city}`, {
            method: "PATCH",
            token: superToken,
            body: { governorateId: govA },
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("non-operability City field update does not revoke sessions", async () => {
    const renamed = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}`, {
        method: "PATCH",
        token: superToken,
        body: { translations: [{ locale: "en", name: "Reassign City Renamed" }] },
      }),
    );
    expect(renamed.status).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
        )
      ).status,
    ).toBe(200);
  });

  test("Zone update waits when City suspension holds geography locks first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    const [before] = await harness.client<{ name: string; updated_at: string }[]>`
      select name, updated_at::text as updated_at from zones where id = ${zoneId}`;

    const suspendHeld = harness.client.begin(async (tx) => {
      await lockCityGeography(tx, city);
      signalHeld();
      await gate;
      await tx`
        update cities set status = 'SUSPENDED', updated_at = now()
        where id = ${city}`;
      await revokeDashboardSessionsForCities(
        harness.auth.sessions,
        tx,
        [city],
        "CITY_UNAVAILABLE",
      );
    });

    await withTimeout(held, 5_000, "city suspension acquired geography locks");

    const zonePromise = harness.app.handle(
      jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
        method: "PATCH",
        token: adminToken,
        body: { name: `Should Not Commit ${crypto.randomUUID().slice(0, 8)}` },
      }),
    );

    await waitForLockWait(harness.client);
    release();
    await withTimeout(suspendHeld, 8_000, "city suspension commit");
    const zoneRes = await withTimeout(
      zonePromise,
      8_000,
      "zone update after suspension",
    );

    expect([401, 409]).toContain(zoneRes.status);
    const code = (await errorOf(zoneRes)).code;
    expect(["UNAUTHENTICATED", "CITY_NOT_ACTIVE"]).toContain(code);

    const [after] = await harness.client<{ name: string; updated_at: string }[]>`
      select name, updated_at::text as updated_at from zones where id = ${zoneId}`;
    expect(after?.name).toBe(before?.name);
    expect(after?.updated_at).toBe(before?.updated_at);

    // Restore city + fresh sessions for later tests
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${city}/activate`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);
    const freshAdmin = await login(
      harness,
      "m3b12-admin@example.com",
      "admin-after-suspend",
    );
    const freshEmp = await login(
      harness,
      "m3b12-emp@example.com",
      "emp-after-suspend",
    );
    adminToken = freshAdmin.access_token;
    adminRefresh = freshAdmin.refresh_token;
    employeeToken = freshEmp.access_token;
    employeeRefresh = freshEmp.refresh_token;
  });

  test("Zone mutation wins when it holds geography locks before City suspension", async () => {
    const newName = `Zone Won ${crypto.randomUUID().slice(0, 8)}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    const zoneHeld = harness.client.begin(async (tx) => {
      const state = await lockCityGeography(tx, city);
      expect(state.operational).toBe(true);
      await lockZoneOverlap(tx, city);
      signalHeld();
      await gate;
      await tx`
        update zones set name = ${newName}, updated_at = now()
        where id = ${zoneId} and city_id = ${city}`;
    });

    await withTimeout(held, 5_000, "zone mutation acquired geography locks");

    const suspendPromise = harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}/suspend`, {
        method: "POST",
        token: superToken,
      }),
    );

    await waitForLockWait(harness.client);
    release();
    await withTimeout(zoneHeld, 8_000, "zone mutation commit");
    expect(
      (await withTimeout(suspendPromise, 8_000, "city suspension after zone")).status,
    ).toBe(200);

    const [row] = await harness.client<{ name: string }[]>`
      select name from zones where id = ${zoneId}`;
    expect(row?.name).toBe(newName);

    const denied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
    );
    expect(denied.status).toBe(401);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/cities/${city}/activate`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);
    const freshAdmin = await login(
      harness,
      "m3b12-admin@example.com",
      "admin-after-zone-win",
    );
    const freshEmp = await login(
      harness,
      "m3b12-emp@example.com",
      "emp-after-zone-win",
    );
    adminToken = freshAdmin.access_token;
    adminRefresh = freshAdmin.refresh_token;
    employeeToken = freshEmp.access_token;
    employeeRefresh = freshEmp.refresh_token;
  });

  test("Zone update fails when Governorate deactivation holds conflicting locks first", async () => {
    const [cityGov] = await harness.client<{ governorate_id: string }[]>`
      select governorate_id::text as governorate_id from cities where id = ${city}`;
    const govId = cityGov!.governorate_id;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    const [before] = await harness.client<{ name: string; updated_at: string }[]>`
      select name, updated_at::text as updated_at from zones where id = ${zoneId}`;

    const deactHeld = harness.client.begin(async (tx) => {
      const cityIds = await lockGovernorateAndCities(tx, govId);
      signalHeld();
      await gate;
      await tx`
        update governorates set status = 'INACTIVE', updated_at = now()
        where id = ${govId}`;
      await revokeDashboardSessionsForCities(
        harness.auth.sessions,
        tx,
        cityIds,
        "GOVERNORATE_UNAVAILABLE",
      );
    });

    await withTimeout(held, 5_000, "governorate deactivation acquired locks");

    const zonePromise = harness.app.handle(
      jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
        method: "PATCH",
        token: adminToken,
        body: { name: `Gov Race Fail ${crypto.randomUUID().slice(0, 8)}` },
      }),
    );

    await waitForLockWait(harness.client);
    release();
    await withTimeout(deactHeld, 8_000, "governorate deactivation commit");
    const zoneRes = await withTimeout(
      zonePromise,
      8_000,
      "zone update after gov deactivation",
    );
    expect([401, 409]).toContain(zoneRes.status);
    expect(["UNAUTHENTICATED", "CITY_NOT_ACTIVE"]).toContain(
      (await errorOf(zoneRes)).code,
    );

    const [after] = await harness.client<{ name: string; updated_at: string }[]>`
      select name, updated_at::text as updated_at from zones where id = ${zoneId}`;
    expect(after?.name).toBe(before?.name);
    expect(after?.updated_at).toBe(before?.updated_at);

    await harness.client`
      update governorates set status = 'ACTIVE', updated_at = now()
      where id = ${govId}`;
    const freshAdmin = await login(
      harness,
      "m3b12-admin@example.com",
      "admin-after-gov",
    );
    const freshEmp = await login(
      harness,
      "m3b12-emp@example.com",
      "emp-after-gov",
    );
    adminToken = freshAdmin.access_token;
    adminRefresh = freshAdmin.refresh_token;
    employeeToken = freshEmp.access_token;
    employeeRefresh = freshEmp.refresh_token;
  });

  test("City reassignment into Governorate being deactivated cannot leave active sessions", async () => {
    // Ensure city under active govA and sessions live
    await harness.client`
      update cities set governorate_id = ${govA}, status = 'ACTIVE', updated_at = now()
      where id = ${city}`;
    await harness.client`
      update governorates set status = 'ACTIVE', updated_at = now()
      where id = ${govA}`;
    await harness.client`
      update governorates set status = 'ACTIVE', updated_at = now()
      where id = ${govC}`;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    // Target gov C: hold deactivation after geography locks, before commit
    const deactHeld = harness.client.begin(async (tx) => {
      const cityIds = await lockGovernorateAndCities(tx, govC);
      signalHeld();
      await gate;
      await tx`
        update governorates set status = 'INACTIVE', updated_at = now()
        where id = ${govC}`;
      await revokeDashboardSessionsForCities(
        harness.auth.sessions,
        tx,
        cityIds,
        "GOVERNORATE_UNAVAILABLE",
      );
    });

    await withTimeout(held, 5_000, "target gov deactivation acquired locks");

    const reassignPromise = harness.app.handle(
      jsonRequest(`/api/v1/dashboard/cities/${city}`, {
        method: "PATCH",
        token: superToken,
        body: { governorateId: govC },
      }),
    );

    await waitForLockWait(harness.client);
    release();
    await withTimeout(deactHeld, 8_000, "gov C deactivation commit");
    const reassignRes = await withTimeout(
      reassignPromise,
      8_000,
      "city reassignment after gov deactivation",
    );
    expect(reassignRes.status).toBe(200);

    const state = await readCityOperability(harness.client, city);
    expect(state.governorateId).toBe(govC);
    expect(state.operational).toBe(false);

    const adminDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: adminToken }),
    );
    const empDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", { token: employeeToken }),
    );
    expect(adminDenied.status).toBe(401);
    expect(empDenied.status).toBe(401);
    await expectRefreshDenied(harness, adminRefresh, "reassign-race-admin");
    await expectRefreshDenied(harness, employeeRefresh, "reassign-race-emp");

    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            token: unrelatedAdminToken,
          }),
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

    // Cleanup: restore geography for any trailing assertions
    await harness.client`
      update cities set governorate_id = ${govA}, status = 'ACTIVE', updated_at = now()
      where id = ${city}`;
    await harness.client`
      update governorates set status = 'ACTIVE', updated_at = now()
      where id = ${govC}`;
  });

  test("holding City geography locks does not block unrelated City Zone mutations", async () => {
    const unrelatedZone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: unrelatedAdminToken,
        body: {
          name: `Unrelated Zone ${crypto.randomUUID().slice(0, 8)}`,
          boundary: square(10.0, 10.0, 10.2, 10.2),
        },
      }),
    );
    expect(unrelatedZone.status).toBe(200);
    const unrelatedZoneId = ((await unrelatedZone.json()) as { id: string }).id;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    const heldTx = harness.client.begin(async (tx) => {
      await lockCityReassignment(tx, city, govC);
      signalHeld();
      await gate;
    });

    await withTimeout(held, 5_000, "reassignment locks held");
    const rename = `Unrelated Live ${crypto.randomUUID().slice(0, 8)}`;
    const unrelated = await withTimeout(
      harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${unrelatedZoneId}`, {
          method: "PATCH",
          token: unrelatedAdminToken,
          body: { name: rename },
        }),
      ),
      5_000,
      "unrelated city zone update while other city locked",
    );
    expect(unrelated.status).toBe(200);
    expect(((await unrelated.json()) as { name: string }).name).toBe(rename);

    release();
    await withTimeout(heldTx, 5_000, "reassignment lock holder release");
  });
});
