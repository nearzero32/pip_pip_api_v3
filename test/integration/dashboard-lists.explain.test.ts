import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  EVENT_LIST_WHERE_SQL,
  ASSIGNMENT_LIST_WHERE_SQL,
  COLLECTION_LIST_WHERE_SQL,
} from "../../src/modules/dashboard-lists/ops-list-query";
import { ORDER_LIST_WHERE_SQL } from "../../src/modules/dashboard-lists/order-list-query";
import {
  PRODUCT_LIST_WHERE_SQL,
} from "../../src/modules/dashboard-lists/product-list-query";
import { STORE_LIST_WHERE_SQL } from "../../src/modules/dashboard-lists/store-list-query";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

type Plan = { Plan?: Plan; "Node Type"?: string; "Index Name"?: string; Plans?: Plan[] };

const flatten = (plan: Plan, acc: Plan[] = []): Plan[] => {
  acc.push(plan);
  for (const child of plan.Plans ?? []) flatten(child, acc);
  return acc;
};

describe("dashboard list EXPLAIN plans", () => {
  let h: IntegrationHarness;
  let city = "";
  let storeId = "";
  let adminId = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_dash_explain",
      trackClient: true,
    });
    city = await createActiveCity(h.client, "ExplainCity");
    adminId = await createStaffAccount(h.auth, h.client, {
      email: "admin.explain@example.com",
      password: "fixed staff password",
      roles: ["ADMIN"],
      cityId: city,
    });
    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${city}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
      ) returning id`;
    const [main] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${city}, 'ExplainMain', ${media!.id}, 'ACTIVE', ${adminId}) returning id`;
    const [zone] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (${city}, 'ExplainZone', ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326), 'ACTIVE')
      returning id`;
    for (let i = 0; i < 180; i++) {
      const [storeLogo] = await h.client<{ id: string }[]>`
        insert into media_assets(
          city_id, purpose, visibility, status, object_key, original_name,
          expected_content_type, expected_size_bytes, verified_content_type,
          verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
        ) values (
          ${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
          'image/png', 1, 'image/png', 1, ${adminId}, now(), now(), now()
        ) returning id`;
      const [store] = await h.client<{ id: string }[]>`
        insert into stores(
          city_id, main_category_id, name, phone, address, location, logo_asset_id,
          status, order_acceptance_status, created_by_account_id
        ) values (
          ${city}, ${main!.id}, ${`Store ${i}`}, ${`+96470000${String(i).padStart(4, "0")}`}, 'Address',
          ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${storeLogo!.id},
          'ACTIVE', 'ACCEPTING', ${adminId}
        ) returning id`;
      if (i === 0) storeId = store!.id;
      await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store!.id}, ${zone!.id}, ${city})`;
    }
    for (let i = 0; i < 80; i++) {
      await h.client`
        insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
        values (${storeId}, ${city}, ${`Product ${i}`}, 1000, true, 'ACTIVE', ${adminId})`;
    }
    const [customer] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`insert into customer_profiles(account_id) values (${customer!.id})`;
    for (let i = 0; i < 120; i++) {
      const [order] = await h.client<{ id: string }[]>`
        insert into orders(
          order_number, city_id, zone_id, store_id, customer_account_id, status,
          payment_method, payment_status, products_subtotal, delivery_fee, total,
          currency, version, status_changed_at
        ) values (
          ${`EX-${String(i).padStart(4, "0")}`}, ${city}, ${zone!.id}, ${storeId},
          ${customer!.id}, 'PENDING_STORE_APPROVAL', 'CASH', 'UNPAID',
          1000, 1000, 2000, 'IQD', 1, now()
        ) returning id`;
      await h.client`
        insert into order_events(order_id, event_type, actor_type, source)
        values (${order!.id}, 'ORDER_CREATED', 'CUSTOMER', 'CUSTOMER_APP')`;
    }
    await createDriverAccount(h.client, "+9647705555001", "123456", "ACTIVE", city);
    for (let i = 0; i < 40; i++) {
      await createStaffAccount(h.auth, h.client, {
        email: `emp.explain.${i}@example.com`,
        password: "fixed staff password",
        roles: ["SUPPORT"],
        cityId: city,
        managedByAccountId: adminId,
      });
    }
  });

  afterAll(async () => {
    await h.close();
  });

  const explain = async (sql: string, params: unknown[]) => {
    const rows = (await h.client.unsafe(
      `explain (analyze, buffers, format json) ${sql}`,
      params,
    )) as Array<Record<string, unknown>>;
    const raw = rows[0]?.["QUERY PLAN"] ?? rows[0]?.query_plan ?? rows[0];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    const plan = (root as { Plan?: Plan }).Plan ?? (root as Plan);
    return flatten(plan);
  };

  test("city/status filters, LIMIT in PostgreSQL, count(*) not row fetch", async () => {
    const storePlan = await explain(
      `select s.id from stores s where ${STORE_LIST_WHERE_SQL} order by s.display_order asc, s.id asc limit $11::int offset $12::int`,
      [city, "ACTIVE", null, null, null, null, null, null, null, null, 25, 0],
    );
    expect(storePlan.some((n) => n["Node Type"] === "Limit")).toBe(true);
    expect(
      storePlan.some(
        (n) =>
          (n["Index Name"] ?? "").includes("stores_city") ||
          (n["Node Type"] ?? "").includes("Index"),
      ),
    ).toBe(true);

    const storeCount = await explain(
      `select count(*)::int from stores s where ${STORE_LIST_WHERE_SQL}`,
      [city, "ACTIVE", null, null, null, null, null, null, null, null],
    );
    expect(storeCount.some((n) => (n["Node Type"] ?? "").includes("Aggregate"))).toBe(true);

    const productPlan = await explain(
      `select p.id from products p where ${PRODUCT_LIST_WHERE_SQL} order by p.display_order asc, p.id asc limit $12::int offset $13::int`,
      [storeId, city, null, null, null, null, null, null, null, null, null, 25, 0],
    );
    expect(productPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const orderPlan = await explain(
      `select o.id from orders o where ${ORDER_LIST_WHERE_SQL} order by o.created_at desc, o.id desc limit $24::int offset $25::int`,
      [
        city, "PENDING_STORE_APPROVAL", null, null, null, null, null, null, null, null, null, null, null,
        null, null, null, null, null, null, null, null, null, null, 25, 0,
      ],
    );
    expect(orderPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);
    expect(
      orderPlan.some((n) => (n["Index Name"] ?? "").includes("orders_city")),
    ).toBe(true);

    const eventPlan = await explain(
      `select e.id from order_events e join orders o on o.id = e.order_id where ${EVENT_LIST_WHERE_SQL} order by e.created_at desc, e.id desc limit $10::int offset $11::int`,
      [city, null, null, null, null, null, null, null, null, 25, 0],
    );
    expect(eventPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const assignmentPlan = await explain(
      `select a.id from order_driver_assignments a join orders o on o.id = a.order_id where ${ASSIGNMENT_LIST_WHERE_SQL} limit $11::int offset $12::int`,
      [city, null, null, null, null, null, null, null, null, null, 25, 0],
    );
    expect(assignmentPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const collectionPlan = await explain(
      `select c.id from order_collections c join orders o on o.id = c.order_id where ${COLLECTION_LIST_WHERE_SQL} limit $16::int offset $17::int`,
      [city, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 25, 0],
    );
    expect(collectionPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const driverPlan = await explain(
      `select dp.account_id from driver_profiles dp join accounts a on a.id = dp.account_id where dp.city_id = $1::uuid and dp.operational_status = 'ACTIVE' limit 25 offset 0`,
      [city],
    );
    expect(driverPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const employeePlan = await explain(
      `select a.id from staff_profiles sp join accounts a on a.id = sp.account_id where sp.managed_by_account_id = $1::uuid limit 25 offset 0`,
      [adminId],
    );
    expect(employeePlan.some((n) => n["Node Type"] === "Limit")).toBe(true);

    const merchantPlan = await explain(
      `select m.account_id from merchant_profiles m where m.city_id = $1::uuid limit 25 offset 0`,
      [city],
    );
    expect(merchantPlan.some((n) => n["Node Type"] === "Limit")).toBe(true);
  });

  test("list HTTP uses a bounded number of SQL statements (no N+1)", async () => {
    const token = (
      await h.auth.dashboard.login({
        email: "admin.explain@example.com",
        password: "fixed staff password",
        deviceName: "e",
        ip: "127.0.0.1",
        requestId: "e",
      })
    ).access_token;
    const tracked = (h as IntegrationHarness & { trackedQueries?: string[] }).trackedQueries;
    const before = tracked?.length ?? 0;
    const res = await h.app.handle(jsonRequest("/api/v1/dashboard/stores", { token }));
    expect(res.status).toBe(200);
    const after = tracked?.length ?? 0;
    expect(after - before).toBeLessThan(12);
    const slice = (tracked ?? []).slice(before);
    expect(slice.some((sql) => /limit/i.test(sql))).toBe(true);
    expect(slice.some((sql) => /count\(\*\)/i.test(sql))).toBe(true);
  });
});
