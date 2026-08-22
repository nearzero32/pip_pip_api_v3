import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DashboardExportService } from "../../src/modules/dashboard-export/dashboard-export.service";
import { reopenExcelWorkbook } from "../../src/modules/dashboard-export/xlsx";
import {
  DASHBOARD_LIST_COUNT,
  DASHBOARD_LIST_ENDPOINTS,
} from "../../src/modules/dashboard-lists/inventory";
import {
  createIntegrationHarness,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";
import { seedDashboardListWorld } from "./dashboard-list-fixture";

type Page = {
  data: Array<Record<string, unknown>>;
  pagination: { total: number; page: number; limit: number };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
};

const excelIds = (bytes: Uint8Array): string[] => {
  const { sheetXml } = reopenExcelWorkbook(bytes);
  return [...sheetXml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)]
    .filter((m) => Number(m[1]) >= 2)
    .map((m) => {
      const cells = m[2] ?? "";
      const values = [
        ...cells.matchAll(/<t[^>]*>([^<]*)<\/t>/g),
        ...cells.matchAll(/<v>([^<]*)<\/v>/g),
      ].map((hit) => hit[1] ?? "");
      return values.find((value) => UUID_RE.test(value)) ?? "";
    })
    .filter(Boolean);
};

const allListIds = async (
  h: IntegrationHarness,
  path: string,
  token: string,
  idField: string,
  query: Record<string, string>,
) => {
  const ids: string[] = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const res = await h.app.handle(
      jsonRequest(`${path}${qs({ ...query, page, limit: 25 })}`, { token }),
    );
    expect(res.status, `${path} ${JSON.stringify(query)}`).toBe(200);
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
  let world: Awaited<ReturnType<typeof seedDashboardListWorld>>;

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_parity" });
    world = await seedDashboardListWorld(h);
  });

  afterAll(async () => {
    await h.close();
  });

  test("inventory 24/24 list vs xlsx IDs, sort, city isolation, audit, permissions", async () => {
    expect(DASHBOARD_LIST_ENDPOINTS).toHaveLength(DASHBOARD_LIST_COUNT);
    expect(DASHBOARD_LIST_ENDPOINTS.every((ep) => ep.exportPathTemplate)).toBe(true);
    for (const ep of DASHBOARD_LIST_ENDPOINTS) {
      const token = ep.actor === "super" ? world.superToken : world.adminToken;
      const resolve = (template: string) =>
        template
          .replaceAll(":storeId", world.storeId)
          .replaceAll(":orderId", world.orderId)
          .replaceAll(":cityId", world.cityA);
      const listPath = resolve(ep.pathTemplate);
      const exportPath = resolve(ep.exportPathTemplate!);
      const query: Record<string, string> = {
        ...ep.andFilters,
        search: ep.andFilters.search ?? ep.searchHit,
        sortBy: ep.defaultSortBy,
        sortOrder: "asc",
      };
      if (ep.scope === "SUPER_ADMIN_EXPLICIT_CITY") {
        query.cityId = world.cityA;
      }
      if (ep.id === "store-commission-history") {
        query.storeId = world.storeId;
      }
      const listIds = await allListIds(h, listPath, token, ep.idField, query);
      expect(listIds.length, ep.id).toBeGreaterThan(0);

      const exportQuery = { ...query };
      delete exportQuery.page;
      delete exportQuery.limit;
      const exported = await h.app.handle(
        jsonRequest(`${exportPath}${qs(exportQuery)}`, { token }),
      );
      expect(exported.status, ep.id).toBe(200);
      const bytes = new Uint8Array(await exported.arrayBuffer());
      const xlsxIds = excelIds(bytes);
      expect(xlsxIds.slice().sort(), `${ep.id} ids`).toEqual(listIds.slice().sort());
      expect(xlsxIds, `${ep.id} sort`).toEqual(listIds);

      const denied = await h.app.handle(
        jsonRequest(`${exportPath}${qs(exportQuery)}`, { token: world.employeeToken }),
      );
      expect(denied.status, `${ep.id} export permission`).toBe(403);

      if (ep.scope === "CITY") {
        const leak = await h.app.handle(
          jsonRequest(`${exportPath}${qs(exportQuery)}`, { token: world.adminBToken }),
        );
        if (leak.status === 200) {
          const other = excelIds(new Uint8Array(await leak.arrayBuffer()));
          expect(other.some((id) => listIds.includes(id)), `${ep.id} city leak`).toBe(false);
        } else {
          expect([403, 404]).toContain(leak.status);
        }
      }

      const [audit] = await h.client<{ filters: Record<string, unknown> }[]>`
        select redacted_metadata->'filters' as filters
        from audit_logs
        where event_type = 'DASHBOARD_EXPORT'
        order by occurred_at desc
        limit 1`;
      expect(audit?.filters, ep.id).toBeTruthy();
    }

    const [superAcc] = await h.client<{ id: string }[]>`
      select account_id::text as id from account_emails
      where email_normalized = 'super.lists@example.com' limit 1`;
    const limited = new DashboardExportService(h.client, 1);
    await expect(
      limited.governorates(
        {
          accountId: superAcc!.id,
          sessionId: null as unknown as string,
          applicationType: "DASHBOARD",
          roles: ["SUPER_ADMIN"],
          scopeType: "GLOBAL",
          cityId: null,
          storeId: null,
        },
        {},
        "limit-test",
      ),
    ).rejects.toMatchObject({ publicCode: "EXPORT_RESULT_LIMIT_EXCEEDED" });
  }, 180_000);
});
