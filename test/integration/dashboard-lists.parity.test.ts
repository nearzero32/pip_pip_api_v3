import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DashboardExportService } from "../../src/modules/dashboard-export/dashboard-export.service";
import { reopenExcelWorkbook } from "../../src/modules/dashboard-export/xlsx";
import { DASHBOARD_LIST_ENDPOINTS } from "../../src/modules/dashboard-lists/inventory";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";
type Page = {
  data: Array<Record<string, unknown>>;
  pagination: { total: number; page: number; limit: number };
};

const excelFirstColumn = (bytes: Uint8Array): string[] => {
  const { sheetXml } = reopenExcelWorkbook(bytes);
  return [...sheetXml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)]
    .filter((m) => Number(m[1]) >= 2)
    .map((m) => {
      const cells = m[2] ?? "";
      const text = /<c r="A\d+"[^>]*>[\s\S]*?<t[^>]*>([^<]*)<\/t>/.exec(cells);
      const num = /<c r="A\d+"[^>]*>[\s\S]*?<v>([^<]*)<\/v>/.exec(cells);
      return text?.[1] ?? num?.[1] ?? "";
    });
};

const allListIds = async (
  h: IntegrationHarness,
  path: string,
  token: string,
  idField: string,
  search: string,
) => {
  const ids: string[] = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const res = await h.app.handle(
      jsonRequest(`${path}?search=${encodeURIComponent(search)}&page=${page}&limit=25`, {
        token,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    total = body.pagination.total;
    ids.push(...body.data.map((row) => String(row[idField] ?? row.id ?? "")));
    if (ids.length >= total || body.data.length === 0) break;
    page += 1;
  }
  return ids.filter(Boolean);
};

describe("dashboard list/export parity", () => {
  let h: IntegrationHarness;
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let cityA = "";
  let cityB = "";
  let storeId = "";
  let adminId = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_parity" });
    cityA = await createActiveCity(h.client, "ParityA");
    cityB = await createActiveCity(h.client, "ParityB");
    await createStaffAccount(h.auth, h.client, {
      email: "super.parity@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminId = await createStaffAccount(h.auth, h.client, {
      email: "admin.parity@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(h.auth, h.client, {
      email: "adminb.parity@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    const login = (email: string, id: string) =>
      h.auth.dashboard.login({ email, password, deviceName: id, ip: "127.0.0.1", requestId: id });
    superToken = (await login("super.parity@example.com", "s")).access_token;
    adminToken = (await login("admin.parity@example.com", "a")).access_token;
    adminBToken = (await login("adminb.parity@example.com", "b")).access_token;

    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityA}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
      ) returning id`;
    const [main] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityA}, 'ParityMain', ${media!.id}, 'ACTIVE', ${adminId}) returning id`;
    const [zone] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (${cityA}, 'ParityZone', ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326), 'ACTIVE')
      returning id`;
    for (const name of ["ParityStoreHit", "ParityStoreMiss"]) {
      const [storeLogo] = await h.client<{ id: string }[]>`
        insert into media_assets(
          city_id, purpose, visibility, status, object_key, original_name,
          expected_content_type, expected_size_bytes, verified_content_type,
          verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
        ) values (
          ${cityA}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
          'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
        ) returning id`;
      const [store] = await h.client<{ id: string }[]>`
        insert into stores(
          city_id, main_category_id, name, phone, address, location, logo_asset_id,
          status, order_acceptance_status, created_by_account_id
        ) values (
          ${cityA}, ${main!.id}, ${name}, '+9647000000001', 'Address',
          ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${storeLogo!.id},
          'ACTIVE', 'ACCEPTING', ${adminId}
        ) returning id`;
      if (name === "ParityStoreHit") storeId = store!.id;
      await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store!.id}, ${zone!.id}, ${cityA})`;
    }
    const [logoB] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityB}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
        'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
      ) returning id`;
    const [mediaB] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityB}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
      ) returning id`;
    const [mainB] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityB}, 'OtherMain', ${mediaB!.id}, 'ACTIVE', ${adminId}) returning id`;
    await h.client`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${cityB}, ${mainB!.id}, 'ParityStoreHit', '+9647000000002', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logoB!.id},
        'ACTIVE', 'ACCEPTING', ${adminId}
      )`;
  });

  afterAll(async () => {
    await h.close();
  });

  test("table-driven list vs xlsx IDs, sort, city isolation, audit, max rows", async () => {
    const cases = DASHBOARD_LIST_ENDPOINTS.filter((ep) =>
      ["governorates", "stores", "main-categories", "zones"].includes(ep.id),
    );
    expect(cases.length).toBe(4);
    for (const ep of cases) {
      const token = ep.actor === "super" ? superToken : adminToken;
      const search = ep.id === "governorates" ? "Baghdad" : ep.id === "stores" ? "ParityStoreHit" : ep.id === "zones" ? "ParityZone" : "ParityMain";
      const listPath = ep.pathTemplate.replace(":storeId", storeId);
      const exportPath = ep.exportPathTemplate!.replace(":storeId", storeId);
      const listIds = await allListIds(h, listPath, token, ep.idField, search);
      expect(listIds.length, ep.id).toBeGreaterThan(0);
      const exported = await h.app.handle(
        jsonRequest(`${exportPath}?search=${encodeURIComponent(search)}`, {
          token,
        }),
      );
      expect(exported.status, ep.id).toBe(200);
      const bytes = new Uint8Array(await exported.arrayBuffer());
      const excelIds = excelFirstColumn(bytes);
      expect(excelIds.slice().sort(), `${ep.id} ids`).toEqual(listIds.slice().sort());
      expect(excelIds, `${ep.id} sort`).toEqual(listIds);

      if (ep.scope === "CITY") {
        const leak = await h.app.handle(
          jsonRequest(`${exportPath}?search=${encodeURIComponent(search)}`, { token: adminBToken }),
        );
        if (leak.status === 200) {
          const other = excelFirstColumn(new Uint8Array(await leak.arrayBuffer()));
          expect(other.some((id) => listIds.includes(id))).toBe(false);
        }
      }

      const [audit] = await h.client<{ filters: Record<string, unknown> }[]>`
        select redacted_metadata->'filters' as filters
        from audit_logs
        where event_type = 'DASHBOARD_EXPORT'
        order by occurred_at desc
        limit 1`;
      expect(audit?.filters).toBeTruthy();
      expect(JSON.stringify(audit!.filters)).toContain("search");
    }

    const limited = new DashboardExportService(h.client, 1);
    await expect(
      limited.stores(
        {
          accountId: adminId,
          sessionId: null as unknown as string,
          applicationType: "DASHBOARD",
          roles: ["ADMIN"],
          scopeType: "CITY",
          cityId: cityA,
          storeId: null,
        },
        {},
        "limit-test",
      ),
    ).rejects.toMatchObject({ publicCode: "EXPORT_RESULT_LIMIT_EXCEEDED" });
  });
});
