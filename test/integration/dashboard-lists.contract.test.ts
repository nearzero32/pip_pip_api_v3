import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DASHBOARD_LIST_COUNT,
  DASHBOARD_LIST_ENDPOINTS,
  DASHBOARD_LIST_GAPS,
  type DashboardListEndpoint,
} from "../../src/modules/dashboard-lists/inventory";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

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
  let cityB = "";
  let storeId = "";
  let orderId = "";
  let adminAccountId = "";

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
    cityA = await createActiveCity(h.client, "ZXQ-CITY-HIT");
    cityB = await createActiveCity(h.client, "Other City");
    await createStaffAccount(h.auth, h.client, {
      email: "super.lists@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(h.auth, h.client, {
      email: "admin.lists@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(h.auth, h.client, {
      email: "adminb.lists@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    await createStaffAccount(h.auth, h.client, {
      email: "ops.lists@example.com",
      password,
      roles: ["OPERATIONS"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    await createStaffAccount(h.auth, h.client, {
      email: "noperm.lists@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    const login = (email: string, requestId: string) =>
      h.auth.dashboard.login({
        email,
        password,
        deviceName: requestId,
        ip: "127.0.0.1",
        requestId,
      });
    superToken = (await login("super.lists@example.com", "s")).access_token;
    adminToken = (await login("admin.lists@example.com", "a")).access_token;
    adminBToken = (await login("adminb.lists@example.com", "b")).access_token;
    employeeToken = (await login("noperm.lists@example.com", "e")).access_token;

    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityA}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [logo] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityA}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [main] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityA}, 'ZXQ-MAIN-HIT', ${media!.id}, 'ACTIVE', ${adminAccountId}) returning id`;
    await h.client`
      insert into subcategories(city_id, main_category_id, name, status, created_by_account_id)
      values (${cityA}, ${main!.id}, 'ZXQ-SUB-HIT', 'ACTIVE', ${adminAccountId})`;
    const [zone] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${cityA}, 'ZXQ-ZONE-HIT',
        ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
        'ACTIVE'
      ) returning id`;
    const [store] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id, platform_commission_rate
      ) values (
        ${cityA}, ${main!.id}, 'ZXQ-STORE-HIT', '+9647001111222', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id},
        'ACTIVE', 'ACCEPTING', ${adminAccountId}, 12
      ) returning id`;
    storeId = store!.id;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${storeId}, ${zone!.id}, ${cityA})`;
    await h.client`
      insert into store_commission_rate_history(
        store_id, city_id, previous_rate, new_rate, reason, changed_by_account_id
      ) values (${storeId}, ${cityA}, 0, 12, 'ZXQ-HIST-HIT', ${adminAccountId})`;
    const [scat] = await h.client<{ id: string }[]>`
      insert into store_categories(store_id, city_id, name, status, created_by_account_id)
      values (${storeId}, ${cityA}, 'ZXQ-SCAT-HIT', 'ACTIVE', ${adminAccountId}) returning id`;
    await h.client`
      insert into products(store_id, city_id, category_id, name, base_price, is_available, status, created_by_account_id)
      values (${storeId}, ${cityA}, ${scat!.id}, 'ZXQ-PROD-HIT', 1000, true, 'ACTIVE', ${adminAccountId})`;
    await h.client`
      insert into modifier_groups(store_id, city_id, name, min_select, max_select, status, created_by_account_id)
      values (${storeId}, ${cityA}, 'ZXQ-MOD-HIT', 0, 1, 'ACTIVE', ${adminAccountId})`;

    const [merchant] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`insert into account_phones(account_id, phone_e164, verified_at, is_primary)
      values (${merchant!.id}, '+9647701999888', now(), true)`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${merchant!.id}, ${storeId}, ${cityA}, 'ZXQ-MERCH-HIT', 'ACTIVE', ${adminAccountId})`;

    const driverId = await createDriverAccount(
      h.client,
      "+9647701234001",
      "123456",
      "ACTIVE",
      cityA,
    );
    const driverB = await createDriverAccount(
      h.client,
      "+9647701234002",
      "123456",
      "ACTIVE",
      cityA,
    );
    const [customer] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`insert into customer_profiles(account_id) values (${customer!.id})`;

    const [order] = await h.client<{ id: string }[]>`
      insert into orders(
        order_number, city_id, zone_id, store_id, customer_account_id, status,
        payment_method, payment_status, products_subtotal, delivery_fee, total,
        currency, version, status_changed_at
      ) values (
        'ZXQ-ORD-HIT', ${cityA}, ${zone!.id}, ${storeId},
        ${customer!.id}, 'PENDING_STORE_APPROVAL', 'CASH', 'UNPAID',
        1000, 1000, 2000, 'IQD', 1, now()
      ) returning id`;
    orderId = order!.id;
    await h.client`
      insert into order_events(order_id, event_type, actor_type, source)
      values (${orderId}, 'ORDER_CREATED', 'CUSTOMER', 'CUSTOMER_APP')`;

    const [round] = await h.client<{ id: string }[]>`
      insert into order_offer_rounds(
        order_id, city_id, status, pricing_base_snapshot, rounding_unit_snapshot,
        pricing_stages_snapshot, pricing_version_snapshot, created_by_account_id
      ) values (
        ${orderId}, ${cityA}, 'OPEN', 3000, 250,
        ${[{ afterSeconds: 0, increasePercentage: 0 }]},
        1, ${adminAccountId}
      ) returning id`;
    const [asg] = await h.client<{ id: string }[]>`
      insert into order_driver_assignments(
        order_id, driver_id, city_id, offer_round_id, assignment_source,
        assignment_sequence, assigned_by_account_id, driver_fee, status,
        pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
        pricing_version_snapshot, pricing_stage_after_seconds, pricing_stage_increase_percentage
      ) values (
        ${orderId}, ${driverId}, ${cityA}, ${round!.id}, 'DASHBOARD_MANUAL',
        1, ${adminAccountId}, 3000, 'ASSIGNED',
        3000, 250, ${[{ afterSeconds: 0, increasePercentage: 0 }]},
        1, 0, 0
      ) returning id`;
    const [asg2] = await h.client<{ id: string }[]>`
      insert into order_driver_assignments(
        order_id, driver_id, city_id, assignment_source, assignment_sequence,
        assigned_by_account_id, driver_fee, status, cancelled_at,
        pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
        pricing_version_snapshot, pricing_stage_after_seconds, pricing_stage_increase_percentage
      ) values (
        ${orderId}, ${driverB}, ${cityA}, 'DASHBOARD_MANUAL', 2,
        ${adminAccountId}, 3000, 'ASSIGNED', now(),
        3000, 250, ${[{ afterSeconds: 0, increasePercentage: 0 }]},
        1, 0, 0
      ) returning id`;
    await h.client`
      insert into order_driver_handoffs(
        order_id, city_id, from_assignment_id, to_assignment_id,
        from_driver_id, to_driver_id, status, reason, started_by_account_id
      ) values (
        ${orderId}, ${cityA}, ${asg!.id}, ${asg2!.id},
        ${driverId}, ${driverB}, 'PENDING', 'handoff', ${adminAccountId}
      )`;
    await h.client`
      insert into order_return_workflows(
        order_id, city_id, assignment_id, driver_id, status, reason, started_by_account_id
      ) values (
        ${orderId}, ${cityA}, ${asg!.id}, ${driverId},
        'WAITING_FOR_DRIVER_RETURN', 'return', ${adminAccountId}
      )`;
    const [collEvent] = await h.client<{ id: string }[]>`
      insert into order_events(order_id, assignment_id, event_type, actor_type, source)
      values (${orderId}, ${asg!.id}, 'ORDER_DELIVERED', 'DRIVER', 'DRIVER_APP') returning id`;
    await h.client`
      insert into order_collections(
        order_id, assignment_id, collecting_driver_id, expected_amount, collected_amount,
        difference_amount, confirmed_by_account_id, confirmation_source, order_event_id, collected_at
      ) values (
        ${orderId}, ${asg!.id}, ${driverId}, 2000, 2000, 0,
        ${adminAccountId}, 'DRIVER_APP', ${collEvent!.id}, now()
      )`;

    await h.client`
      insert into city_delivery_pricing_versions(
        city_id, version, base_fee, included_distance_meters, price_per_km, rounding_step,
        maximum_delivery_distance_meters, routing_fallback_enabled, fallback_on_no_route,
        fallback_on_provider_failure, fallback_extra_distance_meters, created_by_account_id, status
      ) values (
        ${cityA}, 1, 1000, 1000, 500, 250, 20000, false, false, false, 0, ${adminAccountId}, 'DRAFT'
      )`;
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
