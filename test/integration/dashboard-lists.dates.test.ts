import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { reopenExcelWorkbook } from "../../src/modules/dashboard-export/xlsx";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

type Page = {
  data: Array<{ id: string }>;
  pagination: { total: number };
};

const excelIds = (bytes: Uint8Array): string[] => {
  const { sheetXml } = reopenExcelWorkbook(bytes);
  return [...sheetXml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)]
    .filter((m) => Number(m[1]) >= 2)
    .map((m) => {
      const cells = m[2] ?? "";
      const text = /<c r="A\d+"[^>]*>[\s\S]*?<t[^>]*>([^<]*)<\/t>/.exec(cells);
      return text?.[1] ?? "";
    })
    .filter(Boolean);
};

describe("dashboard date-only half-open bounds", () => {
  let h: IntegrationHarness;
  let adminToken = "";
  let cityId = "";
  let id999 = "";
  let id9995 = "";
  let idNext = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_dates" });
    cityId = await createActiveCity(h.client, "DateCity");
    const adminId = await createStaffAccount(h.auth, h.client, {
      email: "admin.dates@example.com",
      password,
      roles: ["ADMIN"],
      cityId,
    });
    adminToken = (
      await h.auth.dashboard.login({
        email: "admin.dates@example.com",
        password,
        deviceName: "d",
        ip: "127.0.0.1",
        requestId: "d",
      })
    ).access_token;
    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityId}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
      ) returning id`;
    const [main] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityId}, 'DateMain', ${media!.id}, 'ACTIVE', ${adminId}) returning id`;
    const insertStore = async (name: string, createdAt: string) => {
      const [logo] = await h.client<{ id: string }[]>`
        insert into media_assets(
          city_id, purpose, visibility, status, object_key, original_name,
          expected_content_type, expected_size_bytes, verified_content_type,
          verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
        ) values (
          ${cityId}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
          'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
        ) returning id`;
      const [store] = await h.client<{ id: string }[]>`
        insert into stores(
          city_id, main_category_id, name, phone, address, location, logo_asset_id,
          status, order_acceptance_status, created_by_account_id, created_at
        ) values (
          ${cityId}, ${main!.id}, ${name}, '+9647000000099', 'Address',
          ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id},
          'ACTIVE', 'ACCEPTING', ${adminId}, ${createdAt}::timestamptz
        ) returning id`;
      return store!.id;
    };
    id999 = await insertStore("DateEdge999", "2026-08-01 23:59:59.999+03");
    id9995 = await insertStore("DateEdge9995", "2026-08-01 23:59:59.9995+03");
    idNext = await insertStore("DateEdgeNext", "2026-08-02 00:00:00+03");
  });

  afterAll(async () => {
    await h.close();
  });

  test("date-only to is start of next Baghdad day; sub-ms end-of-day rows stay in range", async () => {
    const inverted = await h.app.handle(
      jsonRequest(
        "/api/v1/dashboard/stores?createdFrom=2026-08-16&createdTo=2026-08-01",
        { token: adminToken },
      ),
    );
    expect(inverted.status).toBe(422);

    const list = await h.app.handle(
      jsonRequest(
        "/api/v1/dashboard/stores?createdFrom=2026-08-01&createdTo=2026-08-01&limit=100",
        { token: adminToken },
      ),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as Page;
    const ids = body.data.map((row) => row.id);
    expect(ids).toContain(id999);
    expect(ids).toContain(id9995);
    expect(ids).not.toContain(idNext);

    const offsetTo = await h.app.handle(
      jsonRequest(
        "/api/v1/dashboard/stores?createdFrom=2026-08-01T00:00:00.000%2B03:00&createdTo=2026-08-02T00:00:00.000%2B03:00&limit=100",
        { token: adminToken },
      ),
    );
    expect(offsetTo.status).toBe(200);
    const offsetIds = ((await offsetTo.json()) as Page).data.map((row) => row.id);
    expect(offsetIds).toContain(id999);
    expect(offsetIds).toContain(id9995);
    expect(offsetIds).not.toContain(idNext);

    const exported = await h.app.handle(
      jsonRequest(
        "/api/v1/dashboard/stores/export?createdFrom=2026-08-01&createdTo=2026-08-01",
        { token: adminToken },
      ),
    );
    expect(exported.status).toBe(200);
    const xlsx = excelIds(new Uint8Array(await exported.arrayBuffer()));
    expect(xlsx.slice().sort()).toEqual(ids.slice().sort());
    expect(xlsx).toContain(id999);
    expect(xlsx).toContain(id9995);
    expect(xlsx).not.toContain(idNext);
  });
});
