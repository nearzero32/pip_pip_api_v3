import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
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

describe("M3-B1 Zones and PostGIS", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminAToken = "";
  let adminAId = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3b1",
    });
    cityA = await createActiveCity(harness.client, "Zone City A");
    cityB = await createActiveCity(harness.client, "Zone City B");
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b1-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b1-admin-a@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3b1-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3b1-ops@example.com",
      password,
      roles: ["OPERATIONS"],
      cityId: cityA,
      managedByAccountId: adminAId,
    });
    superToken = (
      await harness.auth.dashboard.login({
        email: "m3b1-super@example.com",
        password,
        deviceName: "s",
        ip: "s",
        requestId: "s",
      })
    ).access_token;
    adminAToken = (
      await harness.auth.dashboard.login({
        email: "m3b1-admin-a@example.com",
        password,
        deviceName: "a",
        ip: "a",
        requestId: "a",
      })
    ).access_token;
    adminBToken = (
      await harness.auth.dashboard.login({
        email: "m3b1-admin-b@example.com",
        password,
        deviceName: "b",
        ip: "b",
        requestId: "b",
      })
    ).access_token;
    employeeToken = (
      await harness.auth.dashboard.login({
        email: "m3b1-ops@example.com",
        password,
        deviceName: "e",
        ip: "e",
        requestId: "e",
      })
    ).access_token;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("migration and infrastructure", () => {
    test("PostGIS extension, Polygon 4326 column, and GIST index exist", async () => {
      const [ext] = await harness.client<
        { installed: boolean; version: string }[]
      >`select true as installed, postgis_lib_version() as version`;
      expect(ext?.installed).toBe(true);
      expect(ext?.version.startsWith("3.5")).toBe(true);

      const [col] = await harness.client<
        { typname: string; typmod: string }[]
      >`select t.typname, format_type(a.atttypid, a.atttypmod) as typmod
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_type t on t.oid = a.atttypid
        where c.relname = 'zones' and a.attname = 'boundary' and a.attnum > 0`;
      expect(col?.typname).toBe("geometry");
      expect(col?.typmod.toLowerCase()).toContain("polygon");
      expect(col?.typmod).toContain("4326");

      const [gist] = await harness.client<
        { indexdef: string }[]
      >`select indexdef from pg_indexes where tablename = 'zones' and indexname = 'zones_boundary_gix'`;
      expect(gist?.indexdef.toLowerCase()).toContain("using gist");
      expect(gist?.indexdef.toLowerCase()).toContain("boundary");
    });
  });

  describe("authorization", () => {
    test("ADMIN can create/list/get/update/archive in its City", async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Admin Zone",
            boundary: square(44.1, 33.1, 44.2, 33.2),
          },
        }),
      );
      expect(created.status).toBe(200);
      const zone = (await created.json()) as {
        id: string;
        cityId: string;
        boundary: { type: string };
      };
      expect(zone.cityId).toBe(cityA);
      expect(zone.boundary.type).toBe("Polygon");

      const listed = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
      );
      expect(listed.status).toBe(200);

      const got = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zone.id}`, {
          token: adminAToken,
        }),
      );
      expect(got.status).toBe(200);

      const patched = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zone.id}`, {
          method: "PATCH",
          token: adminAToken,
          body: { name: "Admin Zone Updated", status: "INACTIVE" },
        }),
      );
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { status: string }).status).toBe(
        "INACTIVE",
      );

      const archived = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zone.id}`, {
          method: "DELETE",
          token: adminAToken,
        }),
      );
      expect(archived.status).toBe(200);
      expect(((await archived.json()) as { status: string }).status).toBe(
        "ARCHIVED",
      );
    });

    test("employee permissions are live and SUPER_ADMIN is blocked", async () => {
      const denied = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: employeeToken,
          body: { name: "Emp Zone", boundary: square(44.3, 33.3, 44.4, 33.4) },
        }),
      );
      expect(denied.status).toBe(403);

      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminAToken,
          body: { permission: "zones.create" },
        }),
      );
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminAToken,
          body: { permission: "zones.read" },
        }),
      );

      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: employeeToken,
          body: { name: "Emp Zone", boundary: square(44.3, 33.3, 44.4, 33.4) },
        }),
      );
      expect(created.status).toBe(200);
      const zoneId = ((await created.json()) as { id: string }).id;

      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/employees/${employeeId}/permissions/zones.create`,
          { method: "DELETE", token: adminAToken },
        ),
      );
      const revoked = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: employeeToken,
          body: {
            name: "Emp Zone 2",
            boundary: square(44.5, 33.5, 44.6, 33.6),
          },
        }),
      );
      expect(revoked.status).toBe(403);

      const updateDenied = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
          method: "PATCH",
          token: employeeToken,
          body: { name: "Nope" },
        }),
      );
      expect(updateDenied.status).toBe(403);

      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminAToken,
          body: { permission: "zones.update" },
        }),
      );
      const updateOk = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
          method: "PATCH",
          token: employeeToken,
          body: { name: "Emp Zone Renamed" },
        }),
      );
      expect(updateOk.status).toBe(200);

      const archiveDenied = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
          method: "DELETE",
          token: employeeToken,
        }),
      );
      expect(archiveDenied.status).toBe(403);

      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminAToken,
          body: { permission: "zones.archive" },
        }),
      );
      const archiveOk = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, {
          method: "DELETE",
          token: employeeToken,
        }),
      );
      expect(archiveOk.status).toBe(200);

      const superDenied = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: superToken,
          body: { name: "Super Zone", boundary: square(45, 34, 45.1, 34.1) },
        }),
      );
      expect(superDenied.status).toBe(403);

      const unauth = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", { method: "GET" }),
      );
      expect(unauth.status).toBe(401);
    });

    test("X-City-Id cannot override dashboard City context", async () => {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          headers: { "X-City-Id": cityB },
          body: {
            name: "Header Override Zone",
            boundary: square(46.0, 35.0, 46.1, 35.1),
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { cityId: string }).cityId).toBe(
        cityA,
      );
    });
  });

  describe("isolation", () => {
    let zoneAId = "";
    let zoneBId = "";

    beforeAll(async () => {
      const a = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Isolation A",
            boundary: square(47.0, 36.0, 47.1, 36.1),
          },
        }),
      );
      zoneAId = ((await a.json()) as { id: string }).id;
      const b = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminBToken,
          body: {
            name: "Isolation B",
            boundary: square(47.0, 36.0, 47.1, 36.1),
          },
        }),
      );
      expect(b.status).toBe(200);
      zoneBId = ((await b.json()) as { id: string }).id;
    });

    test("same geometry may exist in different Cities", async () => {
      expect(zoneAId).not.toBe(zoneBId);
    });

    test("ADMIN A cannot access City B zones", async () => {
      const list = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", { token: adminAToken }),
      );
      const body = (await list.json()) as { data: { id: string }[] };
      expect(body.data.some((z) => z.id === zoneBId)).toBe(false);

      for (const method of ["GET", "PATCH", "DELETE"] as const) {
        const response = await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/zones/${zoneBId}`, {
            method,
            token: adminAToken,
            ...(method === "PATCH" ? { body: { name: "stolen" } } : {}),
          }),
        );
        expect(response.status).toBe(404);
        expect((await errorOf(response)).code).toBe("ZONE_NOT_FOUND");
      }
    });

    test("body cityId is rejected", async () => {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Body City",
            cityId: cityB,
            boundary: square(48.0, 37.0, 48.1, 37.1),
          },
        }),
      );
      expect(response.status).toBe(422);
    });
  });

  describe("geometry and overlap", () => {
    test("valid polygon succeeds and invalid inputs fail", async () => {
      const ok = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Valid Poly",
            boundary: square(50.0, 30.0, 50.2, 30.2),
          },
        }),
      );
      expect(ok.status).toBe(200);

      const cases: { name: string; boundary: unknown }[] = [
        {
          name: "point",
          boundary: { type: "Point", coordinates: [50.1, 30.1] },
        },
        {
          name: "open",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [50.3, 30.3],
                [50.4, 30.3],
                [50.4, 30.4],
                [50.3, 30.4],
              ],
            ],
          },
        },
        {
          name: "short",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [50.5, 30.5],
                [50.6, 30.5],
                [50.5, 30.5],
              ],
            ],
          },
        },
        {
          name: "oor",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [200, 30],
                [201, 30],
                [201, 31],
                [200, 31],
                [200, 30],
              ],
            ],
          },
        },
        {
          name: "empty",
          boundary: { type: "Polygon", coordinates: [] },
        },
        {
          name: "bowtie",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [51.0, 31.0],
                [51.2, 31.2],
                [51.0, 31.2],
                [51.2, 31.0],
                [51.0, 31.0],
              ],
            ],
          },
        },
      ];
      for (const item of cases) {
        const response = await harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: adminAToken,
            body: { name: `bad-${item.name}`, boundary: item.boundary },
          }),
        );
        expect([400, 422]).toContain(response.status);
        const code = (await errorOf(response)).code;
        expect(["INVALID_ZONE_BOUNDARY", "VALIDATION_FAILED"]).toContain(code);
      }
    });

    test("overlap, containment, identical rejected; shared border/vertex allowed", async () => {
      const base = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Overlap Base",
            boundary: square(52.0, 32.0, 52.2, 32.2),
          },
        }),
      );
      expect(base.status).toBe(200);
      const baseId = ((await base.json()) as { id: string }).id;

      const partial = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Partial Overlap",
            boundary: square(52.1, 32.1, 52.3, 32.3),
          },
        }),
      );
      expect(partial.status).toBe(409);
      expect((await errorOf(partial)).code).toBe("ZONE_BOUNDARY_OVERLAP");

      const contained = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Contained",
            boundary: square(52.05, 32.05, 52.15, 32.15),
          },
        }),
      );
      expect(contained.status).toBe(409);

      const identical = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Identical",
            boundary: square(52.0, 32.0, 52.2, 32.2),
          },
        }),
      );
      expect(identical.status).toBe(409);

      const sharedBorder = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Shared Border",
            boundary: square(52.2, 32.0, 52.4, 32.2),
          },
        }),
      );
      expect(sharedBorder.status).toBe(200);

      const sharedVertex = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Shared Vertex",
            boundary: square(52.2, 32.2, 52.4, 32.4),
          },
        }),
      );
      expect(sharedVertex.status).toBe(200);

      const selfUpdate = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${baseId}`, {
          method: "PATCH",
          token: adminAToken,
          body: { boundary: square(52.0, 32.0, 52.2, 32.2) },
        }),
      );
      expect(selfUpdate.status).toBe(200);

      const intoOther = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${baseId}`, {
          method: "PATCH",
          token: adminAToken,
          body: { boundary: square(52.2, 32.0, 52.4, 32.2) },
        }),
      );
      expect(intoOther.status).toBe(409);

      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${baseId}`, {
          method: "DELETE",
          token: adminAToken,
        }),
      );
      const replacement = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Replacement After Archive",
            boundary: square(52.0, 32.0, 52.2, 32.2),
          },
        }),
      );
      expect(replacement.status).toBe(200);
    });
  });

  describe("concurrency", () => {
    test("concurrent overlapping creates in same City cannot both succeed", async () => {
      const boundary = square(53.0, 33.0, 53.2, 33.2);
      const results = await Promise.all([
        harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: adminAToken,
            body: { name: "Concurrent A1", boundary },
          }),
        ),
        harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: adminAToken,
            body: { name: "Concurrent A2", boundary },
          }),
        ),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);

      const [overlapCount] = await harness.client<{ n: string }[]>`
        select count(*)::text as n
        from zones z1
        join zones z2 on z1.id < z2.id
        where z1.city_id = ${cityA}
          and z2.city_id = ${cityA}
          and z1.status <> 'ARCHIVED'
          and z2.status <> 'ARCHIVED'
          and ST_Intersects(z1.boundary, z2.boundary)
          and not ST_Touches(z1.boundary, z2.boundary)`;
      expect(Number(overlapCount?.n ?? 1)).toBe(0);
    });

    test("concurrent boundary updates cannot create overlapping committed Zones", async () => {
      const left = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Concurrent Update Left",
            boundary: square(60.0, 40.0, 60.1, 40.1),
          },
        }),
      );
      const right = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Concurrent Update Right",
            boundary: square(60.3, 40.0, 60.4, 40.1),
          },
        }),
      );
      const leftId = ((await left.json()) as { id: string }).id;
      const rightId = ((await right.json()) as { id: string }).id;
      const colliding = square(60.15, 40.0, 60.25, 40.1);
      const results = await Promise.all([
        harness.app.handle(
          jsonRequest(`/api/v1/dashboard/zones/${leftId}`, {
            method: "PATCH",
            token: adminAToken,
            body: { boundary: colliding },
          }),
        ),
        harness.app.handle(
          jsonRequest(`/api/v1/dashboard/zones/${rightId}`, {
            method: "PATCH",
            token: adminAToken,
            body: { boundary: colliding },
          }),
        ),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const [overlapCount] = await harness.client<{ n: string }[]>`
        select count(*)::text as n
        from zones z1
        join zones z2 on z1.id < z2.id
        where z1.city_id = ${cityA}
          and z2.city_id = ${cityA}
          and z1.status <> 'ARCHIVED'
          and z2.status <> 'ARCHIVED'
          and ST_Intersects(z1.boundary, z2.boundary)
          and not ST_Touches(z1.boundary, z2.boundary)`;
      expect(Number(overlapCount?.n ?? 1)).toBe(0);
    });

    test("different Cities can create the same overlapping geometry concurrently", async () => {
      const boundary = square(54.0, 34.0, 54.2, 34.2);
      const results = await Promise.all([
        harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: adminAToken,
            body: { name: "Cross City A", boundary },
          }),
        ),
        harness.app.handle(
          jsonRequest("/api/v1/dashboard/zones", {
            method: "POST",
            token: adminBToken,
            body: { name: "Cross City B", boundary },
          }),
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  });

  describe("public API", () => {
    let publicZoneId = "";
    let olderSharedId = "";
    let newerSharedId = "";

    beforeAll(async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Public Active",
            boundary: square(55.0, 35.0, 55.2, 35.2),
          },
        }),
      );
      publicZoneId = ((await created.json()) as { id: string }).id;

      const inactive = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Public Inactive",
            boundary: square(55.3, 35.3, 55.4, 35.4),
          },
        }),
      );
      const inactiveId = ((await inactive.json()) as { id: string }).id;
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${inactiveId}`, {
          method: "PATCH",
          token: adminAToken,
          body: { status: "INACTIVE" },
        }),
      );

      const left = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Shared Left",
            boundary: square(56.0, 36.0, 56.2, 36.2),
          },
        }),
      );
      olderSharedId = ((await left.json()) as { id: string }).id;
      await new Promise((r) => setTimeout(r, 20));
      const right = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Shared Right",
            boundary: square(56.2, 36.0, 56.4, 36.2),
          },
        }),
      );
      newerSharedId = ((await right.json()) as { id: string }).id;
      void newerSharedId;
    });

    test("missing/invalid City context preserves M3-B0 behavior", async () => {
      const missing = await harness.app.handle(
        new Request("http://localhost/api/v1/public/zones"),
      );
      expect(missing.status).toBe(400);
      expect((await errorOf(missing)).code).toBe("CITY_CONTEXT_REQUIRED");
    });

    test("public list returns only active non-archived zones for header City", async () => {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/public/zones", {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { id: string; name: string; boundary: unknown }[];
      };
      expect(body.data.some((z) => z.id === publicZoneId)).toBe(true);
      expect(body.data.every((z) => !("cityId" in z) && !("status" in z))).toBe(
        true,
      );

      const other = await harness.app.handle(
        jsonRequest("/api/v1/public/zones", {
          headers: { "X-City-Id": cityB },
        }),
      );
      const otherBody = (await other.json()) as { data: { id: string }[] };
      expect(otherBody.data.some((z) => z.id === publicZoneId)).toBe(false);
    });

    test("resolver uses ST_Covers with deterministic shared-border tie-break", async () => {
      const inside = await harness.app.handle(
        jsonRequest(
          "/api/v1/public/zones/resolve?longitude=55.1&latitude=35.1",
          {
            headers: { "X-City-Id": cityA },
          },
        ),
      );
      expect(inside.status).toBe(200);
      expect(((await inside.json()) as { id: string }).id).toBe(publicZoneId);

      const outside = await harness.app.handle(
        jsonRequest("/api/v1/public/zones/resolve?longitude=10&latitude=10", {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(outside.status).toBe(404);
      expect((await errorOf(outside)).code).toBe("ZONE_NOT_FOUND");

      const boundaryPoint = await harness.app.handle(
        jsonRequest(
          "/api/v1/public/zones/resolve?longitude=56.2&latitude=36.1",
          { headers: { "X-City-Id": cityA } },
        ),
      );
      expect(boundaryPoint.status).toBe(200);
      expect(((await boundaryPoint.json()) as { id: string }).id).toBe(
        olderSharedId,
      );

      const queryOverride = await harness.app.handle(
        jsonRequest(`/api/v1/public/zones?cityId=${cityB}`, {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(queryOverride.status).toBe(200);
      const overrideBody = (await queryOverride.json()) as {
        data: { id: string }[];
      };
      expect(overrideBody.data.some((z) => z.id === publicZoneId)).toBe(true);
      // cityId query must not authorize/switch City; header City remains authoritative.
    });
  });

  describe("OpenAPI", () => {
    test("documents dashboard bearer auth, public X-City-Id, and GeoJSON contracts", async () => {
      const document = (await (
        await harness.app.handle(new Request("http://localhost/openapi/json"))
      ).json()) as {
        components?: { parameters?: Record<string, { name?: string }> };
        paths: Record<
          string,
          Record<
            string,
            {
              security?: unknown;
              parameters?: unknown;
              requestBody?: unknown;
              responses?: Record<string, unknown>;
            }
          >
        >;
      };
      expect(document.components?.parameters?.CityIdHeader?.name).toBe(
        "X-City-Id",
      );
      expect(document.paths["/api/v1/dashboard/zones"]?.post?.security).toEqual(
        [{ bearerAuth: [] }],
      );
      expect(document.paths["/api/v1/dashboard/zones"]?.get?.security).toEqual([
        { bearerAuth: [] },
      ]);
      const dashPost = JSON.stringify(
        document.paths["/api/v1/dashboard/zones"]!.post,
      );
      expect(dashPost).not.toContain("X-City-Id");
      expect(dashPost).toContain("Polygon");
      expect(dashPost).toContain("bearerAuth");

      const publicList = document.paths["/api/v1/public/zones"]!.get!;
      const publicListText = JSON.stringify(publicList);
      expect(
        publicListText.includes("CityIdHeader") ||
          publicListText.includes("X-City-Id") ||
          publicListText.includes("x-city-id"),
      ).toBe(true);
      expect(publicList.security ?? []).not.toEqual([{ bearerAuth: [] }]);

      const publicResolve =
        document.paths["/api/v1/public/zones/resolve"]!.get!;
      const resolveText = JSON.stringify(publicResolve);
      expect(
        resolveText.includes("CityIdHeader") ||
          resolveText.includes("X-City-Id") ||
          resolveText.includes("x-city-id"),
      ).toBe(true);
      expect(resolveText).toContain("longitude");
      expect(resolveText).toContain("latitude");
      expect(resolveText).not.toContain('"Any"');
    });
  });

  describe("M3-B1.1 authorization and spatial policy gaps", () => {
    test("live zones.read revocation forbids list/get with the same access token", async () => {
      const empId = await createStaffAccount(harness.auth, harness.client, {
        email: "m3b1-read-rev@example.com",
        password,
        roles: ["SUPPORT"],
        cityId: cityA,
        managedByAccountId: adminAId,
      });
      for (const permission of ["zones.read", "zones.create"] as const) {
        expect(
          (
            await harness.app.handle(
              jsonRequest(`/api/v1/dashboard/employees/${empId}/permissions`, {
                method: "POST",
                token: adminAToken,
                body: { permission },
              }),
            )
          ).status,
        ).toBe(200);
      }
      const token = (
        await harness.auth.dashboard.login({
          email: "m3b1-read-rev@example.com",
          password,
          deviceName: "rr",
          ip: "rr",
          requestId: "rr",
        })
      ).access_token;
      const zone = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token,
          body: {
            name: "Read Revoke Zone",
            boundary: square(72.0, 42.0, 72.1, 42.1),
          },
        }),
      );
      expect(zone.status).toBe(200);
      const zoneId = ((await zone.json()) as { id: string }).id;
      expect(
        (
          await harness.app.handle(
            jsonRequest("/api/v1/dashboard/zones", { token }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await harness.app.handle(
            jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, { token }),
          )
        ).status,
      ).toBe(200);

      expect(
        (
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/employees/${empId}/permissions/zones.read`,
              { method: "DELETE", token: adminAToken },
            ),
          )
        ).status,
      ).toBe(200);

      expect(
        (
          await harness.app.handle(
            jsonRequest("/api/v1/dashboard/zones", { token }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await harness.app.handle(
            jsonRequest(`/api/v1/dashboard/zones/${zoneId}`, { token }),
          )
        ).status,
      ).toBe(403);
      // Independently granted create still works
      expect(
        (
          await harness.app.handle(
            jsonRequest("/api/v1/dashboard/zones", {
              method: "POST",
              token,
              body: {
                name: "Still Create",
                boundary: square(72.2, 42.2, 72.3, 42.3),
              },
            }),
          )
        ).status,
      ).toBe(200);
    });

    test("cross-City employee Zone IDs return ZONE_NOT_FOUND", async () => {
      const empId = await createStaffAccount(harness.auth, harness.client, {
        email: "m3b1-xcity-emp@example.com",
        password,
        roles: ["OPERATIONS"],
        cityId: cityA,
        managedByAccountId: adminAId,
      });
      for (const permission of [
        "zones.read",
        "zones.update",
        "zones.archive",
      ] as const) {
        expect(
          (
            await harness.app.handle(
              jsonRequest(`/api/v1/dashboard/employees/${empId}/permissions`, {
                method: "POST",
                token: adminAToken,
                body: { permission },
              }),
            )
          ).status,
        ).toBe(200);
      }
      const token = (
        await harness.auth.dashboard.login({
          email: "m3b1-xcity-emp@example.com",
          password,
          deviceName: "xc",
          ip: "xc",
          requestId: "xc",
        })
      ).access_token;
      const foreign = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminBToken,
          body: {
            name: "Foreign Zone B",
            boundary: square(73.0, 43.0, 73.1, 43.1),
          },
        }),
      );
      expect(foreign.status).toBe(200);
      const zoneBId = ((await foreign.json()) as { id: string }).id;

      for (const init of [
        { method: "GET" as const },
        { method: "PATCH" as const, body: { name: "stolen" } },
        { method: "DELETE" as const },
      ]) {
        const response = await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/zones/${zoneBId}`, {
            ...init,
            token,
            headers: { "X-City-Id": cityB },
          }),
        );
        expect(response.status).toBe(404);
        expect((await errorOf(response)).code).toBe("ZONE_NOT_FOUND");
      }
    });

    test("inactive non-archived Zone still blocks positive-area overlap", async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Inactive Overlap Base",
            boundary: square(74.0, 44.0, 74.2, 44.2),
          },
        }),
      );
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { id: string }).id;
      expect(
        (
          await harness.app.handle(
            jsonRequest(`/api/v1/dashboard/zones/${id}`, {
              method: "PATCH",
              token: adminAToken,
              body: { status: "INACTIVE" },
            }),
          )
        ).status,
      ).toBe(200);
      const overlap = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Inactive Overlap Challenger",
            boundary: square(74.1, 44.1, 74.3, 44.3),
          },
        }),
      );
      expect(overlap.status).toBe(409);
      expect((await errorOf(overlap)).code).toBe("ZONE_BOUNDARY_OVERLAP");
    });

    test("public resolver ignores inactive and archived Zones", async () => {
      const active = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Resolver Active",
            boundary: square(75.0, 45.0, 75.2, 45.2),
          },
        }),
      );
      const activeId = ((await active.json()) as { id: string }).id;

      const inactive = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Resolver Inactive",
            boundary: square(75.3, 45.3, 75.4, 45.4),
          },
        }),
      );
      const inactiveId = ((await inactive.json()) as { id: string }).id;
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${inactiveId}`, {
          method: "PATCH",
          token: adminAToken,
          body: { status: "INACTIVE" },
        }),
      );

      const archived = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/zones", {
          method: "POST",
          token: adminAToken,
          body: {
            name: "Resolver Archived",
            boundary: square(75.5, 45.5, 75.6, 45.6),
          },
        }),
      );
      const archivedId = ((await archived.json()) as { id: string }).id;
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/zones/${archivedId}`, {
          method: "DELETE",
          token: adminAToken,
        }),
      );

      const hit = await harness.app.handle(
        jsonRequest("/api/v1/public/zones/resolve?longitude=75.1&latitude=45.1", {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(hit.status).toBe(200);
      expect(((await hit.json()) as { id: string }).id).toBe(activeId);

      const missInactive = await harness.app.handle(
        jsonRequest("/api/v1/public/zones/resolve?longitude=75.35&latitude=45.35", {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(missInactive.status).toBe(404);
      expect((await errorOf(missInactive)).code).toBe("ZONE_NOT_FOUND");

      const missArchived = await harness.app.handle(
        jsonRequest("/api/v1/public/zones/resolve?longitude=75.55&latitude=45.55", {
          headers: { "X-City-Id": cityA },
        }),
      );
      expect(missArchived.status).toBe(404);

      const wrongCity = await harness.app.handle(
        jsonRequest("/api/v1/public/zones/resolve?longitude=75.1&latitude=45.1", {
          headers: { "X-City-Id": cityB },
        }),
      );
      expect(wrongCity.status).toBe(404);
    });

    test("public X-City-Id validation preserves M3-B0 codes", async () => {
      const missing = await harness.app.handle(
        new Request("http://localhost/api/v1/public/zones"),
      );
      expect(missing.status).toBe(400);
      expect((await errorOf(missing)).code).toBe("CITY_CONTEXT_REQUIRED");

      const malformed = await harness.app.handle(
        jsonRequest("/api/v1/public/zones", {
          headers: { "X-City-Id": "not-a-uuid" },
        }),
      );
      expect(malformed.status).toBe(400);
      expect((await errorOf(malformed)).code).toBe("INVALID_CITY_CONTEXT");

      const unknown = await harness.app.handle(
        jsonRequest("/api/v1/public/zones", {
          headers: { "X-City-Id": "11111111-1111-4111-8111-999999999999" },
        }),
      );
      expect(unknown.status).toBe(404);
      expect((await errorOf(unknown)).code).toBe("CITY_NOT_FOUND");

      const suspendedCity = await createActiveCity(
        harness.client,
        "Public Suspend City",
      );
      await harness.client`
        update cities set status='SUSPENDED',updated_at=now() where id=${suspendedCity}`;
      const suspended = await harness.app.handle(
        jsonRequest("/api/v1/public/zones", {
          headers: { "X-City-Id": suspendedCity },
        }),
      );
      expect(suspended.status).toBe(409);
      expect((await errorOf(suspended)).code).toBe("CITY_NOT_ACTIVE");
    });

    test("wrong SRID geometry is rejected by PostGIS column type", async () => {
      let failed = false;
      try {
        await harness.client.begin(async (tx) => {
          await tx`
            insert into zones (city_id, name, boundary, status)
            values (
              ${cityA},
              ${`Wrong SRID ${crypto.randomUUID().slice(0, 8)}`},
              ST_SetSRID(
                ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))'),
                3857
              ),
              'ACTIVE'
            )`;
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      const [count] = await harness.client<{ n: string }[]>`
        select count(*)::text as n from zones
        where city_id=${cityA} and name like 'Wrong SRID%'`;
      expect(Number(count?.n ?? 1)).toBe(0);
    });
  });
});
