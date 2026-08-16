import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DASHBOARD_LIST_COUNT,
  DASHBOARD_LIST_ENDPOINTS,
  DASHBOARD_LIST_GAPS,
  type DashboardListEndpoint,
} from "../../src/modules/dashboard-lists/inventory";
import {
  createIntegrationHarness,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";
import { seedDashboardListWorld } from "./dashboard-list-fixture";

const password = "fixed staff password";

type Page = {
  data: Array<Record<string, unknown>>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
};

describe("dashboard list closure inventory", () => {
  let h: IntegrationHarness;
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeToken = "";
  let cityA = "";
  let storeId = "";
  let orderId = "";

  const ctx = () => ({ storeId, orderId, cityId: cityA });

  const resolve = (template: string) =>
    template
      .replaceAll(":storeId", storeId)
      .replaceAll(":orderId", orderId)
      .replaceAll(":cityId", cityA);

  const tokenOf = (ep: DashboardListEndpoint) =>
    ep.actor === "super" ? superToken : adminToken;

  const getJson = async (path: string, token: string) => {
    const res = await h.app.handle(jsonRequest(path, { token }));
    return { status: res.status, body: (await res.json()) as unknown };
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_close" });
    const world = await seedDashboardListWorld(h, password);
    cityA = world.cityA;
    storeId = world.storeId;
    orderId = world.orderId;
    superToken = world.superToken;
    adminToken = world.adminToken;
    adminBToken = world.adminBToken;
    employeeToken = world.employeeToken;
  });

  afterAll(async () => {
    await h.close();
  });

  test("inventory contains exactly 24 LIST endpoints", () => {
    expect(DASHBOARD_LIST_COUNT).toBe(24);
    expect(DASHBOARD_LIST_ENDPOINTS).toHaveLength(24);
    expect(DASHBOARD_LIST_GAPS.assignmentCandidates.length).toBeGreaterThan(20);
    expect(DASHBOARD_LIST_GAPS.orderReturns.length).toBeGreaterThan(20);
  });

  test("parameterized 24/24 list contract", async () => {
    expect(ctx().storeId).toBeTruthy();
    for (const ep of DASHBOARD_LIST_ENDPOINTS) {
      const path = resolve(ep.pathTemplate);
      const token = tokenOf(ep);
      const ok = await getJson(path, token);
      expect(ok.status, `${ep.id} default`).toBe(200);
      const page = ok.body as Page;
      expect(Array.isArray(page.data), `${ep.id} data`).toBe(true);
      expect(page.pagination.page, `${ep.id} page`).toBe(1);
      expect(page.pagination.limit, `${ep.id} limit`).toBe(25);
      expect(page.pagination.totalPages).toBe(
        page.pagination.total === 0 ? 0 : Math.ceil(page.pagination.total / 25),
      );
      expect((ok.body as { page?: number }).page, `${ep.id} flat page`).toBeUndefined();
      const ids = page.data.map((row) => String(row[ep.idField] ?? ""));
      expect(new Set(ids).size, `${ep.id} duplicates`).toBe(ids.length);

      const far = await getJson(`${path}${qs({ page: 9999 })}`, token);
      expect(far.status, `${ep.id} far page`).toBe(200);
      expect((far.body as Page).data).toEqual([]);

      for (const bad of ["page=0", "limit=0", "limit=101"]) {
        const res = await getJson(`${path}?${bad}`, token);
        expect(res.status, `${ep.id} ${bad}`).toBe(422);
      }

      const hit = await getJson(`${path}${qs({ search: ep.searchHit })}`, token);
      expect(hit.status, `${ep.id} search`).toBe(200);
      expect((hit.body as Page).pagination.total, `${ep.id} search hit`).toBeGreaterThan(0);

      const miss = await getJson(`${path}${qs({ search: "NO-SUCH-TERM-ZZZ" })}`, token);
      expect(miss.status).toBe(200);
      expect((miss.body as Page).pagination.total, `${ep.id} search miss`).toBe(0);

      const percent = await getJson(`${path}${qs({ search: "%" })}`, token);
      expect(percent.status, `${ep.id} wildcard percent`).toBe(200);
      expect((percent.body as Page).pagination.total, `${ep.id} percent is literal`).toBe(0);
      const backslash = await getJson(`${path}${qs({ search: "\\\\" })}`, token);
      expect(backslash.status).toBe(200);
      expect((backslash.body as Page).pagination.total, `${ep.id} backslash is literal`).toBe(0);

      const sortOk = await getJson(
        `${path}${qs({ sortBy: ep.sortAllowlist[0], sortOrder: "asc" })}`,
        token,
      );
      expect(sortOk.status, `${ep.id} sort allowlist`).toBe(200);
      const sortBad = await getJson(`${path}${qs({ sortBy: "password" })}`, token);
      expect(sortBad.status, `${ep.id} invalid sort`).toBe(422);

      const reverseField = ep.sortAllowlist.find((f) => f === "createdAt") ?? ep.sortAllowlist[0]!;
      const asc = await getJson(
        `${path}${qs({ sortBy: reverseField, sortOrder: "asc", limit: 25 })}`,
        token,
      );
      const desc = await getJson(
        `${path}${qs({ sortBy: reverseField, sortOrder: "desc", limit: 25 })}`,
        token,
      );
      expect(asc.status).toBe(200);
      expect(desc.status).toBe(200);
      const ascIds = (asc.body as Page).data.map((row) => String(row[ep.idField]));
      const descIds = (desc.body as Page).data.map((row) => String(row[ep.idField]));
      if (ascIds.length >= 2) {
        expect(ascIds, `${ep.id} asc/desc`).not.toEqual(descIds);
      }
      const again = await getJson(
        `${path}${qs({ sortBy: reverseField, sortOrder: "asc", limit: 25 })}`,
        token,
      );
      expect((again.body as Page).data.map((row) => String(row[ep.idField]))).toEqual(ascIds);

      const andKeys = Object.keys(ep.andFilters);
      if (andKeys.length >= 1) {
        const filtered = await getJson(`${path}${qs(ep.andFilters)}`, token);
        expect(filtered.status, `${ep.id} resource filter`).toBe(200);
        expect((filtered.body as Page).pagination.total, `${ep.id} AND/filter`).toBeGreaterThan(0);
      }

      const denied = await getJson(path, employeeToken);
      expect(denied.status, `${ep.id} permission`).toBe(403);

      if (ep.scope === "CITY") {
        const superDenied = await getJson(path, superToken);
        expect(superDenied.status, `${ep.id} super blocked`).toBe(403);
        const otherCity = await getJson(`${path}${qs({ search: ep.searchHit })}`, adminBToken);
        expect([200, 404], `${ep.id} other city status`).toContain(otherCity.status);
        if (otherCity.status === 200) {
          const otherIds = (otherCity.body as Page).data.map((row) => String(row[ep.idField] ?? ""));
          expect(otherIds.some((id) => ids.includes(id) && id.length > 0), `${ep.id} city leak`).toBe(
            false,
          );
        }
      } else {
        expect(denied.status, `${ep.id} city employee global`).toBe(403);
      }
    }
  }, 180_000);
});
