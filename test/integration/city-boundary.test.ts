import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { applyMigrations } from "../../src/db/migration-runner";
import { seedGovernorates } from "../../src/db/seed";
import { CityService } from "../../src/modules/geography/city/city.service";
import { AppError } from "../../src/errors/app-error";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error("TEST_ADMIN_DATABASE_URL is required");
const dbName = `pip_pip_city_boundary_${crypto.randomUUID().replaceAll("-", "")}`;
const square = { type: "Polygon", coordinates: [[[44.3, 33.2], [44.5, 33.2], [44.5, 33.4], [44.3, 33.4], [44.3, 33.2]]] } as const;
const hole = { type: "Polygon", coordinates: [square.coordinates[0], [[44.35, 33.25], [44.45, 33.25], [44.45, 33.35], [44.35, 33.35], [44.35, 33.25]]] } as const;
let admin: SQL, db: SQL, service: CityService, governorateId: string;
const identity = { accountId: crypto.randomUUID(), sessionId: crypto.randomUUID(), applicationType: "DASHBOARD", roles: ["SUPER_ADMIN"], scopeType: null, cityId: null, storeId: null } as any;
const sessions = { requireSuperAdmin() {} } as any;
const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return "OK"; } catch (error) { return (error as AppError).publicCode; }
};

describe("City Geographic Boundary", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl!, { max: 1 }); await admin.unsafe(`create database "${dbName}"`);
    const url = new URL(adminUrl!); url.pathname = `/${dbName}`; db = new SQL(url.toString(), { max: 6 });
    await applyMigrations(db); await seedGovernorates(db);
    governorateId = String((await db<{ id: string }[]>`select id::text id from governorates limit 1`)[0]!.id);
    service = new CityService(db, sessions);
  }, 30_000);
  afterAll(async () => { await db?.close(); await admin?.unsafe(`drop database if exists "${dbName}" with(force)`); await admin?.close(); });

  const create = (boundary: unknown, latitude = 33.3, longitude = 44.4) => service.create(identity, {
    governorateId, nameAr: "اختبار", nameEn: crypto.randomUUID(), latitude, longitude, displayOrder: 1, boundary,
  });

  test("normalizes Polygon to MultiPolygon 4326 and returns detail/list contracts", async () => {
    const city = await create(square) as any;
    expect(city.boundary.type).toBe("MultiPolygon"); expect(city.hasBoundary).toBeTrue();
    const [stored] = await db<{ type: string; srid: number }[]>`select GeometryType(boundary) type,ST_SRID(boundary)::int srid from cities where id=${city.id}`;
    expect(stored).toEqual({ type: "MULTIPOLYGON", srid: 4326 });
    const detail = await service.get(city.id) as any; expect(detail.boundary.type).toBe("MultiPolygon");
    const list = await service.list(identity, {}) as any; const row = list.data.find((x: any) => x.id === city.id);
    expect(row.hasBoundary).toBeTrue(); expect("boundary" in row).toBeFalse();
  });

  test("accepts MultiPolygon and enforces center covers semantics", async () => {
    const multi = { type: "MultiPolygon", coordinates: [square.coordinates] };
    expect((await create(multi) as any).boundary.type).toBe("MultiPolygon");
    expect(await codeOf(create(hole, 33.3, 44.4))).toBe("CITY_CENTER_OUTSIDE_BOUNDARY");
    expect((await create(square, 33.2, 44.3) as any).id).toBeTruthy();
    expect(await codeOf(create(square, 33.6, 44.4))).toBe("CITY_CENTER_OUTSIDE_BOUNDARY");
  });

  test("rejects missing, malformed, empty, self-intersecting and wrong boundaries", async () => {
    expect(await codeOf(create(undefined))).toBe("CITY_BOUNDARY_REQUIRED");
    for (const boundary of [
      { type: "Polygon", coordinates: [] },
      { type: "Point", coordinates: [44.4, 33.3] },
      { type: "LineString", coordinates: [[44.3, 33.2], [44.5, 33.4]] },
      { type: "Polygon", coordinates: [[[44.3, 33.2], [44.5, 33.4], [44.3, 33.4], [44.5, 33.2], [44.3, 33.2]]] },
      { type: "Polygon", coordinates: [[[44.3, 33.2], [44.5, 33.2], [44.5, 33.4], [44.3, 33.4]]] },
      { type: "Polygon", coordinates: [[[181, 33.2], [44.5, 33.2], [44.5, 33.4], [181, 33.2]]] },
    ]) expect(await codeOf(create(boundary))).toBe("INVALID_CITY_BOUNDARY");
  });

  test("PATCH validates final center and rejects null boundary", async () => {
    const city = await create(square) as any;
    expect(await codeOf(service.update(identity, city.id, { boundary: null }))).toBe("INVALID_CITY_BOUNDARY");
    expect(await codeOf(service.update(identity, city.id, { latitude: 33.6 }))).toBe("CITY_CENTER_OUTSIDE_BOUNDARY");
    const excludesCenter = { type: "Polygon", coordinates: [[[44.31, 33.21], [44.32, 33.21], [44.32, 33.22], [44.31, 33.22], [44.31, 33.21]]] };
    expect(await codeOf(service.update(identity, city.id, { boundary: excludesCenter }))).toBe("CITY_CENTER_OUTSIDE_BOUNDARY");
  });

  test("activation keeps legacy City blocked until a boundary exists", async () => {
    const [legacy] = await db<{ id: string }[]>`insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order) values(${governorateId},'قديم','legacy',33.3,44.4,'DRAFT',1) returning id::text id`;
    expect(await codeOf(service.transition(identity, legacy!.id, "ACTIVE"))).toBe("CITY_BOUNDARY_REQUIRED");
  });
});
